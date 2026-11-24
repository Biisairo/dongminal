use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::Path;
use std::time::{Duration, Instant};

use dm_shared_dmenv as dmenv;
use dm_shared_handover::{Kind, Outcome, REASON_PREFLIGHT};

use super::fake_http::FakeServer;
use super::{Vars, temp_home, with_env, write_server_json};
use crate::proc::{Procs, free_port, tail};
use crate::session_keep::{DaemonOps, prepare_daemon};
use crate::start::{
    ISOLATED_HOME_PREFIX, isolated_tool_home, prepare_server_cmd, resolve_start_target,
    run_start_in, start_flag_host,
};
use crate::update_notice::announce_update_check;
use crate::{Common, DEFAULT_HOST, EXPOSE_HOST, ServeTarget, StartOpts};

fn no_listener(_: &str) -> Vec<i32> {
    Vec::new()
}

#[derive(Default, Debug, Clone)]
struct Served {
    home: String,
    host: String,
    port: String,
    tool_home: String,
}

/// 전경 기동을 돌린다. 포트 관측은 비어 있다 — 어떤 프로세스에도 신호가 가지 않는다.
fn start_fg(o: StartOpts, v: &Vars) -> (i32, Served, String, String) {
    let o = StartOpts {
        foreground: true,
        ..o
    };
    let got = RefCell::new(Served::default());
    let serve = |t: &ServeTarget<'_>| {
        *got.borrow_mut() = Served {
            home: t.home.to_owned(),
            host: t.host.to_owned(),
            port: t.port.to_owned(),
            tool_home: t.tool_home.to_owned(),
        };
        0
    };
    let ps = Procs {
        proc: dm_shared_platform::current().process,
        pids_on_port: &no_listener,
    };
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = with_env(v, |env| {
        run_start_in(&o, env, &ps, &serve, &mut out, &mut err)
    });
    (
        code,
        got.into_inner(),
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

fn read_server_json(home: &Path) -> serde_json::Map<String, serde_json::Value> {
    dm_gocompat::json::unmarshal(&std::fs::read(home.join("server.json")).unwrap()).unwrap()
}

fn common(home: &Path, port: &str) -> Common {
    Common {
        home: home.to_str().unwrap().to_owned(),
        port: port.to_owned(),
    }
}

#[test]
fn isolated_tool_home_paths() {
    let iso = format!("/tmp/{ISOLATED_HOME_PREFIX}abc123");
    assert_eq!(
        isolated_tool_home(&iso),
        dm_gocompat::filepath::join(&[iso.as_str(), "tool-home"])
    );
    assert_eq!(isolated_tool_home("/Users/someone/.dongminal"), "");
}

// D-A-9: 격리 전경 기동은 어디에 떴는지 말하고, 도구 셸의 홈을 serve 에 넘긴다.
#[test]
fn isolated_foreground_announces_homes() {
    let (_d, user) = temp_home();
    let (code, s, out, err) = start_fg(
        StartOpts {
            isolated: true,
            ..Default::default()
        },
        &Vars::home(&user),
    );
    assert_eq!(code, 0, "{err}");
    let _cleanup = Cleanup(s.home.clone());
    assert_eq!(s.tool_home, isolated_tool_home(&s.home));
    assert!(Path::new(&s.tool_home).is_dir());
    assert!(out.contains(&format!("격리 홈: {} (자동으로 지우지 않습니다)\n", s.home)));
    assert!(out.contains(&format!(
        "도구 셸의 홈: {} — 사용자 rc·git config·자격증명이 없는 빈 홈입니다\n정지: ^C\n",
        s.tool_home
    )));
    // FR-M9-2: 격리는 물려받은 노출 호스트를 쓰지 않는다.
    assert_eq!(s.host, DEFAULT_HOST);
    let m = read_server_json(Path::new(&s.home));
    assert_eq!(m["port"], s.port.as_str());
    assert_eq!(m["host"], DEFAULT_HOST);
    // 사용자 홈은 건드리지 않는다.
    assert!(!user.join("server.json").exists());
}

struct Cleanup(String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// FR-M9-1: 노출 기동은 허용 목록의 상태와 무관하게 뜬다.
#[test]
fn expose_starts_without_allowlist() {
    for acl in [
        "",
        r#"{"enabled":false,"entries":[]}"#,
        r#"{"enabled":true,"entries":[]}"#,
    ] {
        let (_d, home) = temp_home();
        if !acl.is_empty() {
            std::fs::write(home.join("access.json"), acl).unwrap();
        }
        let (code, s, _, err) = start_fg(
            StartOpts {
                common: common(&home, "60999"),
                expose: true,
                ..Default::default()
            },
            &Vars::home(&home),
        );
        assert_eq!(code, 0, "{err}");
        assert_eq!(s.host, EXPOSE_HOST);
        assert!(!err.contains("허용 목록"), "{err}");
    }
}

#[test]
fn flag_host() {
    let iso = StartOpts {
        isolated: true,
        ..Default::default()
    };
    assert_eq!(start_flag_host(&iso), DEFAULT_HOST);
    let both = StartOpts {
        expose: true,
        ..iso.clone()
    };
    assert_eq!(start_flag_host(&both), EXPOSE_HOST);
    let exp = StartOpts {
        expose: true,
        ..Default::default()
    };
    assert_eq!(start_flag_host(&exp), EXPOSE_HOST);
    assert_eq!(start_flag_host(&StartOpts::default()), "");
}

// FR-HRB-3·4: 기동 플래그는 server.json 에 쓴 뒤 그 값으로 뜬다.
#[test]
fn port_flag_writes_server_json() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"host":"127.0.0.1","logLevel":"debug"}"#);
    let p = free_port().unwrap();
    let (code, s, out, err) = start_fg(
        StartOpts {
            common: common(&home, &p),
            ..Default::default()
        },
        &Vars::home(&home),
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(s.port, p);
    assert_eq!(s.tool_home, "");
    let m = read_server_json(&home);
    assert_eq!(m["port"], p.as_str());
    assert_eq!(m["logLevel"], "debug");
    assert_eq!(
        out,
        "dongminald 미실행 — dongminal 이 자동 기동합니다\n\
         ℹ️  새 판이 나오면 화면에 알려 드립니다 — 서버가 GitHub 릴리스를 하루 한 번 확인합니다.\n\
         \x20  끄려면: 설정 ▸ 업데이트 알림 (또는 server.json 의 updateCheck 를 false 로)\n"
    );
}

#[test]
fn expose_writes_and_plain_keeps_host() {
    let (_d, home) = temp_home();
    write_server_json(&home, &format!(r#"{{"port":"{}"}}"#, free_port().unwrap()));
    let v = Vars::home(&home);
    let (_, s, _, _) = start_fg(
        StartOpts {
            common: common(&home, ""),
            expose: true,
            ..Default::default()
        },
        &v,
    );
    assert_eq!(s.host, EXPOSE_HOST);
    assert_eq!(read_server_json(&home)["host"], EXPOSE_HOST);
    let (_, s, _, _) = start_fg(
        StartOpts {
            common: common(&home, ""),
            ..Default::default()
        },
        &v,
    );
    assert_eq!(
        s.host, EXPOSE_HOST,
        "--expose 없는 start 가 파일의 호스트를 버렸다"
    );
}

// FR-HRB-1·8: 바인드 환경변수는 무시하고 한 번만 경고한다.
#[test]
fn ignores_bind_env_and_warns() {
    let (_d, home) = temp_home();
    let p = free_port().unwrap();
    write_server_json(&home, &format!(r#"{{"port":"{p}"}}"#));
    let mut v = Vars::home(&home);
    v.set("PORT", "61001");
    v.set(dmenv::ENV_PORT, "61001");
    v.set(dmenv::ENV_HOST, EXPOSE_HOST);
    let (_, s, _, err) = start_fg(
        StartOpts {
            common: common(&home, ""),
            ..Default::default()
        },
        &v,
    );
    assert_eq!(
        (s.host.as_str(), s.port.as_str()),
        (DEFAULT_HOST, p.as_str())
    );
    assert_eq!(err.matches(dmenv::ENV_PORT).count(), 1, "{err}");
}

// FR-CFG-19: 잘못된 플래그 포트는 파서가 막지만, 파일 포트 오류는 막지 않는다.
#[test]
fn bad_file_port_warns_and_uses_default() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"port":"abc"}"#);
    let (code, s, _, err) = start_fg(
        StartOpts {
            common: common(&home, ""),
            ..Default::default()
        },
        &Vars::home(&home),
    );
    assert_eq!(code, 0);
    assert_eq!(s.port, crate::DEFAULT_PORT);
    assert!(
        err.starts_with("⚠ server.json 의 port 를 쓸 수 없습니다"),
        "{err}"
    );
}

// FR-FG-4·FR-HRB-5: 끊어 띄우는 자식은 바인드 환경변수와 대리 표식을 받지 않고 홈을 받는다.
#[test]
fn server_cmd_carries_no_bind_env() {
    let (_d, home) = temp_home();
    let log = home.join("x.log");
    let v = Vars::home(&home);
    let cmd = with_env(&v, |env| {
        prepare_server_cmd(home.to_str().unwrap(), log.to_str().unwrap(), env)
    })
    .unwrap();
    let envs: HashMap<&OsStr, Option<&OsStr>> = cmd.cmd.get_envs().collect();
    for k in [
        "PORT",
        dmenv::ENV_PORT,
        dmenv::ENV_HOST,
        dmenv::ENV_RESTART_RUNNER,
        dmenv::ENV_TOOL_ID,
    ] {
        assert_eq!(envs.get(OsStr::new(k)), Some(&None), "{k}");
    }
    assert_eq!(
        envs.get(OsStr::new(dmenv::ENV_HOME)),
        Some(&Some(home.as_os_str()))
    );
    let args: Vec<_> = cmd.cmd.get_args().collect();
    assert_eq!(args, ["start", "--foreground"]);
    assert_eq!(cmd.log_path, log.to_str().unwrap());
    assert!(log.exists());
}

#[test]
fn resolve_target_plain_and_isolated() {
    let (_d, home) = temp_home();
    let v = Vars::home(&home);
    let (h, p) = with_env(&v, |env| resolve_start_target(&StartOpts::default(), env)).unwrap();
    assert_eq!((h.as_str(), p.as_str()), (home.to_str().unwrap(), ""));
    let o = StartOpts {
        common: common(Path::new("/tmp/dm-explicit"), "60200"),
        isolated: true,
        ..Default::default()
    };
    let (h, p) = with_env(&v, |env| resolve_start_target(&o, env)).unwrap();
    assert_eq!((h.as_str(), p.as_str()), ("/tmp/dm-explicit", "60200"));
    let iso = StartOpts {
        isolated: true,
        ..Default::default()
    };
    let (h, p) = with_env(&v, |env| resolve_start_target(&iso, env)).unwrap();
    let _c = Cleanup(h.clone());
    assert!(
        Path::new(&h)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with(ISOLATED_HOME_PREFIX)
    );
    assert!(p.parse::<u16>().unwrap() > 0);
}

#[test]
fn free_port_is_a_port() {
    let n: u32 = free_port().unwrap().parse().unwrap();
    assert!((1024..=65535).contains(&n));
}

// ── session_keep (DAEMON_SESSION_KEEP_SRS) ──

#[derive(Default)]
struct Recorder {
    running: bool,
    outcome: Option<Outcome>,
    confirm_err: Option<String>,
    reloads: usize,
    confirms: usize,
    stops: usize,
}

impl DaemonOps for Recorder {
    fn running(&mut self) -> bool {
        self.running
    }
    fn reload(&mut self) -> Outcome {
        self.reloads += 1;
        self.outcome.clone().unwrap()
    }
    fn confirm(&mut self) -> Result<(), String> {
        self.confirms += 1;
        self.confirm_err.clone().map_or(Ok(()), Err)
    }
    fn stop(&mut self, _: &mut dyn std::io::Write) -> bool {
        self.stops += 1;
        true
    }
    fn notice(&mut self) -> String {
        "dongminald 실행 중".to_owned()
    }
}

fn outcome(kind: Kind, reason: &str, detail: &str) -> Option<Outcome> {
    Some(Outcome {
        kind,
        reason: reason.to_owned(),
        detail: detail.to_owned(),
    })
}

fn prepare(o: StartOpts, r: &mut Recorder) -> (Result<(), i32>, String, String) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let res = prepare_daemon(&o, r, &mut out, &mut err);
    (
        res,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

#[test]
fn prepare_swaps_then_proceeds() {
    let mut r = Recorder {
        running: true,
        outcome: outcome(Kind::Swapped, "", ""),
        ..Default::default()
    };
    let (res, out, _) = prepare(StartOpts::default(), &mut r);
    assert_eq!(res, Ok(()));
    assert_eq!((r.reloads, r.confirms, r.stops), (1, 1, 0));
    assert_eq!(
        out,
        "dongminald 를 세션을 유지하며 교체합니다...\n✅ dongminald 교체 완료 (세션 유지)\n"
    );
}

#[test]
fn prepare_refused_stops_everything() {
    let mut r = Recorder {
        running: true,
        outcome: outcome(Kind::Refused, REASON_PREFLIGHT, "판이 다르다"),
        ..Default::default()
    };
    let (res, _, err) = prepare(StartOpts::default(), &mut r);
    assert_eq!(res, Err(1));
    assert_eq!((r.stops, r.confirms), (0, 0));
    assert_eq!(
        err,
        format!(
            "❌ dongminald 교체 실패 ({REASON_PREFLIGHT}): 판이 다르다\n  서버·데몬·세션은 그대로입니다.\n  세션을 버리고 새로 띄우려면: dongminal start --refresh-daemon\n"
        )
    );
}

#[test]
fn prepare_unconfirmed_swap_stops() {
    let mut r = Recorder {
        running: true,
        outcome: outcome(Kind::Swapped, "", ""),
        confirm_err: Some("pid 가 바뀌었다".to_owned()),
        ..Default::default()
    };
    let (res, _, err) = prepare(StartOpts::default(), &mut r);
    assert_eq!(res, Err(1));
    assert!(err.starts_with("❌ 교체한 dongminald 를 확인하지 못했습니다: pid 가 바뀌었다\n"));
}

#[test]
fn prepare_unsupported_restarts_server_only() {
    let mut r = Recorder {
        running: true,
        outcome: outcome(Kind::Unsupported, "", ""),
        ..Default::default()
    };
    let (res, out, _) = prepare(StartOpts::default(), &mut r);
    assert_eq!(res, Ok(()));
    assert_eq!((r.stops, r.confirms), (0, 0));
    assert!(
        out.contains("옛 판") && out.contains("--refresh-daemon"),
        "{out}"
    );
}

#[test]
fn prepare_not_running_just_proceeds() {
    let mut r = Recorder::default();
    let (res, out, _) = prepare(StartOpts::default(), &mut r);
    assert_eq!(res, Ok(()));
    assert_eq!((r.reloads, r.stops), (0, 0));
    assert_eq!(out, "dongminald 미실행 — dongminal 이 자동 기동합니다\n");
}

#[test]
fn prepare_server_only_touches_nothing() {
    let mut r = Recorder {
        running: true,
        ..Default::default()
    };
    let o = StartOpts {
        server_only: true,
        ..Default::default()
    };
    let (res, out, _) = prepare(o, &mut r);
    assert_eq!(res, Ok(()));
    assert_eq!((r.reloads, r.stops), (0, 0));
    assert_eq!(out, "dongminald 실행 중\n");
}

#[test]
fn prepare_refresh_stops_daemon() {
    let mut r = Recorder {
        running: true,
        ..Default::default()
    };
    let o = StartOpts {
        refresh_daemon: true,
        ..Default::default()
    };
    let (res, out, _) = prepare(o, &mut r);
    assert_eq!(res, Ok(()));
    assert_eq!((r.stops, r.reloads), (1, 0));
    assert!(out.contains("세션을 잃습니다"));
}

// ── handoff (FR-ACT-3a/3b) ──

#[test]
fn should_hand_off_restart() {
    use crate::handoff::should_hand_off_restart as f;
    assert!(f(true, "", "tool-1"));
    assert!(!f(true, "1", "tool-1"));
    assert!(!f(true, "", ""));
    assert!(!f(false, "", "tool-1"));
    assert!(!f(false, "", ""));
    assert!(!f(true, "1", ""));
}

// ── health_wait (FR-VHL-20·21) ──

#[test]
fn wait_daemon_connected() {
    use crate::health_wait::wait_daemon_connected as wait;
    let ok = FakeServer::start_health(
        r#"{"version":"1.0.0","daemon":{"connected":true,"protocol":1,"build":"1.0.0","mismatch":false}}"#,
    );
    let (st, c) = wait(&ok.url(), 5, Duration::from_millis(10));
    assert!(c && !st.mismatch);

    let never = FakeServer::start_health(r#"{"version":"1.0.0","daemon":{"connected":false}}"#);
    let t = Instant::now();
    assert!(!wait(&never.url(), 3, Duration::from_millis(10)).1);
    assert!(t.elapsed() < Duration::from_secs(2));

    let mismatch = FakeServer::start_health(
        r#"{"version":"2.0.0","daemon":{"connected":true,"protocol":1,"build":"1.0.0","mismatch":true}}"#,
    );
    let (st, c) = wait(&mismatch.url(), 5, Duration::from_millis(10));
    assert!(c && st.mismatch);
    assert_eq!(
        (st.daemon_build.as_str(), st.server_version.as_str()),
        ("1.0.0", "2.0.0")
    );

    // 헬스가 없는 옛 서버는 "모른다" 다.
    let none = FakeServer::start(200, "");
    assert!(!wait(&none.url(), 2, Duration::from_millis(10)).1);
}

// ── update_notice (FR-UPD-10·11) ──

fn no_env(_: &str) -> String {
    String::new()
}

#[test]
fn update_notice_once_then_never() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().to_str().unwrap();
    let mut first = Vec::new();
    announce_update_check(home, &no_env, &mut first);
    let first = String::from_utf8(first).unwrap();
    assert!(first.contains("GitHub") && first.contains("끄려면"));
    let mut second = Vec::new();
    announce_update_check(home, &no_env, &mut second);
    assert!(second.is_empty());
    let conf = dm_shared_serverconf::resolve(&dm_shared_serverconf::Inputs {
        home: d.path(),
        getenv: Some(&no_env),
        ..Default::default()
    });
    assert!(conf.update_check_set && conf.update_check);
}

#[test]
fn update_notice_silent_when_decided_or_killed() {
    let d = tempfile::tempdir().unwrap();
    dm_shared_serverconf::set_update_check(d.path(), false).unwrap();
    let mut out = Vec::new();
    announce_update_check(d.path().to_str().unwrap(), &no_env, &mut out);
    assert!(out.is_empty());

    let d = tempfile::tempdir().unwrap();
    let kill = |k: &str| {
        if k == dmenv::ENV_NO_CHECK {
            "1".to_owned()
        } else {
            String::new()
        }
    };
    announce_update_check(d.path().to_str().unwrap(), &kill, &mut out);
    assert!(out.is_empty());
    assert!(
        !d.path().join("server.json").exists(),
        "알리지도 않고 표식만 남겼다"
    );
    announce_update_check("", &no_env, &mut out);
    assert!(out.is_empty());
}

// ── tail (FR-OPT-8-6) ──

#[test]
fn tail_last_lines() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("log");
    std::fs::write(&p, "a\nb\nc\nd\n").unwrap();
    let p = p.to_str().unwrap();
    assert_eq!(tail(p, 2), "c\nd");
    assert_eq!(tail(p, 10), "a\nb\nc\nd");
    assert_eq!(tail(d.path().join("없음").to_str().unwrap(), 3), "");
}

#[test]
fn tail_reads_only_the_end() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("log");
    let mut s = "앞".repeat(64 << 10);
    s.push('\n');
    s.push_str(&"line\n".repeat(30));
    std::fs::write(&p, s).unwrap();
    let got = tail(p.to_str().unwrap(), 20);
    assert!(!got.contains('앞'));
    assert_eq!(got.matches("line").count(), 20);
}

// FR-RDF-9: start·doctor·backup 의 MkdirAll 은 gocompat 의 Go 알고리즘이다. 막힌 그 칸의 경로로 낸다.
#[test]
fn mkdir_all_error_matches_go() {
    let d = tempfile::tempdir().unwrap();
    let blocker = dm_gocompat::filepath::join(&[d.path().to_str().unwrap(), "f"]);
    std::fs::write(&blocker, "x").unwrap();
    let e = crate::start::mkdir_all(&format!("{blocker}/a/b"), 0o700).unwrap_err();
    assert_eq!(e.to_string(), format!("mkdir {blocker}: not a directory"));
}
