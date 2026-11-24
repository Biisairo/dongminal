use std::path::Path;

use dm_shared_dmenv as dmenv;

use super::fake_http::{FakeServer, dead_port};
use super::{Vars, with_env};
use crate::health::run_health_in;
use crate::staleness::{DaemonState, daemon_state_line};
use crate::{Common, HealthOpts};

fn run(home: &Path, port: &str) -> (i32, String, String) {
    let o = HealthOpts {
        common: Common {
            home: home.to_str().unwrap().to_owned(),
            port: port.to_owned(),
        },
        daemon_only: false,
    };
    let user = tempfile::tempdir().unwrap();
    let v = Vars::new(&[(super::USER_HOME_VAR, user.path().to_str().unwrap())]);
    let mut out = Vec::new();
    let mut err = Vec::new();
    let p = dm_shared_platform::current().process;
    let code = with_env(&v, |env| run_health_in(&o, env, p, "", &mut out, &mut err));
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

fn suffix() -> &'static str {
    dm_shared_platform::current().paths.exe_suffix()
}

// V-HLI-8: 새 홈은 실패가 아니다. 출력 전체를 Go 의 문구대로 확인한다.
#[test]
fn fresh_home_is_not_failure() {
    let srv = FakeServer::start(200, "");
    let d = tempfile::tempdir().unwrap();
    let (code, out, err) = run(d.path(), &srv.port);
    assert_eq!(code, 0, "{out}{err}");
    let bin = dm_gocompat::filepath::join(&[d.path().to_str().unwrap(), "bin"]);
    assert_eq!(
        out,
        format!(
            "✅ dongminal HTTP :{}\nℹ️  dongminald 소켓 없음 (미기동)\n{}\nℹ️  헬퍼 {} ({bin})\n",
            srv.port,
            daemon_state_line(DaemonState::NotRunning),
            dm_shared_runtime::HELPER_NOT_INSTALLED
        )
    );
}

#[test]
fn no_server_is_failure() {
    let d = tempfile::tempdir().unwrap();
    let port = dead_port();
    let (code, out, _) = run(d.path(), &port);
    assert_eq!(code, 1);
    assert!(out.starts_with(&format!("❌ dongminal HTTP :{port} — 응답 없음\n")));
}

// V-HLI-7: 깨진 헬퍼는 실패이고, 고치는 법을 알린다.
#[cfg(unix)]
#[test]
fn reports_broken_helpers() {
    let srv = FakeServer::start(200, "");
    let d = tempfile::tempdir().unwrap();
    let bin = d.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let gone = d.path().join("go-build-사라짐").join("dongminal");
    for n in dmenv::helper_names() {
        std::os::unix::fs::symlink(&gone, bin.join(format!("{n}{}", suffix()))).unwrap();
    }
    let (code, out, _) = run(d.path(), &srv.port);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("❌ 헬퍼 "), "{out}");
    assert!(
        out.contains(&format!("   {}\n", dm_shared_runtime::HELPER_FIX_HINT)),
        "{out}"
    );
}

#[test]
fn silent_on_healthy_helpers() {
    let srv = FakeServer::start(200, "");
    let d = tempfile::tempdir().unwrap();
    let bin = d.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    for n in dmenv::helper_names() {
        write_exe(&bin.join(format!("{n}{}", suffix())));
    }
    let shims = dmenv::agent_shims_dir_in(&bin);
    std::fs::create_dir_all(&shims).unwrap();
    for n in dm_shared_agentadapter::shim_commands() {
        write_exe(&shims.join(format!("{n}{}", suffix())));
    }
    let (code, out, _) = run(d.path(), &srv.port);
    assert_eq!(code, 0, "{out}");
    assert!(
        out.ends_with(&format!(
            "✅ 헬퍼 {}개 실행 가능 ({})\n",
            dmenv::helper_names().len(),
            dm_gocompat::filepath::join(&[d.path().to_str().unwrap(), "bin"])
        )),
        "{out}"
    );
}

fn write_exe(p: &Path) {
    std::fs::write(p, "x").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

// 소켓은 있으나 pid 가 죽어 있으면 실패로 센다.
#[cfg(unix)]
#[test]
fn dead_pid_with_socket_is_failure() {
    let srv = FakeServer::start(200, "");
    let d = tempfile::tempdir().unwrap();
    let _s = super::proc::live_socket(d.path());
    super::proc::write_pid(d.path(), "999999");
    let (code, out, _) = run(d.path(), &srv.port);
    assert_eq!(code, 1);
    assert!(
        out.contains("⚠️  dongminald 소켓은 있으나 pid=999999 가 죽어 있습니다\n"),
        "{out}"
    );
}
