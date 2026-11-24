//! SERVER_DRIVEN_ACTIONS_SRS K-j · TC-SDA-11 — 두 벌의 대조 게이트를 탐침한다 (Go `check_test.go`).

use std::path::PathBuf;

use crate::check::{
    LOCALES, NEEDED, RS_LSP_WS, RS_OPERATION, RS_PREFLIGHT, RS_WORKSPACE, Sources, check,
    js_consts, js_object_keys, rust_consts, set_diff,
};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

fn repo_sources() -> Sources {
    let root = repo_root();
    let mut s = Sources {
        indicator_kinds: otter_webserver_domain_git_jobs::indicator_kinds(),
        ..Sources::default()
    };
    for p in NEEDED {
        s.files
            .insert(p.to_owned(), std::fs::read_to_string(root.join(p)).unwrap());
    }
    for l in LOCALES {
        let p = root.join(format!("web/js/i18n/{l}.js"));
        s.locales
            .insert(l.to_owned(), std::fs::read_to_string(p).unwrap());
    }
    s
}

#[test]
fn repo_is_consistent() {
    let got = check(&repo_sources());
    assert!(
        got.is_empty(),
        "지금 저장소에서 어긋남이 났다:\n{}",
        got.join("\n")
    );
}

// 한쪽만 바꾸면 실패한다. 바꾼 짝의 ID 가 문구에 있어야 한다.
#[test]
fn probes_each_pair() {
    let cases: &[(&str, &str, &str, &str)] = &[
        (
            "K9",
            "web/js/core/constants-git-changes.js",
            "bisect_in_progress:'bisect'",
            "bisect_running:'bisect'",
        ),
        (
            "K9",
            RS_PREFLIGHT,
            r#"pub const BLOCK_BISECT_IN_PROGRESS: &str = "bisect_in_progress";"#,
            "pub const BLOCK_BISECT_IN_PROGRESS: &str = \"bisect_in_progress\";\npub const BLOCK_SEQUENCER_IN_PROGRESS: &str = \"sequencer_in_progress\";",
        ),
        (
            "K10",
            "web/js/core/constants-git-actions.js",
            "const GIT_OP_CHERRY='cherry-pick';",
            "const GIT_OP_CHERRY='cherry';",
        ),
        (
            "K10",
            RS_OPERATION,
            r#"pub const OP_BISECT: &str = "bisect";"#,
            "pub const OP_BISECT: &str = \"bisect\";\npub const OP_SEQUENCER: &str = \"sequencer\";",
        ),
        (
            "K12",
            "web/js/core/constants-editor.js",
            "const LSP_WS_CLOSE_START=4002;",
            "const LSP_WS_CLOSE_START=4012;",
        ),
        (
            "K12",
            RS_LSP_WS,
            "const LSP_WS_CLOSE_ENDED: u16 = 4003;",
            "const LSP_WS_CLOSE_ENDED: u16 = 4004;",
        ),
        (
            "K13",
            "web/js/core/constants.js",
            "const WS_SCHEMA_VERSION=2;",
            "const WS_SCHEMA_VERSION=3;",
        ),
        (
            "K13",
            RS_WORKSPACE,
            "pub const SCHEMA_VERSION: i64 = 2;",
            "pub const SCHEMA_VERSION: i64 = 3;",
        ),
        // 읽지 못하는 식은 조용히 넘기지 않는다.
        (
            "K13",
            RS_WORKSPACE,
            "pub const SCHEMA_VERSION: i64 = 2;",
            "pub const SCHEMA_VERSION: i64 = BASE + 1;",
        ),
        // 상수가 사라져도 실패한다.
        (
            "K13",
            "web/js/core/constants.js",
            "const WS_SCHEMA_VERSION=2;",
            "const WS_SCHEMA_VER=2;",
        ),
    ];
    for (id, file, old, new) in cases {
        let mut s = repo_sources();
        let src = s.files.get_mut(*file).unwrap();
        assert!(
            src.contains(old),
            "탐침 자리 {old:?} 가 {file} 에 없다 — 시험을 고쳐라"
        );
        *src = src.replacen(old, new, 1);
        let got = check(&s);
        assert!(!got.is_empty(), "{id} {file}: 바꿨는데 게이트가 통과했다");
        assert!(
            got.join("\n").contains(id),
            "{file}: 문구에 {id} 가 없다: {got:?}"
        );
    }
}

// K-h 덧붙임: 표시기에 서는 잡 종류마다 ko·en 라벨이 있다.
#[test]
fn probes_job_kind_labels() {
    let mut s = repo_sources();
    s.indicator_kinds.push("squash-merge".into());
    let got = check(&s).join("\n");
    for want in [
        "ko: git.job_kind.squash_merge",
        "en: git.job_kind.squash_merge",
    ] {
        assert!(got.contains(want), "{want:?} 가 없다: {got}");
    }
}

#[test]
fn rust_consts_reads_literals_and_durations() {
    let src = r#"use std::time::Duration;
pub const A: &str = "a";
pub(crate) const B: u16 = 42;
const C: Duration = Duration::from_secs(15);
pub const D: Duration = Duration::from_millis(250);
const E: std::time::Duration = std::time::Duration::from_mins(1);
const F: i64 = OTHER + 1;
const G: i64 = 1_000i64;
const H: &str = "q\"x";
"#;
    let (vals, bad) = rust_consts(src);
    for (k, v) in [
        ("A", "a"),
        ("B", "42"),
        ("C", "15000"),
        ("D", "250"),
        ("E", "60000"),
        ("G", "1000"),
        ("H", "q\"x"),
    ] {
        assert_eq!(vals.get(k).map(String::as_str), Some(v), "{k}");
    }
    assert!(
        bad.contains_key("F"),
        "읽지 못하는 식 F 가 bad 에 없다: {bad:?}"
    );
}

#[test]
fn js_consts_and_keys() {
    let src = "const A='x';\nconst B=4001;\n  const C=\"y\"; // c\nconst OBJ={a_b:'1',\n  // 주석: z:'no'\n  'c-d':'2', e:'3'};\n";
    let got = js_consts(src);
    assert_eq!(got.get("A").map(String::as_str), Some("x"));
    assert_eq!(got.get("B").map(String::as_str), Some("4001"));
    assert_eq!(got.get("C").map(String::as_str), Some("y"));
    assert_eq!(js_object_keys(src, "OBJ").unwrap(), ["a_b", "c-d", "e"]);
    assert!(js_object_keys(src, "NOPE").is_none(), "없는 객체를 찾았다");
}

// Go `%v` 와 같은 모양으로 차이를 낸다.
#[test]
fn set_diff_formats_like_go() {
    let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(set_diff(&v(&["a", "b"]), &v(&["b", "a"])), "");
    assert_eq!(
        set_diff(&v(&["c", "a", "b"]), &v(&["b", "d"])),
        "서버에만 [a c], 화면에만 [d]"
    );
    assert_eq!(set_diff(&v(&["a"]), &v(&[])), "서버에만 [a], 화면에만 []");
}
