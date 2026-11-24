use std::path::Path;

use otter_shared_otterenv as otterenv;
use otter_shared_serverconf as serverconf;

use super::{Vars, args, temp_home, with_env, write_server_json};
use crate::options::unknown_flag;
use crate::{
    Common, DEFAULT_PORT, ENV_HOME, ENV_PORT, ParseError, default_log_file, parse_doctor,
    parse_health, parse_migrate, parse_start, parse_stop, parse_window, usage_start,
};

fn err_text(e: ParseError) -> String {
    e.to_string()
}

#[test]
fn parse_start_flags() {
    let o = parse_start(&args(&[
        "--expose",
        "--server-only",
        "--isolated",
        "--foreground",
    ]))
    .unwrap();
    assert!(
        o.expose && o.server_only && o.isolated && o.foreground,
        "{o:?}"
    );
}

// V-WIN-5: `--open` 은 `window` 로 갈라져 나갔다. 모르는 옵션이어야 한다.
#[test]
fn parse_start_open_is_gone() {
    let e = parse_start(&args(&["--open"])).unwrap_err();
    assert!(err_text(e).contains("--open"));
}

#[test]
fn parse_start_defaults() {
    let o = parse_start(&[]).unwrap();
    assert!(!(o.expose || o.server_only || o.refresh_daemon || o.isolated || o.foreground));
    assert_eq!(o.common, Common::default());
}

#[test]
fn parse_help_all_actions() {
    type P = fn(&[String]) -> Result<(), ParseError>;
    let cases: [(&str, P); 5] = [
        ("start", |a| parse_start(a).map(drop)),
        ("stop", |a| parse_stop(a).map(drop)),
        ("health", |a| parse_health(a).map(drop)),
        ("window", |a| parse_window(a).map(drop)),
        ("migrate", |a| parse_migrate(a).map(drop)),
    ];
    for (name, f) in cases {
        for flag in ["-h", "--help"] {
            assert_eq!(f(&args(&[flag])), Err(ParseError::Help), "{name} {flag}");
        }
    }
}

#[test]
fn parse_unknown_flag() {
    let e = parse_stop(&args(&["--bogus"])).unwrap_err();
    assert!(err_text(e).contains("--bogus"));
}

#[test]
fn parse_common_both_forms() {
    for a in [
        &["--port", "9000", "--home", "/tmp/x"][..],
        &["--port=9000", "--home=/tmp/x"],
    ] {
        let o = parse_stop(&args(a)).unwrap();
        assert_eq!(o.common.port, "9000", "{a:?}");
        assert_eq!(o.common.home, "/tmp/x", "{a:?}");
    }
}

#[test]
fn parse_common_missing_value() {
    for a in [&["--port"][..], &["--home"], &["--port="]] {
        assert!(parse_health(&args(a)).is_err(), "{a:?}");
    }
}

#[test]
fn parse_port_must_be_numeric() {
    assert!(parse_health(&args(&["--port", "abc"])).is_err());
    assert!(parse_health(&args(&["--port", "70000"])).is_err());
    assert!(parse_health(&args(&["--port", "0"])).is_err());
    // Go strconv.Atoi 는 부호와 앞의 0 을 받는다.
    assert_eq!(
        parse_health(&args(&["--port", "+080"]))
            .unwrap()
            .common
            .port,
        "+080"
    );
}

#[test]
fn parse_migrate_dry_run_aliases() {
    for flag in ["--dry-run", "-n"] {
        assert!(parse_migrate(&args(&[flag])).unwrap().dry_run, "{flag}");
    }
}

// FR-RDG-25: 모르는 인자는 Common 에 넘기고, Common 도 모르면 그 명령의 unknownFlag 다.
#[test]
fn take_or_unknown() {
    let mut c = Common::default();
    let a = args(&["--port", "1234", "--bogus", "--home="]);
    let mut i = 0;
    c.take_or("start", &a, &mut i).unwrap();
    assert_eq!((c.port.as_str(), i), ("1234", 1));
    i = 2;
    assert_eq!(
        c.take_or("start", &a, &mut i),
        Err(unknown_flag("start", "--bogus"))
    );
    i = 3;
    assert_eq!(
        c.take_or("start", &a, &mut i).map_err(err_text),
        Err("--home 에 값이 없습니다".to_owned())
    );
}

#[test]
fn parsers_unknown_via_take_or() {
    type P = fn(&[String]) -> Result<(), ParseError>;
    let cases: [(&str, P); 6] = [
        ("start", |a| parse_start(a).map(drop)),
        ("stop", |a| parse_stop(a).map(drop)),
        ("doctor", |a| parse_doctor(a).map(drop)),
        ("health", |a| parse_health(a).map(drop)),
        ("window", |a| parse_window(a).map(drop)),
        ("migrate", |a| parse_migrate(a).map(drop)),
    ];
    for (name, f) in cases {
        assert_eq!(
            f(&args(&["--bogus"])),
            Err(unknown_flag(name, "--bogus")),
            "{name}"
        );
        assert_eq!(
            f(&args(&["--port", "x"])).map_err(err_text),
            Err("--port 값이 포트 번호가 아닙니다: x".to_owned()),
            "{name}"
        );
    }
}

// FR-CLI-9: 플래그 > 환경변수 > 기본값.
#[test]
fn resolve_port_priority() {
    let mut v = Vars::new(&[(ENV_PORT, "7777")]);
    with_env(&v, |env| {
        let flag = Common {
            port: "9000".into(),
            ..Default::default()
        };
        assert_eq!(flag.resolve_port_in(env), "9000");
        assert_eq!(Common::default().resolve_port_in(env), "7777");
    });
    v.set(ENV_PORT, "");
    with_env(&v, |env| {
        assert_eq!(Common::default().resolve_port_in(env), DEFAULT_PORT);
    });
}

#[test]
fn resolve_home_priority() {
    let mut v = Vars::new(&[(ENV_HOME, "/tmp/env-home"), (super::USER_HOME_VAR, "/u")]);
    with_env(&v, |env| {
        let flag = Common {
            home: "/tmp/flag-home".into(),
            ..Default::default()
        };
        assert_eq!(flag.resolve_home_in(env).unwrap(), "/tmp/flag-home");
        assert_eq!(
            Common::default().resolve_home_in(env).unwrap(),
            "/tmp/env-home"
        );
    });
    v.set(ENV_HOME, "");
    with_env(&v, |env| {
        assert_eq!(
            Common::default().resolve_home_in(env).unwrap(),
            otter_gocompat::filepath::join(&["/u", otterenv::DEFAULT_HOME_DIR])
        );
    });
}

#[cfg(unix)]
#[test]
fn resolve_home_expands_tilde() {
    let v = Vars::new(&[(ENV_HOME, "~/.otterminal-test"), ("HOME", "/u")]);
    with_env(&v, |env| {
        assert_eq!(
            Common::default().resolve_home_in(env).unwrap(),
            "/u/.otterminal-test"
        );
    });
    let v = Vars::new(&[(ENV_HOME, "~"), ("HOME", "/u/")]);
    with_env(&v, |env| {
        assert_eq!(Common::default().resolve_home_in(env).unwrap(), "/u");
    });
    // 선행 `~/` 만 편다.
    let v = Vars::new(&[(ENV_HOME, "~x/y"), ("HOME", "/u")]);
    with_env(&v, |env| {
        assert_eq!(Common::default().resolve_home_in(env).unwrap(), "~x/y");
    });
}

// 사용자 홈을 모르면 기본 홈을 정하지 못한다 — Go `os.UserHomeDir` 의 문구를 싣는다.
#[cfg(unix)]
#[test]
fn resolve_home_without_user_home() {
    let v = Vars::new(&[]);
    with_env(&v, |env| {
        assert_eq!(
            Common::default().resolve_home_in(env),
            Err("홈 디렉터리 확인 실패: $HOME is not defined".to_owned())
        );
    });
}

// TC-STR-13: 기본 로그 경로는 홈을 따른다.
#[test]
fn default_log_file_follows_home() {
    let (_d, home) = temp_home();
    let home = home.to_str().unwrap();
    assert_eq!(
        default_log_file(home),
        otter_gocompat::filepath::join(&[home, "server.log"])
    );
    assert_eq!(
        default_log_file(""),
        otter_shared_platform::current()
            .paths
            .default_log_file()
            .to_string_lossy()
    );
}

#[test]
fn config_show_log_file_is_under_home() {
    let (_d, home) = temp_home();
    let v = Vars::home(&home);
    let hs = home.to_str().unwrap();
    let get = |k: &str| v.get(k);
    let dl = default_log_file(hs);
    let conf = serverconf::resolve(&serverconf::Inputs {
        home: &home,
        getenv: Some(&get),
        default_log_file: &dl,
        ..Default::default()
    });
    assert_eq!(
        conf.log_file.value,
        otter_gocompat::filepath::join(&[hs, "server.log"])
    );
}

// FR-STR-34: `start --help` 는 로그 자리를 규칙으로 적는다.
#[test]
fn start_usage_describes_log_by_rule() {
    let u = usage_start();
    assert!(u.contains("$OTTERMINAL_HOME/server.log"));
    assert!(!u.contains("/tmp/otterminal.log"));
}

// ── ResolveTarget (TC-STR-6·7, FR-HRB-7) ──

fn target(home: &Path, c: &Common) -> Result<crate::Target, String> {
    let v = Vars::home(home);
    with_env(&v, |env| c.resolve_target_in(env))
}

#[test]
fn resolve_target_reads_server_json() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"host":"192.168.1.5","port":"9000"}"#);
    let t = target(&home, &Common::default()).unwrap();
    assert_eq!(t.port, "9000");
    assert_eq!(t.host, "192.168.1.5");
    assert_eq!(t.url, "http://192.168.1.5:9000");
    assert_eq!(t.home, home.to_str().unwrap());
}

#[test]
fn resolve_target_matches_start() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"host":"0.0.0.0","port":"9000"}"#);
    let t = target(&home, &Common::default()).unwrap();
    assert_eq!(t.url, otterenv::base_url("0.0.0.0", "9000"));
}

#[test]
fn resolve_target_flag_beats_file() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"port":"9000"}"#);
    let c = Common {
        port: "7777".into(),
        ..Default::default()
    };
    assert_eq!(target(&home, &c).unwrap().port, "7777");
}

#[test]
fn resolve_target_ignores_env() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"port":"9000"}"#);
    let mut v = Vars::home(&home);
    v.set("PORT", "8888");
    v.set(otterenv::ENV_PORT, "8888");
    let t = with_env(&v, |env| Common::default().resolve_target_in(env)).unwrap();
    assert_eq!(t.port, "9000");
}

#[test]
fn resolve_target_bad_file_port_falls_back() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"port":"abc"}"#);
    let t = target(&home, &Common::default()).unwrap();
    assert_eq!(t.port, DEFAULT_PORT);
    assert!(!t.warnings.is_empty());
}

#[test]
fn resolve_target_carries_warnings() {
    let (_d, home) = temp_home();
    write_server_json(&home, "{not json");
    let t = target(&home, &Common::default()).unwrap();
    assert!(!t.warnings.is_empty());
    assert_eq!(t.port, DEFAULT_PORT);
}

#[test]
fn resolve_target_order() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"host":"127.0.0.1","port":"9000"}"#);
    serverconf::write_addr(&home, "0.0.0.0:9300").unwrap();
    let t = target(&home, &Common::default()).unwrap();
    assert_eq!(t.port, "9300");
    assert_eq!(t.host, otterenv::dial_host("0.0.0.0"));
    let c = Common {
        port: "7777".into(),
        ..Default::default()
    };
    assert_eq!(target(&home, &c).unwrap().port, "7777");
    std::fs::remove_file(serverconf::addr_path(&home)).unwrap();
    assert_eq!(target(&home, &Common::default()).unwrap().port, "9000");
}

// 플래그 포트가 범위를 벗어나면 두드리기 전에 거절한다 (FR-STR-22).
#[test]
fn resolve_target_rejects_bad_flag_port() {
    let (_d, home) = temp_home();
    let c = Common {
        port: "0".into(),
        ..Default::default()
    };
    assert!(target(&home, &c).is_err());
}
