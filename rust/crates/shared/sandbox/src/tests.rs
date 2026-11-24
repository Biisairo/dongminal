use std::collections::HashSet;
use std::sync::Mutex;

use super::*;

type Reply = Box<dyn Fn(&[String]) -> RunOutput + Send + Sync>;

/// 가짜 docker CLI 다. 부른 인자를 적고 reply 로 답한다.
#[derive(Default)]
struct FakeDocker {
    calls: Mutex<Vec<Vec<String>>>,
    reply: Option<Reply>,
}

impl FakeDocker {
    fn with(reply: impl Fn(&[String]) -> RunOutput + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::default(),
            reply: Some(Box::new(reply)),
        })
    }
    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
    fn saw(&self, sub: &str) -> bool {
        self.calls()
            .iter()
            .any(|c| c.first().is_some_and(|a| a == sub))
    }
    fn call(&self, sub: &str) -> String {
        self.calls()
            .into_iter()
            .find(|c| c.first().is_some_and(|a| a == sub))
            .unwrap_or_default()
            .join(" ")
    }
}

fn mgr(f: &Arc<FakeDocker>) -> Manager {
    let f = Arc::clone(f);
    Manager::new(
        Arc::new(move |args: &[String]| {
            f.calls.lock().unwrap().push(args.to_vec());
            f.reply
                .as_ref()
                .map_or_else(RunOutput::default, |r| r(args))
        }),
        "/home/u/.otterminal",
    )
}

fn state_reply(state: &'static str) -> Arc<FakeDocker> {
    FakeDocker::with(move |args| {
        if args[0] == "inspect" {
            if state.is_empty() {
                return RunOutput::fail("", "No such object");
            }
            return RunOutput::ok(format!("{state}\n"));
        }
        RunOutput::default()
    })
}

fn dev_profile() -> Profile {
    Profile {
        name: PROFILE_DEV.into(),
        image: "node:22".into(),
        network: "bridge".into(),
        ports: vec!["3000".into(), "5173-5180".into()],
        work: WorkKind::Mount,
        helper: true,
        ..Default::default()
    }
}

fn rs(host: &str) -> RunSpec {
    RunSpec {
        host_dir: host.into(),
        ..Default::default()
    }
}

#[test]
fn container_name_is_window_scoped() {
    assert_eq!(
        mgr(&Arc::default()).container_name("w-123"),
        "otterminal-sbx-w-123"
    );
}

#[test]
fn ensure_creates_when_absent() {
    let f = state_reply("");
    mgr(&f)
        .ensure("w1", &scratch(), &RunSpec::default())
        .unwrap();
    let got = f.call("run");
    for want in [
        "-d",
        "--init",
        "--name otterminal-sbx-w1",
        "--label otterminal.window=w1",
        "--label otterminal.home=/home/u/.otterminal",
        "--network none",
        "debian:stable-slim",
        "--pids-limit 512",
    ] {
        assert!(got.contains(want), "{want}: {got}");
    }
    assert!(!f.calls().iter().flatten().any(|a| a == "--rm"));
    assert!(got.ends_with("debian:stable-slim sleep infinity"));
}

#[test]
fn ensure_reuses_running_and_starts_stopped() {
    let f = state_reply("running");
    mgr(&f)
        .ensure("w1", &scratch(), &RunSpec::default())
        .unwrap();
    assert!(!f.saw("run") && !f.saw("start"));
    let f = state_reply("exited");
    mgr(&f)
        .ensure("w1", &scratch(), &RunSpec::default())
        .unwrap();
    assert!(f.saw("start") && !f.saw("run"));
}

#[test]
fn ensure_failures() {
    let f = FakeDocker::with(|a| {
        if a[0] == "inspect" {
            RunOutput::fail("", "No such object")
        } else {
            RunOutput::fail("", "Unable to find image")
        }
    });
    let e = mgr(&f)
        .ensure("w1", &scratch(), &RunSpec::default())
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "샌드박스 컨테이너를 만들지 못했습니다(이미지 debian:stable-slim): Unable to find image: "
    );

    let f = FakeDocker::with(|_| {
        RunOutput::fail(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
            "exit status 1",
        )
    });
    let e = mgr(&f)
        .ensure("w1", &scratch(), &RunSpec::default())
        .unwrap_err();
    assert!(!f.saw("run"));
    assert_eq!(
        e.to_string(),
        "컨테이너 런타임에 연결할 수 없습니다(실행 중인지 확인하세요): Cannot connect to the Docker daemon at unix:///var/run/docker.sock."
    );

    let f = FakeDocker::with(|a| {
        if a[0] == "inspect" {
            RunOutput::ok("exited")
        } else {
            RunOutput::fail(" boom \n", "exit status 1")
        }
    });
    let e = mgr(&f)
        .ensure("w1", &scratch(), &RunSpec::default())
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "샌드박스 컨테이너를 시작하지 못했습니다: exit status 1: boom"
    );

    let mut p = scratch();
    p.image.clear();
    let e = mgr(&state_reply(""))
        .ensure("w1", &p, &RunSpec::default())
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "샌드박스 프로파일 \"scratch\" 에 이미지가 지정되지 않았습니다"
    );
}

#[test]
fn ensure_no_such_object_creates_and_name_conflict_is_ok() {
    let f = FakeDocker::with(|a| {
        if a[0] == "inspect" {
            RunOutput::fail("Error: No such object: otterminal-sbx-w1", "exit status 1")
        } else {
            RunOutput::default()
        }
    });
    mgr(&f)
        .ensure("w1", &scratch(), &RunSpec::default())
        .unwrap();
    assert!(f.saw("run"));
    let f = FakeDocker::with(|a| {
        if a[0] == "inspect" {
            return RunOutput::fail("Error: No such object", "exit status 1");
        }
        RunOutput::fail(
            "docker: Error response from daemon: Conflict. The container name \"/otterminal-sbx-w1\" is already in use by container \"33b22c8d8073\".",
            "exit status 125",
        )
    });
    mgr(&f)
        .ensure("w1", &scratch(), &RunSpec::default())
        .unwrap();
}

#[test]
fn ensure_dev_mounts_ports_helper_and_limits() {
    let f = state_reply("");
    let r = RunSpec {
        host_dir: "/Users/me/app".into(),
        helper_path: "/h/cache/otterctl-dev-linux-arm64".into(),
        addr_dir: "/h/run".into(),
    };
    mgr(&f).ensure("w1", &dev_profile(), &r).unwrap();
    let got = f.call("run");
    for want in [
        "-v /Users/me/app:/work",
        "-p 3000:3000",
        "-p 5173-5180:5173-5180",
        "--network bridge",
        "-v /h/cache/otterctl-dev-linux-arm64:/usr/local/bin/otterctl:ro",
        "-v /h/run:/run/otterminal:ro",
        "--add-host host.docker.internal:host-gateway",
        "--cpus 2",
        "--memory 2g",
        "--pids-limit 512",
    ] {
        assert!(got.contains(want), "{want}: {got}");
    }
    let f = state_reply("");
    mgr(&f)
        .ensure("w1", &dev_profile(), &RunSpec::default())
        .unwrap();
    assert!(!f.calls()[1].iter().any(|a| a == "-v"));
    let f = state_reply("");
    let r = RunSpec {
        host_dir: "/Users/me/app".into(),
        helper_path: "/h/otterctl".into(),
        ..Default::default()
    };
    mgr(&f).ensure("w1", &scratch(), &r).unwrap();
    let run = f.calls()[1].clone();
    assert!(!run.iter().any(|a| a == "-v" || a == "-p"), "{run:?}");
}

#[test]
fn copy_work_copies_into_container_and_cleans_up() {
    let f = state_reply("");
    mgr(&f)
        .ensure("w1", &scratch(), &rs("/Users/me/app/"))
        .unwrap();
    assert_eq!(f.call("cp"), "cp /Users/me/app/. otterminal-sbx-w1:/work");
    let f = FakeDocker::with(|a| match a[0].as_str() {
        "inspect" => RunOutput::fail("", "No such object"),
        "cp" => RunOutput::fail("no space\n", "exit status 1"),
        _ => RunOutput::default(),
    });
    let e = mgr(&f).ensure("w1", &scratch(), &rs("/a")).unwrap_err();
    assert_eq!(
        e.to_string(),
        "작업 폴더를 컨테이너에 복사하지 못했습니다(/a): exit status 1: no space"
    );
    assert_eq!(f.call("rm"), "rm -f otterminal-sbx-w1");
}

#[test]
fn exec_spec_shape() {
    let m = mgr(&Arc::default());
    let spec = m.exec_spec(
        "w1",
        "/usr/bin/docker",
        &scratch(),
        &RunSpec::default(),
        &ExecEnv::default(),
    );
    assert_eq!(spec.path, "/usr/bin/docker");
    assert_eq!(
        spec.args.join(" "),
        "/usr/bin/docker exec -it -e TERM=xterm-256color otterminal-sbx-w1 bash -l"
    );
    let env = ExecEnv {
        tool_id: "tool-9".into(),
        port: "58146".into(),
    };
    let spec = m.exec_spec("w1", "docker", &dev_profile(), &rs("/Users/me/app"), &env);
    assert_eq!(
        spec.args.join(" "),
        "docker exec -it -e TERM=xterm-256color -e OTTERMINAL_HOST=host.docker.internal -e OTTERMINAL_PORT=58146 -e OTTERMINAL_TOOL_ID=tool-9 -w /work otterminal-sbx-w1 bash -l"
    );
    let spec = m.exec_spec("w1", "docker", &scratch(), &RunSpec::default(), &env);
    assert!(!spec.args.join(" ").contains("OTTERMINAL_TOOL_ID"));
}

#[test]
fn remove_reap_and_stop() {
    let f = FakeDocker::with(|_| RunOutput::fail("", "No such container"));
    mgr(&f).remove("w1");
    assert_eq!(f.call("rm"), "rm -f otterminal-sbx-w1");

    let f = FakeDocker::with(|a| {
        if a[0] == "ps" {
            RunOutput::ok("otterminal-sbx-live w-live\notterminal-sbx-dead w-dead\n")
        } else {
            RunOutput::default()
        }
    });
    mgr(&f)
        .reap_orphans(&HashSet::from(["w-live".to_string()]))
        .unwrap();
    let removed: Vec<String> = f
        .calls()
        .into_iter()
        .filter(|c| c[0] == "rm")
        .map(|c| c.join(" "))
        .collect();
    assert_eq!(removed, ["rm -f otterminal-sbx-dead"]);
    assert_eq!(
        f.call("ps"),
        "ps -a --filter label=otterminal.home=/home/u/.otterminal --format {{.Names}} {{.Label \"otterminal.window\"}}"
    );

    let f = FakeDocker::with(|a| {
        if a[0] == "ps" {
            RunOutput::ok("otterminal-sbx-a\notterminal-sbx-b\n")
        } else {
            RunOutput::default()
        }
    });
    mgr(&f).stop_owned().unwrap();
    assert!(!f.saw("rm"));
    let stopped: Vec<String> = f
        .calls()
        .into_iter()
        .filter(|c| c[0] == "stop")
        .map(|c| c[1].clone())
        .collect();
    assert_eq!(stopped, ["otterminal-sbx-a", "otterminal-sbx-b"]);
    assert!(
        f.call("ps")
            .contains("label=otterminal.home=/home/u/.otterminal")
    );

    let f = FakeDocker::with(|_| RunOutput::fail("", "exit status 1"));
    assert_eq!(
        mgr(&f).stop_owned().unwrap_err().to_string(),
        "샌드박스 컨테이너를 조회하지 못했습니다: exit status 1"
    );
    assert_eq!(
        mgr(&f)
            .reap_orphans(&HashSet::new())
            .unwrap_err()
            .to_string(),
        "샌드박스 컨테이너를 조회하지 못했습니다: exit status 1"
    );
}

#[test]
fn find_runtime() {
    let e = super::find_runtime(&|_| Err("not found".into())).unwrap_err();
    assert_eq!(
        e.to_string(),
        "컨테이너 런타임(docker)을 찾을 수 없습니다: not found"
    );
    assert_eq!(
        super::find_runtime(&|_| Ok("/usr/local/bin/docker".into())).unwrap(),
        "/usr/local/bin/docker"
    );
    assert_eq!(
        look_path("otterminal-no-such-binary").unwrap_err(),
        format!(
            "exec: \"otterminal-no-such-binary\": executable file not found in {}",
            if cfg!(windows) { "%PATH%" } else { "$PATH" }
        )
    );
}

// FR-RDF-11: 상대 PATH 항목에서만 찾은 docker 는 Go 처럼 ErrDot 문구다.
#[cfg(unix)]
#[test]
fn look_path_reports_err_dot() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let exe = d.path().join("otter-dot-docker");
    std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    let rel = otter_gocompat::filepath::rel(
        &std::env::current_dir().unwrap().to_string_lossy(),
        &d.path().to_string_lossy(),
    )
    .unwrap();
    assert_eq!(
        super::look_path_in("otter-dot-docker", &rel).unwrap_err(),
        r#"exec: "otter-dot-docker": cannot run executable found relative to current directory"#
    );
}

#[test]
fn save_failed_text() {
    assert_eq!(
        Error::SaveFailed.to_string(),
        "샌드박스 정의를 저장하지 못했습니다"
    );
}

fn home(h: &'static str) -> impl Fn() -> Option<String> {
    move || Some(h.to_string())
}

fn reader(blob: &'static str) -> impl Fn(&str) -> std::io::Result<Vec<u8>> {
    move |_| Ok(blob.as_bytes().to_vec())
}

#[test]
fn parse_mount_forms() {
    let h = home("/home/u");
    for (input, host, container, ro) in [
        ("/a:/b", "/a", "/b", false),
        ("/a:/b:ro", "/a", "/b", true),
        ("/a:/b:rw", "/a", "/b", false),
        ("C:\\src\\app:/work", "C:\\src\\app", "/work", false),
        ("C:\\src\\app:/work:ro", "C:\\src\\app", "/work", true),
    ] {
        let m = parse_mount(input, &h).unwrap();
        assert_eq!(
            (m.host.as_str(), m.container.as_str(), m.read_only),
            (host, container, ro),
            "{input}"
        );
    }
    let m = parse_mount("~/.ssh:/root/.ssh:ro", &h).unwrap();
    assert_eq!(m.host, otter_gocompat::filepath::join(&["/home/u", ".ssh"]));
    assert!(m.read_only);
    for bad in ["", "/onlyhost", "/a:relative", ":/b", "/a:"] {
        assert!(parse_mount(bad, &h).is_err(), "{bad:?}");
    }
    assert_eq!(
        parse_mount("/onlyhost", &h).unwrap_err().to_string(),
        "마운트 형식이 아닙니다(호스트경로:컨테이너경로[:ro]): \"/onlyhost\""
    );
    assert_eq!(
        parse_mount("/a:rel", &h).unwrap_err().to_string(),
        "컨테이너 경로는 \"/work\" 처럼 절대 경로여야 합니다: \"/a:rel\""
    );
    assert_eq!(
        parse_mount("~:/x", &|| None).unwrap_err().to_string(),
        "사용자 홈을 알 수 없어 \"~\" 를 펼 수 없습니다"
    );
}

#[test]
fn load_profiles_base_mounts_and_policy() {
    let blob = r#"{
      "mounts": [
        "~/.claude:/root/.claude",
        {"host":"~/.ssh","container":"/root/.ssh","readonly":true},
        {"host":"/shared","container":"/shared","scratch":true}
      ],
      "dev": {"image":"node:22","ports":[3000,"5173-5180"]}
    }"#;
    let got = load_profiles("x.json", &reader(blob), &home("/home/u")).unwrap();
    let dev = &got[PROFILE_DEV];
    assert_eq!(dev.base_mounts.len(), 3);
    assert_eq!(
        dev.base_mounts[0].host,
        otter_gocompat::filepath::join(&["/home/u", ".claude"])
    );
    assert!(dev.base_mounts[1].read_only);
    assert_eq!(dev.ports, ["3000", "5173-5180"]);
    assert_eq!(
        (dev.work, dev.network.as_str(), dev.helper),
        (WorkKind::Mount, "bridge", true)
    );
    assert_eq!(got[PROFILE_SCRATCH].base_mounts.len(), 1);
    assert_eq!(got[PROFILE_SCRATCH].base_mounts[0].container, "/shared");

    let got = load_profiles(
        "x.json",
        &reader(r#"{"mounts":["~/.ssh:/root/.ssh:ro"],"dev":{"image":"node:22"}}"#),
        &home("/h"),
    )
    .unwrap();
    assert!(got[PROFILE_SCRATCH].base_mounts.is_empty());

    let missing = |_: &str| Err(std::io::Error::from(std::io::ErrorKind::NotFound));
    let got = load_profiles("x.json", &missing, &home("/h")).unwrap();
    assert_eq!(got.len(), 1);
    assert!(got.contains_key(PROFILE_SCRATCH));
}

#[test]
fn load_profiles_errors() {
    let h = home("/h");
    let err = |b: &'static str| {
        load_profiles("x.json", &reader(b), &h)
            .unwrap_err()
            .to_string()
    };
    assert_eq!(
        err(r#"{"mounts":["nonsense"]}"#),
        "x.json: 마운트 형식이 아닙니다(호스트경로:컨테이너경로[:ro]): \"nonsense\""
    );
    assert!(err(r#"{"dev":{"ports":[3000]}}"#).contains("이미지"));
    assert!(
        err(r#"{"scratch":{"image":"alpine"}}"#)
            .starts_with("x.json: \"scratch\" 프로파일은 재정의할 수 없습니다")
    );
    assert_eq!(
        err(r#"{"nope":{"image":"alpine"}}"#),
        "x.json: 알 수 없는 샌드박스 프로파일입니다: \"nope\" (dev 만 정의할 수 있습니다)"
    );
    assert_eq!(
        err("{"),
        "x.json: 샌드박스 정의를 해석할 수 없습니다: unexpected end of JSON input"
    );
    assert_eq!(
        err("[]"),
        "x.json: 샌드박스 정의를 해석할 수 없습니다: json: cannot unmarshal array into Go value of type map[string]json.RawMessage"
    );
    assert_eq!(
        err(r#"{"dev":{"image":"i","ports":[1.5]}}"#),
        "x.json: \"dev\" 프로파일의 포트가 범위를 벗어났습니다: 1.5"
    );
    assert_eq!(
        err(r#"{"dev":{"image":"i","ports":[70000]}}"#),
        "x.json: \"dev\" 프로파일의 포트가 범위를 벗어났습니다: 70000"
    );
    assert_eq!(
        err(r#"{"dev":{"image":"i","ports":[""]}}"#),
        "x.json: \"dev\" 프로파일에 빈 포트가 있습니다"
    );
    assert_eq!(
        err(r#"{"dev":{"image":"i","ports":[true]}}"#),
        "x.json: \"dev\" 프로파일의 포트를 해석할 수 없습니다: true"
    );
    assert_eq!(
        err(r#"{"mounts":[{"host":"/a","container":""}]}"#),
        "x.json: 마운트에 host 와 container 가 모두 필요합니다: map[container: host:/a]"
    );
    assert_eq!(
        err(r#"{"mounts":[3]}"#),
        "x.json: 마운트 항목을 해석할 수 없습니다: 3"
    );
    let denied = |_: &str| Err(std::io::Error::from_raw_os_error(13));
    assert!(
        load_profiles("x.json", &denied, &h)
            .unwrap_err()
            .to_string()
            .starts_with("샌드박스 프로파일 정의를 읽을 수 없습니다(x.json): ")
    );
}

#[test]
fn parse_config_round_trip_and_encode_bytes() {
    let blob = br#"{
      "mounts":[{"host":"/home/u/a","container":"/x","readonly":true,"scratch":true}],
      "dev":{"image":"node:22","ports":[3000,"5173-5180"]}
    }"#;
    let h = home("/home/u");
    let cfg = parse_config(blob, &h).unwrap();
    assert!(cfg.mounts[0].read_only && cfg.mounts[0].scratch);
    let out = cfg.encode().unwrap();
    assert_eq!(
        String::from_utf8(out.clone()).unwrap(),
        "{\n  \"mounts\": [\n    {\n      \"host\": \"~/a\",\n      \"container\": \"/x\",\n      \"readonly\": true,\n      \"scratch\": true\n    }\n  ],\n  \"dev\": {\n    \"image\": \"node:22\",\n    \"ports\": [\n      \"3000\",\n      \"5173-5180\"\n    ]\n  }\n}"
    );
    let again = parse_config(&out, &h).unwrap();
    assert_eq!(
        again.mounts[0].host,
        otter_gocompat::filepath::join(&["/home/u", "a"])
    );
    let empty = parse_config(b"{}", &h).unwrap();
    assert!(empty.mounts.is_empty() && empty.dev.is_none());
    assert_eq!(empty.encode().unwrap(), b"{}");
    assert_eq!(parse_config(b"  \n", &h).unwrap().profiles().len(), 1);
    assert!(parse_config(br#"{"mounts":["nonsense"]}"#, &h).is_err());
}

#[test]
fn profile_info_grades() {
    assert!(scratch().info().isolated);
    let mut p = scratch();
    p.base_mounts = vec![Mount {
        host: "/s".into(),
        container: "/s".into(),
        read_only: true,
        scratch: false,
    }];
    assert!(!p.info().isolated);
    assert!(!dev_profile().info().isolated);
    assert!(
        !Profile {
            network: "bridge".into(),
            ..Default::default()
        }
        .info()
        .isolated
    );
    for w in [WorkKind::None, WorkKind::Copy, WorkKind::Mount] {
        assert!(
            Profile {
                network: "none".into(),
                work: w,
                ..Default::default()
            }
            .info()
            .isolated
        );
    }
    assert!(
        !Profile {
            network: "none".into(),
            helper: true,
            ..Default::default()
        }
        .info()
        .isolated
    );
    let want = vec![
        WorkPick {
            work: WorkKind::Mount,
            copies: false,
        },
        WorkPick {
            work: WorkKind::Copy,
            copies: true,
        },
    ];
    assert_eq!(work_picks_of(WorkKind::Mount), want);
    assert_eq!(work_picks_of(WorkKind::Copy), want);
    assert!(work_picks_of(WorkKind::None).is_empty() && work_picks_of(WorkKind::Unset).is_empty());
    assert_eq!(
        String::from_utf8(
            otter_gocompat::json::marshal(
                &Profile {
                    name: "x".into(),
                    work: WorkKind::None,
                    ..Default::default()
                }
                .info()
            )
            .unwrap()
        )
        .unwrap(),
        r#"{"name":"x","image":"","isolated":false,"helper":false,"work":"none","workPicks":[]}"#
    );
    assert!(only_default(&[ProfileInfo {
        name: PROFILE_SCRATCH.into(),
        ..Default::default()
    }]));
    assert!(!only_default(&[]));
    assert!(!only_default(&[ProfileInfo {
        name: PROFILE_DEV.into(),
        ..Default::default()
    }]));
}

#[test]
fn verify_mounts_rules() {
    let ms = vec![Mount {
        host: "/nope".into(),
        container: "/x".into(),
        ..Default::default()
    }];
    assert_eq!(
        verify_mounts(&ms, &|_| false).unwrap_err().to_string(),
        "기본 마운트의 원본이 없습니다: /nope (sandbox.json 를 확인하세요)"
    );
    assert!(verify_mounts(&ms, &|_| true).is_ok());
}

#[test]
fn copy_limits() {
    let d = tempfile::tempdir().unwrap();
    for i in 0..4 {
        std::fs::write(d.path().join(format!("f{i}.txt")), "x".repeat(100)).unwrap();
    }
    let dir = d.path().to_str().unwrap();
    assert!(verify_copy_source(&scratch(), dir, 10_000, 100).is_ok());
    assert_eq!(
        verify_copy_source(&scratch(), dir, 10, 100)
            .unwrap_err()
            .to_string(),
        "작업 폴더가 너무 큽니다(100 B > 10 B) — 더 좁은 폴더를 고르거나 dev 프로파일로 마운트하세요"
    );
    assert_eq!(
        verify_copy_source(&scratch(), dir, 10_000, 2)
            .unwrap_err()
            .to_string(),
        "작업 폴더의 항목이 너무 많습니다(3 > 2) — 더 좁은 폴더를 고르거나 dev 프로파일로 마운트하세요"
    );
    assert!(verify_copy_source(&dev_profile(), dir, 1, 1).is_ok());
    assert!(verify_copy_source(&scratch(), "", 1, 1).is_ok());
    let git = d.path().join(".git");
    std::fs::create_dir(&git).unwrap();
    let nested = tempfile::tempdir().unwrap();
    let g = nested.path().join(".git");
    std::fs::create_dir(&g).unwrap();
    for i in 0..3 {
        std::fs::write(g.join(format!("f{i}")), "x").unwrap();
    }
    assert!(verify_copy_source(&scratch(), nested.path().to_str().unwrap(), 10_000, 2).is_err());
    let missing = d.path().join("nope");
    let e = verify_copy_source(&scratch(), missing.to_str().unwrap(), 1 << 30, 1000).unwrap_err();
    assert_eq!(
        e.to_string(),
        format!(
            "작업 폴더를 읽을 수 없습니다: lstat {}: no such file or directory",
            missing.display()
        )
    );
    assert_eq!(human_bytes(1023), "1023 B");
    assert_eq!(human_bytes(1536), "1.5 KiB");
    assert_eq!(human_bytes(COPY_MAX_BYTES), "2.0 GiB");
}

#[derive(Default)]
struct HelperEnv {
    present: Mutex<HashSet<String>>,
    log: Mutex<Vec<String>>,
}

fn helper_deps(env: &Arc<HelperEnv>, version: &str, fail: bool) -> HelperDeps {
    let (a, b, c, d) = (
        Arc::clone(env),
        Arc::clone(env),
        Arc::clone(env),
        Arc::clone(env),
    );
    HelperDeps {
        version: version.into(),
        arch: "arm64".into(),
        home: "/home/u/.otterminal".into(),
        stat: Arc::new(move |p| a.present.lock().unwrap().contains(p)),
        fetch: Arc::new(move |url, dest| {
            if fail {
                return Err("404".into());
            }
            b.log.lock().unwrap().push(format!("fetch {url}"));
            b.present.lock().unwrap().insert(dest.into());
            Ok(())
        }),
        cross_build: Arc::new(move |_, dest| {
            if fail {
                return Err("go: command not found".into());
            }
            c.log.lock().unwrap().push(format!("build {dest}"));
            Ok(())
        }),
        list_cache: None,
        remove: Some(Arc::new(move |p| {
            d.log.lock().unwrap().push(format!("rm {p}"))
        })),
    }
}

#[test]
fn helper_cache_rules() {
    let a = helper_cache_path("/h", "v1.2.3", "arm64");
    assert_eq!(
        a,
        otter_gocompat::filepath::join(&["/h", "cache", "otterctl-v1.2.3-linux-arm64"])
    );
    assert_ne!(a, helper_cache_path("/h", "v1.3.0", "arm64"));

    let env = Arc::new(HelperEnv::default());
    let d = helper_deps(&env, "v1.2.3", false);
    let want = helper_cache_path(&d.home, &d.version, &d.arch);
    env.present.lock().unwrap().insert(want.clone());
    assert_eq!(ensure_helper(&d).unwrap(), want);
    assert!(env.log.lock().unwrap().is_empty());

    let env = Arc::new(HelperEnv::default());
    ensure_helper(&helper_deps(&env, "v1.2.3", false)).unwrap();
    assert_eq!(
        *env.log.lock().unwrap(),
        [
            "fetch https://github.com/Biisairo/otterminal/releases/download/v1.2.3/otterminal-linux-arm64"
        ]
    );
    let env = Arc::new(HelperEnv::default());
    ensure_helper(&helper_deps(&env, "dev", false)).unwrap();
    assert!(env.log.lock().unwrap()[0].starts_with("build "));

    let env = Arc::new(HelperEnv::default());
    let e = ensure_helper(&helper_deps(&env, "dev", true))
        .unwrap_err()
        .to_string();
    let dest = helper_cache_path("/home/u/.otterminal", "dev", "arm64");
    assert_eq!(
        e,
        format!(
            "리눅스용 otterctl 를 만들지 못했습니다(개발 빌드): go: command not found\n  직접 놓아두려면: cargo build --release -p otterminal --target aarch64-unknown-linux-gnu && cp target/aarch64-unknown-linux-gnu/release/otterminal {dest}"
        )
    );
    let e = ensure_helper(&helper_deps(&env, "v9.9.9", true))
        .unwrap_err()
        .to_string();
    assert_eq!(
        e,
        "리눅스용 otterctl 를 받지 못했습니다(https://github.com/Biisairo/otterminal/releases/download/v9.9.9/otterminal-linux-arm64): 404"
    );

    let env = Arc::new(HelperEnv::default());
    let mut d = helper_deps(&env, "v1.3.0", false);
    let cur = helper_cache_path(&d.home, &d.version, &d.arch);
    let old = helper_cache_path(&d.home, "v1.2.3", &d.arch);
    let other = otter_gocompat::filepath::join(&[d.home.as_str(), "cache", "other.bin"]);
    let listed = vec![cur, old.clone(), other];
    d.list_cache = Some(Arc::new(move |_| Ok(listed.clone())));
    prune_helper_cache(&d);
    assert_eq!(*env.log.lock().unwrap(), [format!("rm {old}")]);
}

fn look_ok(_: &str) -> Result<String, String> {
    Ok("/usr/local/bin/docker".into())
}

#[test]
fn runtime_probe() {
    let called = Mutex::new(false);
    let st = probe("linux", &|_| Err("not found".into()), &|_, _| {
        *called.lock().unwrap() = true;
        RunOutput::default()
    });
    assert_eq!((st.state.as_str(), st.path.as_str()), (RUNTIME_MISSING, ""));
    assert!(!*called.lock().unwrap());
    assert_eq!(st.install_command, install_command("linux"));
    assert_eq!(
        (st.start_command.clone(), st.start_tryable),
        start_command("linux")
    );

    let seen = Mutex::new((String::new(), Vec::<String>::new()));
    let st = probe("linux", &look_ok, &|p, a| {
        *seen.lock().unwrap() = (p.into(), a.to_vec());
        RunOutput::ok("27.1.1\n")
    });
    assert_eq!(
        (st.state.as_str(), st.path.as_str(), st.detail.as_str()),
        (RUNTIME_OK, "/usr/local/bin/docker", "")
    );
    assert_eq!((st.os.as_str(), st.runtime.as_str()), ("linux", "docker"));
    let s = seen.lock().unwrap();
    assert_eq!(
        (s.0.as_str(), s.1.join(" ")),
        (
            "/usr/local/bin/docker",
            "info --format {{.ServerVersion}}".into()
        )
    );

    let st = probe("linux", &look_ok, &|_, _| {
        RunOutput::fail("  permission denied\n", "exit status 1")
    });
    assert_eq!(
        (st.state.as_str(), st.detail.as_str()),
        (RUNTIME_STOPPED, "permission denied")
    );
    let st = probe("linux", &look_ok, &|_, _| {
        RunOutput::fail("", "exit status 1")
    });
    assert_eq!(st.detail, "exit status 1");
    assert_eq!(
        String::from_utf8(otter_gocompat::json::marshal(&st).unwrap()).unwrap(),
        r#"{"state":"stopped","os":"linux","runtime":"docker","path":"/usr/local/bin/docker","detail":"exit status 1","installCommand":"curl -fsSL https://get.docker.com | sh","startCommand":"sudo systemctl start docker","startTryable":false}"#
    );
}

#[test]
fn runtime_start_commands() {
    assert_eq!(start_command("darwin"), ("open -a Docker".into(), true));
    assert_eq!(
        start_command("windows"),
        ("cmd /c start \"\" \"Docker Desktop.exe\"".into(), true)
    );
    assert_eq!(
        start_command("linux"),
        ("sudo systemctl start docker".into(), false)
    );
    assert_eq!(start_command("wsl"), start_command("linux"));
    assert_eq!(install_command("wsl"), install_command("linux"));
    assert_eq!(
        start_command("plan9"),
        ("docker 데몬을 시작하세요".into(), false)
    );
    assert_eq!(install_command("plan9"), "");

    let r = start_runtime("linux", &|_, _| panic!("linux 는 시도하지 않는다"));
    assert_eq!(
        r,
        StartResult {
            started: false,
            command: "sudo systemctl start docker".into(),
            detail: String::new()
        }
    );
    let seen = Mutex::new(String::new());
    let r = start_runtime("darwin", &|p, a| {
        *seen.lock().unwrap() = format!("{p} {}", a.join(" "));
        RunOutput::default()
    });
    assert!(r.started);
    assert_eq!(*seen.lock().unwrap(), "open -a Docker");
    let r = start_runtime("darwin", &|_, _| RunOutput::fail("no app", "exit status 1"));
    assert_eq!((r.started, r.detail.as_str()), (false, "no app"));
}

#[test]
fn crate_dir_is_manifest_dir_in_dev_build() {
    assert_eq!(crate::helper::CRATE_DIR, env!("CARGO_MANIFEST_DIR"));
    let root =
        crate::helper::source_root_from(std::path::Path::new(crate::helper::CRATE_DIR)).unwrap();
    assert!(std::path::Path::new(&root).join("Cargo.lock").exists());
}

#[test]
fn source_root_walks_up_to_cargo_lock() {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("Cargo.lock"), "").unwrap();
    let deep = d.path().join("crates/shared/sandbox");
    std::fs::create_dir_all(&deep).unwrap();
    assert_eq!(
        crate::helper::source_root_from(&deep).unwrap(),
        d.path().to_string_lossy()
    );
}

// 릴리스(trimpath) 빌드는 탐색하지 않고 이 문구로 실패한다.
#[test]
fn trimmed_build_error_text() {
    assert_eq!(
        crate::helper::source_root_missing(std::path::Path::new("crates/shared/sandbox")),
        "소스 트리를 찾을 수 없습니다(crates/shared/sandbox 에서 위로 Cargo.lock 없음)"
    );
}
