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
        "/home/u/.dongminal",
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
        "dongminal-sbx-w-123"
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
        "--name dongminal-sbx-w1",
        "--label dongminal.window=w1",
        "--label dongminal.home=/home/u/.dongminal",
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
            RunOutput::fail("Error: No such object: dongminal-sbx-w1", "exit status 1")
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
            "docker: Error response from daemon: Conflict. The container name \"/dongminal-sbx-w1\" is already in use by container \"33b22c8d8073\".",
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
        helper_path: "/h/cache/dmctl-dev-linux-arm64".into(),
        addr_dir: "/h/run".into(),
    };
    mgr(&f).ensure("w1", &dev_profile(), &r).unwrap();
    let got = f.call("run");
    for want in [
        "-v /Users/me/app:/work",
        "-p 3000:3000",
        "-p 5173-5180:5173-5180",
        "--network bridge",
        "-v /h/cache/dmctl-dev-linux-arm64:/usr/local/bin/dmctl:ro",
        "-v /h/run:/run/dongminal:ro",
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
        helper_path: "/h/dmctl".into(),
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
    assert_eq!(f.call("cp"), "cp /Users/me/app/. dongminal-sbx-w1:/work");
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
    assert_eq!(f.call("rm"), "rm -f dongminal-sbx-w1");
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
        "/usr/bin/docker exec -it -e TERM=xterm-256color dongminal-sbx-w1 bash -l"
    );
    let env = ExecEnv {
        tool_id: "tool-9".into(),
        port: "58146".into(),
    };
    let spec = m.exec_spec("w1", "docker", &dev_profile(), &rs("/Users/me/app"), &env);
    assert_eq!(
        spec.args.join(" "),
        "docker exec -it -e TERM=xterm-256color -e DONGMINAL_HOST=host.docker.internal -e DONGMINAL_PORT=58146 -e DONGMINAL_TOOL_ID=tool-9 -w /work dongminal-sbx-w1 bash -l"
    );
    let spec = m.exec_spec("w1", "docker", &scratch(), &RunSpec::default(), &env);
    assert!(!spec.args.join(" ").contains("DONGMINAL_TOOL_ID"));
}

#[test]
fn remove_reap_and_stop() {
    let f = FakeDocker::with(|_| RunOutput::fail("", "No such container"));
    mgr(&f).remove("w1");
    assert_eq!(f.call("rm"), "rm -f dongminal-sbx-w1");

    let f = FakeDocker::with(|a| {
        if a[0] == "ps" {
            RunOutput::ok("dongminal-sbx-live w-live\ndongminal-sbx-dead w-dead\n")
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
    assert_eq!(removed, ["rm -f dongminal-sbx-dead"]);
    assert_eq!(
        f.call("ps"),
        "ps -a --filter label=dongminal.home=/home/u/.dongminal --format {{.Names}} {{.Label \"dongminal.window\"}}"
    );

    let f = FakeDocker::with(|a| {
        if a[0] == "ps" {
            RunOutput::ok("dongminal-sbx-a\ndongminal-sbx-b\n")
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
    assert_eq!(stopped, ["dongminal-sbx-a", "dongminal-sbx-b"]);
    assert!(
        f.call("ps")
            .contains("label=dongminal.home=/home/u/.dongminal")
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
        look_path("dongminal-no-such-binary").unwrap_err(),
        format!(
            "exec: \"dongminal-no-such-binary\": executable file not found in {}",
            if cfg!(windows) { "%PATH%" } else { "$PATH" }
        )
    );
}

#[test]
fn save_failed_text() {
    assert_eq!(
        Error::SaveFailed.to_string(),
        "샌드박스 정의를 저장하지 못했습니다"
    );
}
