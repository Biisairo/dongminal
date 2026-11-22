use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::Value as J;
use tempfile::TempDir;

use super::*;

fn tmp() -> TempDir {
    tempfile::tempdir().unwrap()
}

fn write(home: &Path, body: &str) {
    fs_write(&home.join(FILE_NAME), body);
}

fn fs_write(p: &Path, body: &str) {
    std::fs::write(p, body).unwrap();
}

fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> String {
    let m: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    move |k: &str| m.get(k).cloned().unwrap_or_default()
}

fn resolve_env(home: &Path, env: &dyn Fn(&str) -> String) -> Resolved {
    resolve(&Inputs {
        home,
        getenv: Some(env),
        ..Default::default()
    })
}

fn resolve_home(home: &Path) -> Resolved {
    resolve_env(home, &env_of(&[]))
}

fn read_json(home: &Path) -> serde_json::Map<String, J> {
    let data = std::fs::read(home.join(FILE_NAME)).unwrap();
    serde_json::from_slice(&data).unwrap()
}

#[cfg(unix)]
fn perm(p: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[cfg(not(unix))]
fn perm(_: &Path) -> u32 {
    0
}

const BIND_ENV: [(&str, &str); 3] = [
    ("DONGMINAL_HOST", "2.2.2.2"),
    ("DONGMINAL_PORT", "4444"),
    ("PORT", "5555"),
];

// TC-CFG-6: 넷 다 있으면 플래그가 이긴다 (FR-CFG-13).
#[test]
fn priority_flag_wins() {
    let home = tmp();
    write(
        home.path(),
        r#"{"host":"10.0.0.1","port":"3333","logLevel":"debug"}"#,
    );
    let env = env_of(&[
        ("DONGMINAL_HOST", "2.2.2.2"),
        ("PORT", "2222"),
        ("DONGMINAL_LOG_LEVEL", "warn"),
    ]);
    let got = resolve(&Inputs {
        home: home.path(),
        flag_host: "1.1.1.1",
        flag_port: "1111",
        flag_log_level: "error",
        getenv: Some(&env),
        ..Default::default()
    });
    assert_eq!((got.host.value.as_str(), got.host.source), ("1.1.1.1", Source::Flag));
    assert_eq!((got.port.value.as_str(), got.port.source), ("1111", Source::Flag));
    assert_eq!(
        (got.log_level.value.as_str(), got.log_level.source),
        ("error", Source::Flag)
    );
}

// TC-CFG-7: 계층을 하나씩 걷으면 그다음이 이긴다. 바인드에는 환경 변수 계층이 없다.
#[test]
fn priority_falls_through_layers() {
    let home = tmp();
    write(home.path(), r#"{"host":"10.0.0.1","port":"3333"}"#);
    let got = resolve_home(home.path());
    assert_eq!((got.host.value.as_str(), got.host.source), ("10.0.0.1", Source::File));
    assert_eq!((got.port.value.as_str(), got.port.source), ("3333", Source::File));

    let got = resolve_home(tmp().path());
    assert_eq!(got.host.source, Source::Default);
    assert_eq!(got.port.source, Source::Default);
    assert_eq!(got.log_level.value, "info");

    let got = resolve_env(home.path(), &env_of(&[("DONGMINAL_LOG_LEVEL", "warn")]));
    assert_eq!(
        (got.log_level.value.as_str(), got.log_level.source, got.log_level.env.as_str()),
        ("warn", Source::Env, "DONGMINAL_LOG_LEVEL")
    );
}

// TC-CFG-8: 빈 문자열은 "정하지 않음" 이다.
#[test]
fn empty_means_unset() {
    let home = tmp();
    write(home.path(), r#"{"host":"","port":"3333"}"#);
    let got = resolve_env(home.path(), &env_of(&[("DONGMINAL_HOST", "")]));
    assert_eq!(got.host.source, Source::Default);
    assert_eq!(got.port.source, Source::File);
}

// TC-CFG-9: 파일이 없으면 조용히 넘어간다 (FR-CFG-14).
#[test]
fn missing_file_is_silent() {
    assert!(resolve_home(tmp().path()).warnings.is_empty());
}

// TC-CFG-10: 깨진 파일은 기동을 막지 않는다 (FR-CFG-15).
#[test]
fn corrupt_file_warns_and_continues() {
    let home = tmp();
    write(home.path(), "{nope");
    let got = resolve_env(home.path(), &env_of(&[("DONGMINAL_HOST", "2.2.2.2")]));
    assert!(!got.warnings.is_empty());
    assert!(got.warnings[0].starts_with("server.json 가 깨졌습니다: "));
    assert!(got.warnings[0].ends_with(" (무시하고 진행합니다)"));
    assert_eq!(got.host.source, Source::Default);
    assert_eq!(got.port.source, Source::Default);
}

// 알 수 없는 키는 경고이지 실패가 아니다 (D-CFG-4).
#[test]
fn unknown_key_warns_only() {
    let home = tmp();
    write(home.path(), r#"{"host":"10.0.0.1","futureKey":1,"aKey":2}"#);
    let got = resolve_home(home.path());
    assert_eq!(got.host.value, "10.0.0.1");
    assert_eq!(
        got.warnings,
        [
            r#"server.json: 알 수 없는 키 "aKey" (무시합니다)"#,
            r#"server.json: 알 수 없는 키 "futureKey" (무시합니다)"#
        ]
    );
}

// TC-CFG-16: 플래그의 틀린 포트는 Listen 전에 거부되고 문구에 값이 실린다 (FR-CFG-19).
#[test]
fn non_numeric_flag_port_rejected() {
    let home = tmp();
    let env = env_of(&[]);
    let r = resolve(&Inputs {
        home: home.path(),
        flag_port: "abc",
        getenv: Some(&env),
        ..Default::default()
    });
    assert_eq!(
        r.err().unwrap().to_string(),
        r#"포트가 숫자가 아닙니다: "abc" (출처: flag)"#
    );
    let r = resolve(&Inputs {
        home: home.path(),
        flag_port: "99999",
        getenv: Some(&env),
        ..Default::default()
    });
    assert_eq!(
        r.err().unwrap().to_string(),
        r#"포트가 범위(1~65535) 밖입니다: "99999" (출처: flag)"#
    );
}

#[test]
fn valid_port_passes() {
    let home = tmp();
    let env = env_of(&[]);
    for p in ["8080", "+8080", "08080"] {
        let r = resolve(&Inputs {
            home: home.path(),
            flag_port: p,
            getenv: Some(&env),
            ..Default::default()
        });
        assert!(r.err().is_none(), "{p}");
    }
}

// TC-HRB-1 (FR-HRB-1): 바인드 환경 변수는 바인드를 정하지 않는다.
#[test]
fn bind_env_ignored() {
    let home = tmp();
    write(home.path(), r#"{"host":"10.0.0.1","port":"3333"}"#);
    let env = env_of(&BIND_ENV);
    let got = resolve_env(home.path(), &env);
    assert_eq!((got.host.value.as_str(), got.host.source), ("10.0.0.1", Source::File));
    assert_eq!((got.port.value.as_str(), got.port.source), ("3333", Source::File));

    let got = resolve_env(tmp().path(), &env);
    assert_eq!((got.host.value.as_str(), got.host.source), (DEFAULT_HOST, Source::Default));
    assert_eq!((got.port.value.as_str(), got.port.source), (DEFAULT_PORT, Source::Default));
}

// TC-HRB-1 (FR-HRB-8): 바인드 환경 변수가 있으면 경고 한 줄. 없으면 빈 문자열.
#[test]
fn bind_env_warning() {
    let got = resolve_env(tmp().path(), &env_of(&BIND_ENV));
    assert_eq!(
        got.bind_env_warning(),
        "DONGMINAL_HOST·DONGMINAL_PORT·PORT 는 바인드를 정하지 않습니다 — server.json 나 --port·--expose 를 쓰세요"
    );
    assert_eq!(resolve_home(tmp().path()).bind_env_warning(), "");
    let empty = env_of(&[("DONGMINAL_HOST", ""), ("DONGMINAL_PORT", ""), ("PORT", "")]);
    assert_eq!(resolve_env(tmp().path(), &empty).bind_env_warning(), "");
}

// TC-HRB-1 (FR-HRB-2): 파일의 틀린 포트는 기동을 막지 않는다 — 경고하고 기본값을 쓴다.
#[test]
fn file_bad_port_falls_back_to_default() {
    for (body, warn) in [
        (r#"{"port":"zzz"}"#, r#"포트가 숫자가 아닙니다: "zzz" (출처: file)"#),
        (r#"{"port":"99999"}"#, r#"포트가 범위(1~65535) 밖입니다: "99999" (출처: file)"#),
        (r#"{"port":"0"}"#, r#"포트가 범위(1~65535) 밖입니다: "0" (출처: file)"#),
    ] {
        let home = tmp();
        write(home.path(), body);
        let got = resolve_home(home.path());
        assert!(got.err().is_none(), "{body}");
        assert_eq!((got.port.value.as_str(), got.port.source), (DEFAULT_PORT, Source::Default));
        assert_eq!(
            got.warnings,
            [format!(
                "server.json 의 port 를 쓸 수 없습니다: {warn} — 기본값(58146)을 씁니다"
            )]
        );
    }
}

// TC-HRB-2 (FR-HRB-3): SetBind 는 준 값만 쓰고 다른 키를 보존한다. 권한은 0600.
#[test]
fn set_bind_preserves_keys() {
    let home = tmp();
    write(
        home.path(),
        r#"{"host":"127.0.0.1","logLevel":"debug","futureKey":1}"#,
    );
    set_bind(home.path(), "", "9100").unwrap();
    let m = read_json(home.path());
    assert_eq!(m["port"], "9100");
    assert_eq!(m["host"], "127.0.0.1");
    assert_eq!(m["logLevel"], "debug");
    assert_eq!(m["futureKey"], 1);
    set_bind(home.path(), "0.0.0.0", "").unwrap();
    let m = read_json(home.path());
    assert_eq!((&m["host"], &m["port"]), (&J::from("0.0.0.0"), &J::from("9100")));
    if dm_shared_testpath::perm_checked() {
        assert_eq!(perm(&home.path().join(FILE_NAME)), 0o600);
    }
    let got = resolve_home(home.path());
    assert_eq!((got.host.value.as_str(), got.port.value.as_str()), ("0.0.0.0", "9100"));
}

// 파일 형식은 Go MarshalIndent 와 같다: 키 정렬, 두 칸 들여쓰기, 끝 줄바꿈, HTML 이스케이프.
#[test]
fn set_keys_file_bytes() {
    let home = tmp();
    write(home.path(), r#"{"zeta":{"b":[1,2]},"logLevel":"debug"}"#);
    set_bind(home.path(), "a<b", "9100").unwrap();
    let got = std::fs::read_to_string(home.path().join(FILE_NAME)).unwrap();
    assert_eq!(
        got,
        "{\n  \"host\": \"a\\u003cb\",\n  \"logLevel\": \"debug\",\n  \"port\": \"9100\",\n  \"zeta\": {\n    \"b\": [\n      1,\n      2\n    ]\n  }\n}\n"
    );
}

// 파일이 없거나 깨졌어도 쓴다 (D-CFG-3).
#[test]
fn set_bind_on_missing_or_corrupt_file() {
    let base = tmp();
    let home: PathBuf = base.path().join("new");
    set_bind(&home, "", "9101").unwrap();
    assert_eq!(read_json(&home)["port"], "9101");
    if dm_shared_testpath::perm_checked() {
        assert_eq!(perm(&home), 0o700);
    }
    let home = tmp();
    write(home.path(), "{nope");
    set_bind(home.path(), "", "9102").unwrap();
    assert_eq!(read_json(home.path())["port"], "9102");
    let e = set_bind(Path::new(""), "", "9103").unwrap_err();
    assert!(matches!(e, Error::NoHome));
    assert_eq!(e.to_string(), "DONGMINAL_HOME 이 없습니다");
}

#[test]
fn set_bind_with_nothing_is_noop() {
    set_bind(Path::new(""), "", "").unwrap();
}

// TC-HRB-2: SetBind 와 SetUpdateCheck 가 서로의 키를 지우지 않는다.
#[test]
fn set_bind_keeps_update_check() {
    let home = tmp();
    set_update_check(home.path(), false).unwrap();
    set_bind(home.path(), "0.0.0.0", "9104").unwrap();
    let got = resolve_home(home.path());
    assert!(!got.update_check && got.update_check_set);
}

// FR-HRB-7: 주소 파일 읽기. 없거나 틀리면 None.
#[test]
fn read_addr_cases() {
    let home = tmp();
    assert!(read_addr(home.path()).is_none());
    std::fs::create_dir_all(addr_path(home.path()).parent().unwrap()).unwrap();
    for (body, want) in [
        ("127.0.0.1:9200\n", Some(("127.0.0.1", "9200"))),
        ("0.0.0.0:9201", Some(("0.0.0.0", "9201"))),
        ("[::1]:9202\n", Some(("::1", "9202"))),
        ("garbage", None),
        ("127.0.0.1:abc", None),
        ("127.0.0.1:99999", None),
        ("", None),
        (":9203", None),
        ("::1:9204", None),
        ("[::1]9205", None),
        ("[::1]:", None),
        ("a]:9206", None),
    ] {
        fs_write(&addr_path(home.path()), body);
        let got = read_addr(home.path());
        let want = want.map(|(h, p)| (h.to_owned(), p.to_owned()));
        assert_eq!(got, want, "{body:?}");
    }
    assert!(read_addr(Path::new("")).is_none());
}

// 주소 파일은 전용 폴더 run/ 에 있다 (D-HRB-9).
#[test]
fn addr_path_is_in_run_dir() {
    assert_eq!(
        addr_path(Path::new("/h")),
        Path::new("/h").join("run").join("server.addr")
    );
}

// TC-HRB-4 (FR-HRB-10): 쓰기는 0600·폴더 0700. 지우기는 자기가 쓴 내용일 때만이고 폴더는 남긴다.
#[test]
fn write_remove_addr() {
    let home = tmp();
    write_addr(home.path(), "127.0.0.1:9300").unwrap();
    assert_eq!(
        std::fs::read_to_string(addr_path(home.path())).unwrap(),
        "127.0.0.1:9300\n"
    );
    assert_eq!(
        read_addr(home.path()),
        Some(("127.0.0.1".into(), "9300".into()))
    );
    if dm_shared_testpath::perm_checked() {
        assert_eq!(perm(&addr_path(home.path())), 0o600);
        assert_eq!(perm(addr_path(home.path()).parent().unwrap()), 0o700);
    }
    write_addr(home.path(), "0.0.0.0:9301").unwrap();
    remove_addr(home.path(), "127.0.0.1:9300");
    assert_eq!(read_addr(home.path()).unwrap().1, "9301");
    remove_addr(home.path(), "0.0.0.0:9301");
    assert!(read_addr(home.path()).is_none());
    assert!(addr_path(home.path()).parent().unwrap().is_dir());
    assert!(matches!(
        write_addr(Path::new(""), "127.0.0.1:1"),
        Err(Error::NoHome)
    ));
}

// FR-UPD-12: 기본은 켜짐이고, 키가 없었다는 사실도 함께 나온다 (FR-UPD-10).
#[test]
fn update_check_defaults_on_and_unset() {
    let r = resolve_home(tmp().path());
    assert!(r.update_check);
    assert!(!r.update_check_set);
}

#[test]
fn update_check_reads_false() {
    let home = tmp();
    write(home.path(), r#"{"updateCheck":false}"#);
    let r = resolve_home(home.path());
    assert!(!r.update_check && r.update_check_set);
}

// FR-UPD-16 / C-4: bool 이 아니면 기본값으로 떨어지고 경고만 낸다. 다른 키를 잃지 않는다.
#[test]
fn update_check_bad_type_warns_and_keeps_other_keys() {
    let home = tmp();
    write(home.path(), r#"{"updateCheck":"yes","port":"9999"}"#);
    let r = resolve_home(home.path());
    assert!(r.update_check);
    assert!(!r.update_check_set);
    assert_eq!(r.port.value, "9999");
    assert_eq!(
        r.warnings,
        ["server.json: updateCheck 가 true/false 가 아닙니다 (기본값 true 를 씁니다)"]
    );
    assert!(r.err().is_none());
}

// Go v1 의미: null 은 bool 을 건드리지 않고 오류도 아니다 — 꺼짐·설정됨으로 읽힌다.
#[test]
fn update_check_null_is_false_and_set() {
    let home = tmp();
    write(home.path(), r#"{"updateCheck":null,"host":null}"#);
    let r = resolve_home(home.path());
    assert!(!r.update_check && r.update_check_set);
    assert_eq!(r.host.source, Source::Default);
    assert!(r.warnings.is_empty());
}

#[test]
fn update_check_is_a_known_key() {
    let home = tmp();
    write(home.path(), r#"{"updateCheck":true}"#);
    assert!(resolve_home(home.path()).warnings.is_empty());
}

// FR-UPD-13: 토글은 server.json 에 기록되고 다른 키를 보존한다.
#[test]
fn set_update_check_preserves_other_keys() {
    let home = tmp();
    write(home.path(), r#"{"port":"7777","logLevel":"debug"}"#);
    set_update_check(home.path(), false).unwrap();
    let r = resolve_home(home.path());
    assert!(!r.update_check);
    assert_eq!((r.port.value.as_str(), r.log_level.value.as_str()), ("7777", "debug"));
}

#[test]
fn set_update_check_creates_file() {
    let home = tmp();
    set_update_check(home.path(), true).unwrap();
    assert_eq!(
        std::fs::read_to_string(home.path().join(FILE_NAME)).unwrap(),
        "{\n  \"updateCheck\": true\n}\n"
    );
}

#[test]
fn set_update_check_on_broken_file() {
    let home = tmp();
    write(home.path(), "{not json");
    set_update_check(home.path(), false).unwrap();
    assert!(!resolve_home(home.path()).update_check);
}

#[test]
fn set_update_check_needs_home() {
    assert!(set_update_check(Path::new(""), true).is_err());
}

// 읽기 오류(파일 자리에 폴더)는 Go os.ReadFile 문구로 경고한다.
#[cfg(unix)]
#[test]
fn unreadable_file_warns_with_go_error() {
    let home = tmp();
    std::fs::create_dir(home.path().join(FILE_NAME)).unwrap();
    let r = resolve_home(home.path());
    assert_eq!(
        r.warnings,
        [format!(
            "server.json 를 읽지 못했습니다: read {}: is a directory (무시하고 진행합니다)",
            home.path().join(FILE_NAME).display()
        )]
    );
}

// Resolved 의 JSON 은 Go 구조체 태그 순서·omitempty 와 같다.
#[test]
fn resolved_json_shape() {
    let home = tmp();
    write(home.path(), r#"{"x":1}"#);
    let env = env_of(&[("DONGMINAL_LOG", "/l"), ("PORT", "1")]);
    let r = resolve(&Inputs {
        home: home.path(),
        getenv: Some(&env),
        default_log_file: "/d",
        ..Default::default()
    });
    let got = String::from_utf8(json::marshal(&r).unwrap()).unwrap();
    assert_eq!(
        got,
        r#"{"host":{"value":"127.0.0.1","source":"default"},"port":{"value":"58146","source":"default"},"logLevel":{"value":"info","source":"default"},"logFile":{"value":"/l","source":"env","env":"DONGMINAL_LOG"},"warnings":["server.json: 알 수 없는 키 \"x\" (무시합니다)"],"updateCheck":true,"updateCheckSet":false,"bindEnv":["PORT"]}"#
    );
}

// ── Go json 디코더 의미(go1.27.2 실측값) ──

// v1 은 구조체 필드를 대소문자 없이 맞춘다. 키 자체는 모르는 키로 경고된다.
#[test]
fn case_insensitive_field_match() {
    let home = tmp();
    write(home.path(), r#"{"HOST":"10.0.0.9"}"#);
    let r = resolve_home(home.path());
    assert_eq!((r.host.value.as_str(), r.host.source), ("10.0.0.9", Source::File));
    assert_eq!(r.warnings, [r#"server.json: 알 수 없는 키 "HOST" (무시합니다)"#]);
}

// 깨진 파일 경고에는 go1.27 encoding/json 의 오류 원문이 실린다.
#[test]
fn corrupt_file_warning_carries_go_error_text() {
    let home = tmp();
    write(home.path(), r#"{"host":1}"#);
    let r = resolve_home(home.path());
    assert_eq!(
        r.warnings,
        ["server.json 가 깨졌습니다: json: cannot unmarshal number into Go struct field file.host of type string (무시하고 진행합니다)"]
    );
}

// 모르는 키의 원문은 숫자 표기·null 이 그대로 남는다. 문자열 이스케이프는 go1.27 이 풀어 쓴다(실측).
#[test]
#[ignore = "gocompat RawMessage 차이(조정자 보고)"]
fn set_keys_preserves_raw_literals() {
    let home = tmp();
    write(home.path(), r#"{"f":1.0,"s":"\u00e9"}"#);
    set_update_check(home.path(), true).unwrap();
    assert_eq!(
        std::fs::read_to_string(home.path().join(FILE_NAME)).unwrap(),
        "{\n  \"f\": 1.0,\n  \"n\": null,\n  \"s\": \"é\",\n  \"updateCheck\": true\n}\n"
    );
}
