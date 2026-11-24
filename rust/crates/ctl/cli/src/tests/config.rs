use std::path::Path;

use otter_shared_serverconf as serverconf;
use serde_json::Value;

use super::fake_http::FakeServer;
use super::{Vars, args, temp_home, with_env, write_server_json, write_settings_json};
use crate::config::run_config_in;
use crate::{DEFAULT_HOST, DEFAULT_PORT, EXPOSE_HOST, parse_config};

fn run(home: &Path, v: Option<&Vars>, a: &[&str]) -> (i32, String, String) {
    let own = Vars::home(home);
    let vars = v.unwrap_or(&own);
    let o = parse_config(&args(a)).unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = with_env(vars, |env| run_config_in(&o, env, &mut out, &mut err));
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

fn read_server_json(home: &Path) -> serde_json::Map<String, Value> {
    match std::fs::read(home.join(serverconf::FILE_NAME)) {
        Ok(b) if !b.is_empty() => otter_gocompat::json::unmarshal(&b).unwrap(),
        _ => serde_json::Map::new(),
    }
}

// TC-CFG-11: `config show` 는 값과 출처를 함께 낸다.
#[test]
fn show_carries_source() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"host":"10.0.0.1"}"#);
    let mut v = Vars::home(&home);
    v.set("OTTERMINAL_LOG_LEVEL", "warn");
    let (code, out, err) = run(&home, Some(&v), &["show"]);
    assert_eq!(code, 0, "{err}");
    for want in [
        "host",
        "10.0.0.1",
        "file",
        "port",
        DEFAULT_PORT,
        "default",
        "logLevel",
        "warn",
        "env",
    ] {
        assert!(out.contains(want), "{want} 가 없다:\n{out}");
    }
}

// TC-CFG-15: `--json` 은 기계가 읽는 형태다.
#[test]
fn show_json() {
    let (_d, home) = temp_home();
    let (code, out, err) = run(&home, None, &["show", "--json"]);
    assert_eq!(code, 0, "{err}");
    let m: serde_json::Map<String, Value> =
        otter_gocompat::json::unmarshal(out.as_bytes()).unwrap();
    assert!(m.contains_key("server"));
    assert!(!m.contains_key("schema"), "show 는 표를 싣지 않는다");
    // Go 구조체의 필드 순서와 두 칸 들여쓰기, 끝의 줄바꿈.
    let hs = home.to_str().unwrap();
    assert!(
        out.starts_with(&format!(
            "{{\n  \"home\": {},\n  \"server\": {{\n    \"host\": {{\n      \"value\": \"127.0.0.1\",\n      \"source\": \"default\"\n    }},",
            String::from_utf8(otter_gocompat::json::marshal(&hs).unwrap()).unwrap()
        )),
        "{out}"
    );
    assert!(out.ends_with("}\n"));
}

// validate 의 --json 은 서술자 표를 싣는다.
#[test]
fn validate_json_carries_schema() {
    let (_d, home) = temp_home();
    let (_, out, _) = run(&home, None, &["validate", "--json"]);
    let m: serde_json::Map<String, Value> =
        otter_gocompat::json::unmarshal(out.as_bytes()).unwrap();
    assert!(
        m.get("schema")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
    );
}

// TC-CFG-12·14: 범위 밖 값을 잡고 첫 오류에서 멈추지 않는다.
#[test]
fn validate_reports_all_and_fails() {
    let (_d, home) = temp_home();
    write_settings_json(
        &home,
        r#"{"tabWidthPx":9999,"focusEdgeLevel":-3,"attnEdgeLevel":77}"#,
    );
    let (code, out, err) = run(&home, None, &["validate"]);
    assert_eq!(code, 1);
    let s = out + &err;
    for want in ["tabWidthPx", "focusEdgeLevel", "attnEdgeLevel"] {
        assert!(s.contains(want), "{want}:\n{s}");
    }
    assert!(s.contains("설정 블롭(settings.json): 불일치 3건\n"), "{s}");
}

// TC-CFG-13: 알 수 없는 키는 경고이며 exit 0.
#[test]
fn validate_unknown_key_is_warning() {
    let (_d, home) = temp_home();
    write_settings_json(&home, r#"{"zKey":1,"futureKey":1,"themeName":"x"}"#);
    let (code, out, err) = run(&home, None, &["validate"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(
        out.contains("  ℹ 알 수 없는 키 2개 (실패가 아닙니다): futureKey, zKey\n"),
        "{out}"
    );
}

// FR-CFG-15: 깨진 server.json 은 막지 않는다.
#[test]
fn show_survives_corrupt_server_json() {
    let (_d, home) = temp_home();
    write_server_json(&home, "{nope");
    let (code, out, err) = run(&home, None, &["show"]);
    assert_eq!(code, 0);
    assert!((out + &err).contains("server.json"));
}

#[test]
fn validate_clean_passes() {
    let (_d, home) = temp_home();
    write_settings_json(&home, r#"{"tabWidthPx":200,"themeName":"hi"}"#);
    write_server_json(&home, r#"{"port":"8080"}"#);
    let (code, out, err) = run(&home, None, &["validate"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("서버 기동값: 정상\n"), "{out}");
}

// 깨진 settings.json 은 오류다 — stderr 로 간다.
#[test]
fn validate_corrupt_settings_is_error() {
    let (_d, home) = temp_home();
    write_settings_json(&home, "{");
    let (code, _, err) = run(&home, None, &["validate"]);
    assert_eq!(code, 1);
    assert!(err.starts_with("✗ settings.json: "), "{err}");
}

// 읽을 수 없는 settings.json 은 경고다. 디렉터리면 Go 는 read 단계에서 실패한다.
#[cfg(unix)]
#[test]
fn unreadable_settings_is_warning() {
    let (_d, home) = temp_home();
    std::fs::create_dir(home.join("settings.json")).unwrap();
    let (code, out, _) = run(&home, None, &["validate"]);
    assert_eq!(code, 0);
    let p = home.join("settings.json");
    assert!(
        out.contains(&format!(
            "⚠ settings.json 을 읽지 못했습니다: read {}: is a directory\n",
            p.display()
        )),
        "{out}"
    );
}

#[test]
fn unknown_subcommand() {
    assert!(parse_config(&args(&["nope"])).is_err());
}

// FR-HRB-2: 파일의 틀린 포트는 막지 않고 경고한다.
#[test]
fn validate_warns_bad_file_port() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"port":"abc"}"#);
    let (code, out, err) = run(&home, None, &["validate"]);
    assert_eq!(code, 0, "{err}");
    assert!(out.contains("port") && out.contains("abc"), "{out}");
}

// ── set|get (HOT_REBIND_SRS FR-HRB-41·42·43) ──

#[test]
fn parse_set_get() {
    for ok in [
        &["set", "port", "9100"][..],
        &["set", "expose", "on"],
        &["set", "expose", "off"],
        &["get"],
    ] {
        assert!(parse_config(&args(ok)).is_ok(), "{ok:?}");
    }
    for bad in [
        &["set"][..],
        &["set", "port"],
        &["set", "port", "80"],
        &["set", "port", "abc"],
        &["set", "expose", "maybe"],
        &["set", "host", "1.2.3.4"],
        &["get", "port"],
        &["show", "x"],
    ] {
        assert!(parse_config(&args(bad)).is_err(), "{bad:?}");
    }
}

// TC-HRB-12: 서버가 돌고 있지 않으면 server.json 만 고친다.
#[test]
fn set_without_server() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"logLevel":"debug"}"#);
    let (code, out, err) = run(&home, None, &["set", "port", "9100"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        out,
        "서버가 돌고 있지 않아 server.json 만 고쳤습니다 — 다음 기동부터 씁니다\n"
    );
    let m = read_server_json(&home);
    assert_eq!(m["port"], "9100");
    assert_eq!(m["logLevel"], "debug");

    let (_, _, err) = run(&home, None, &["set", "expose", "on"]);
    assert_eq!(read_server_json(&home)["host"], EXPOSE_HOST);
    assert!(err.starts_with("⚠ 인증이 없습니다"), "{err}");
    let (_, _, err) = run(&home, None, &["set", "expose", "off"]);
    assert_eq!(read_server_json(&home)["host"], DEFAULT_HOST);
    assert_eq!(err, "");
}

// TC-HRB-12: 서버가 돌고 있으면 리바인드 API 를 부르고 server.json 은 건드리지 않는다.
#[test]
fn set_with_server_calls_api() {
    let (_d, home) = temp_home();
    let srv = FakeServer::start(
        200,
        r#"{"host":"0.0.0.0","port":"9100","expose":true,"url":"http://127.0.0.1:9100","warning":"인증이 없습니다"}"#,
    );
    serverconf::write_addr(&home, &srv.addr).unwrap();

    let (code, out, err) = run(&home, None, &["set", "port", "9100"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(srv.bodies(), vec![r#"{"port":9100}"#.to_owned()]);
    assert_eq!(
        out,
        "✅ 바인드 0.0.0.0:9100 (expose 켜짐) — http://127.0.0.1:9100\n"
    );
    assert_eq!(err, "⚠ 인증이 없습니다\n");

    run(&home, None, &["set", "expose", "off"]);
    assert_eq!(srv.bodies()[1], r#"{"expose":false}"#);
    assert!(
        read_server_json(&home).is_empty(),
        "서버가 있는데 server.json 을 고쳤다"
    );
}

// FR-HRB-43: API 의 오류 코드를 사람 말로 보인다.
#[test]
fn set_shows_human_error() {
    let (_d, home) = temp_home();
    let srv = FakeServer::start(
        409,
        r#"{"code":"bind_port_in_use","message":"rebind failed"}"#,
    );
    serverconf::write_addr(&home, &srv.addr).unwrap();
    let (code, _, err) = run(&home, None, &["set", "port", "9100"]);
    assert_eq!(code, 1);
    assert_eq!(
        err,
        "❌ 그 포트를 다른 프로세스가 쓰고 있습니다 — 바인드는 그대로입니다\n"
    );
}

// 모르는 오류 코드는 서버의 문구와 상태 코드를 그대로 싣는다.
#[test]
fn set_shows_unknown_error_code() {
    let (_d, home) = temp_home();
    let srv = FakeServer::start(500, r#"{"code":"x","message":"boom"}"#);
    serverconf::write_addr(&home, &srv.addr).unwrap();
    let (code, _, err) = run(&home, None, &["set", "expose", "on"]);
    assert_eq!(code, 1);
    assert_eq!(err, "❌ boom (500)\n");
}

// FR-HRB-42: get 은 지금 바인드와 server.json 의 값을 함께 보인다.
#[test]
fn get() {
    let (_d, home) = temp_home();
    write_server_json(&home, r#"{"port":"9200"}"#);
    let (code, out, _) = run(&home, None, &["get"]);
    assert_eq!(code, 0);
    assert_eq!(
        out,
        "지금 바인드: 서버가 돌고 있지 않습니다\nserver.json: host 127.0.0.1 (default) · port 9200 (file)\n"
    );
    let srv = FakeServer::start(200, "");
    serverconf::write_addr(&home, &srv.addr).unwrap();
    let (_, out, _) = run(&home, None, &["get"]);
    assert!(
        out.starts_with(&format!("지금 바인드: {} (expose 꺼짐)\n", srv.addr)),
        "{out}"
    );
}
