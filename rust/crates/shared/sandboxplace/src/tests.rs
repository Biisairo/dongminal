use std::sync::Mutex;

use dm_shared_sandbox::RunOutput;

use super::*;

/// 가짜 docker: inspect 는 "없음", 나머지는 성공(fail 이면 전부 실패)이다.
#[derive(Default)]
struct FakeDocker {
    calls: Mutex<Vec<Vec<String>>>,
    fail: bool,
}

impl FakeDocker {
    fn joined(&self, sub: &str) -> String {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .find(|c| c.first().is_some_and(|a| a == sub))
            .map(|c| c.join(" "))
            .unwrap_or_default()
    }
    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

fn mgr(f: &Arc<FakeDocker>, home: &str) -> Manager {
    let f = Arc::clone(f);
    Manager::new(
        Arc::new(move |args: &[String]| {
            f.calls.lock().unwrap().push(args.to_vec());
            if f.fail {
                return RunOutput::fail("boom", "exit status 1");
            }
            if args[0] == "inspect" {
                return RunOutput::fail("Error: No such object", "exit status 1");
            }
            RunOutput::default()
        }),
        home,
    )
}

fn helper(present: bool, err: Option<&'static str>) -> HelperDeps {
    let fail = move |_: &str, _: &str| err.map_or(Ok(()), |e| Err(e.to_string()));
    HelperDeps {
        version: "v1.0.0".into(),
        arch: "arm64".into(),
        home: "/h".into(),
        stat: Arc::new(move |_| present),
        fetch: Arc::new(fail),
        cross_build: Arc::new(fail),
        list_cache: None,
        remove: None,
    }
}

fn dev_profiles() -> HashMap<String, Profile> {
    HashMap::from([
        (sandbox::PROFILE_SCRATCH.to_string(), sandbox::scratch()),
        (
            sandbox::PROFILE_DEV.to_string(),
            Profile {
                name: sandbox::PROFILE_DEV.into(),
                image: "node:22".into(),
                network: "bridge".into(),
                ports: vec!["3000".into()],
                work: WorkKind::Mount,
                helper: true,
                ..Default::default()
            },
        ),
    ])
}

fn placer_at(
    f: &Arc<FakeDocker>,
    profiles: HashMap<String, Profile>,
    h: HelperDeps,
    home: &str,
) -> Placer {
    let mut p = Placer::new(mgr(f, home), "/usr/bin/docker", profiles, h, "58146", home);
    p.set_stat(Arc::new(|_| true));
    p
}

fn placer(
    f: &Arc<FakeDocker>,
    profiles: HashMap<String, Profile>,
    h: HelperDeps,
) -> (Placer, tempfile::TempDir) {
    let d = tempfile::tempdir().unwrap();
    let p = placer_at(f, profiles, h, d.path().to_str().unwrap());
    (p, d)
}

fn pl(window: &str, profile: &str, host: &str, work: &str) -> Placement {
    Placement {
        window_uuid: window.into(),
        profile: profile.into(),
        tool_id: "t1".into(),
        host_dir: host.into(),
        work: work.into(),
        ..Default::default()
    }
}

#[test]
fn scratch_yields_container_spec_without_helper() {
    let f = Arc::new(FakeDocker::default());
    let (p, _d) = placer(&f, dev_profiles(), helper(true, None));
    let spec = p.place(&pl("w1", "scratch", "", "")).unwrap();
    let got = spec.args.join(" ");
    assert!(
        got.contains("exec -it") && got.contains("dongminal-sbx-w1"),
        "{got}"
    );
    assert!(!got.contains("DONGMINAL_TOOL_ID"));
}

#[test]
fn dev_mounts_helper_addr_and_carries_env() {
    let f = Arc::new(FakeDocker::default());
    let (p, d) = placer(&f, dev_profiles(), helper(true, None));
    let spec = p.place(&pl("w1", "dev", "/Users/me/app", "")).unwrap();
    let run = f.joined("run");
    let addr_dir = dm_shared_serverconf::addr_path(d.path())
        .parent()
        .unwrap()
        .to_path_buf();
    for want in [
        "-v /Users/me/app:/work".to_string(),
        format!(
            "-v {}:/usr/local/bin/dmctl:ro",
            sandbox::helper_cache_path("/h", "v1.0.0", "arm64")
        ),
        format!("-v {}:/run/dongminal:ro", addr_dir.display()),
        "-p 3000:3000".to_string(),
    ] {
        assert!(run.contains(&want), "{want}: {run}");
    }
    assert!(addr_dir.is_dir());
    let got = spec.args.join(" ");
    assert!(
        got.contains("DONGMINAL_PORT=58146") && got.contains("DONGMINAL_TOOL_ID=t1"),
        "{got}"
    );

    let f = Arc::new(FakeDocker::default());
    let p = placer_at(
        &f,
        dev_profiles(),
        helper(true, None),
        d.path().to_str().unwrap(),
    );
    p.place(&pl("w2", "scratch", "", "")).unwrap();
    assert!(!f.joined("run").contains("/run/dongminal"));
}

#[test]
fn failures_stop_startup() {
    let f = Arc::new(FakeDocker::default());
    let only = HashMap::from([(sandbox::PROFILE_SCRATCH.to_string(), sandbox::scratch())]);
    let (p, _d) = placer(&f, only, helper(true, None));
    assert_eq!(
        p.place(&pl("w1", "dev", "", "")).unwrap_err().to_string(),
        "샌드박스 프로파일 \"dev\" 가 정의되지 않았습니다 — sandbox.json 에 이미지를 적어 주세요"
    );

    let (p, _d) = placer(&f, dev_profiles(), helper(false, Some("네트워크 없음")));
    assert!(
        p.place(&pl("w1", "dev", "/a", ""))
            .unwrap_err()
            .to_string()
            .contains("네트워크 없음")
    );

    let ff = Arc::new(FakeDocker {
        fail: true,
        ..Default::default()
    });
    let (p, _d) = placer(&ff, dev_profiles(), helper(true, None));
    assert!(p.place(&pl("w1", "scratch", "", "")).is_err());

    let mut profiles = dev_profiles();
    profiles.get_mut("dev").unwrap().base_mounts = vec![sandbox::Mount {
        host: "/no/such/dir".into(),
        container: "/x".into(),
        ..Default::default()
    }];
    let (mut p, _d) = placer(&f, profiles, helper(true, None));
    p.set_stat(Arc::new(|_| false));
    assert!(
        p.place(&pl("w1", "dev", "/a", ""))
            .unwrap_err()
            .to_string()
            .contains("/no/such/dir")
    );

    let (mut p, _d) = placer(&f, dev_profiles(), helper(true, None));
    p.set_stat(Arc::new(|path| path != "/no/such/work"));
    assert_eq!(
        p.place(&pl("w1", "dev", "/no/such/work", ""))
            .unwrap_err()
            .to_string(),
        "작업 폴더가 없습니다: /no/such/work"
    );

    let fn_err = Arc::new(placer(&f, HashMap::new(), helper(true, None)).0).placer_fn()(&pl(
        "w", "dev", "", "",
    ));
    assert_eq!(
        fn_err.unwrap_err().to_string(),
        "샌드박스 프로파일 \"dev\" 가 정의되지 않았습니다 — sandbox.json 에 이미지를 적어 주세요"
    );
}

#[test]
fn empty_workdir_mounts_nothing_and_work_override() {
    let f = Arc::new(FakeDocker::default());
    let (p, _d) = placer(&f, dev_profiles(), helper(true, None));
    p.place(&pl("w1", "dev", "", "")).unwrap();
    assert!(!f.joined("run").contains(":/work"));

    let f = Arc::new(FakeDocker::default());
    let (p, _d) = placer(&f, dev_profiles(), helper(true, None));
    p.place(&pl("w1", "scratch", "/Users/me/app", "mount"))
        .unwrap();
    assert!(f.joined("run").contains("-v /Users/me/app:/work"));

    let f = Arc::new(FakeDocker::default());
    let (p, d) = placer(&f, dev_profiles(), helper(true, None));
    p.place(&pl("w1", "dev", d.path().to_str().unwrap(), "copy"))
        .unwrap();
    assert!(!f.joined("run").contains(":/work"));
    assert!(f.joined("cp").ends_with("dongminal-sbx-w1:/work"));

    let f = Arc::new(FakeDocker::default());
    let (p, _d) = placer(&f, dev_profiles(), helper(true, None));
    p.place(&pl("w1", "dev", "/Users/me/app", "mont")).unwrap();
    assert!(f.joined("run").contains("-v /Users/me/app:/work"));
}

#[test]
fn reap_rules() {
    let f = Arc::new(FakeDocker::default());
    let p = placer_at(&f, dev_profiles(), helper(true, None), "/h");
    p.reap(None);
    assert_eq!(f.count(), 0);
    p.reap(Some(&["w-live".to_string()]));
    assert!(f.joined("ps").contains("label=dongminal.home=/h"));
}

#[test]
fn save_config_validates_and_takes_effect() {
    let f = Arc::new(FakeDocker::default());
    let only = HashMap::from([(sandbox::PROFILE_SCRATCH.to_string(), sandbox::scratch())]);
    let (p, d) = placer(&f, only, helper(true, None));
    assert!(p.save_config(br#"{"dev":{}}"#).is_err());
    assert!(p.config().unwrap().dev.is_none());
    assert!(!d.path().join("sandbox.json").exists());
    assert_eq!(p.profiles().len(), 1);
    p.save_config(br#"{"dev":{"image":"node:22"}}"#).unwrap();
    assert_eq!(
        p.profiles()
            .iter()
            .map(|i| i.name.as_str())
            .collect::<Vec<_>>(),
        ["scratch", "dev"]
    );
    assert_eq!(p.config().unwrap().dev.unwrap().image, "node:22");
    assert_eq!(
        std::fs::read_to_string(d.path().join("sandbox.json")).unwrap(),
        "{\n  \"dev\": {\n    \"image\": \"node:22\"\n  }\n}"
    );
}

#[test]
fn startup_port_order() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().to_str().unwrap();
    assert_eq!(startup_port(home, ""), dm_shared_dmenv::DEFAULT_PORT);
    dm_shared_serverconf::set_bind(d.path(), "", "9600").unwrap();
    assert_eq!(startup_port(home, ""), "9600");
    dm_shared_serverconf::write_addr(d.path(), "127.0.0.1:9601").unwrap();
    assert_eq!(startup_port(home, ""), "9601");
    assert_eq!(startup_port(home, "9602"), "9602");
}
