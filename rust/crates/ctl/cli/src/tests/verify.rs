//! verify_test.go — 격리 가드·옵션·검사 목록·능력 질의·보고자 (E2E_UNIFICATION_SRS).

use std::path::MAIN_SEPARATOR_STR as SEP;

use dm_shared_dmenv as dmenv;

use super::{Vars, args, with_env};
use crate::options::{ParseError, parse_verify};
use crate::report::CheckReport;
use crate::start::{ISOLATED_HOME_PREFIX, resolve_start_target};
use crate::verify::{
    VerifyCaps, VerifySession, extract_script_srcs, guard_isolated, json_quote, json_string_field,
    need_git_repo, need_tool, query_escape, verify_checks, verify_summary,
};

/// 이 OS 의 절대경로다 (Go `testpath.Abs`).
fn abs(parts: &[&str]) -> String {
    let root = if cfg!(windows) { "C:\\" } else { "/" };
    format!("{root}{}", parts.join(SEP))
}

// ── 격리 가드 (FR-E2G-1/2) ──

#[test]
fn guard_accepts_isolated_target() {
    let home = abs(&["tmp", &format!("{ISOLATED_HOME_PREFIX}abc123")]);
    assert_eq!(guard_isolated(&home, "51234", &abs(&["home", "u"])), Ok(()));
}

#[test]
fn guard_rejects_dangerous_targets() {
    let user = abs(&["home", "u"]);
    let iso = abs(&["tmp", &format!("{ISOLATED_HOME_PREFIX}abc123")]);
    let user_default = format!("{user}{SEP}{}", dmenv::DEFAULT_HOME_DIR);
    let cases = [
        ("빈 홈", String::new(), "51234", "격리 홈이 비어"),
        ("빈 포트", iso.clone(), "", "포트가 비어"),
        (
            "격리 표지 없는 홈",
            abs(&["tmp", "something"]),
            "51234",
            "격리 홈이 아닙니다",
        ),
        (
            "사용자 기본 홈",
            user_default,
            "51234",
            "격리 홈이 아닙니다",
        ),
        ("기본 포트", iso, dmenv::DEFAULT_PORT, "기본 포트"),
        (
            "접두사가 중간에만 있는 홈",
            abs(&["tmp", &format!("x-{ISOLATED_HOME_PREFIX}y")]),
            "51234",
            "격리 홈이 아닙니다",
        ),
    ];
    for (name, home, port, want) in cases {
        let err = guard_isolated(&home, port, &user).expect_err(name);
        assert!(err.contains(want), "{name}: {err}");
    }
}

#[test]
fn guard_clean_user_default_home() {
    // 격리 접두사가 붙은 사용자 기본 홈 자리는 없으므로, 이 조항은 접두사를 단 홈 이름으로 본다.
    let user = abs(&["home", "u"]);
    let home = format!("{user}{SEP}{ISOLATED_HOME_PREFIX}x");
    assert_eq!(guard_isolated(&home, "51234", &user), Ok(()));
    assert_eq!(
        guard_isolated(&abs(&["tmp", "plain"]), "51234", ""),
        Err(format!(
            "홈이 격리 홈이 아닙니다: {}",
            abs(&["tmp", "plain"])
        ))
    );
}

#[test]
fn guard_unknown_user_home_keeps_other_clauses() {
    let iso = abs(&["tmp", &format!("{ISOLATED_HOME_PREFIX}abc")]);
    assert_eq!(
        guard_isolated(&iso, dmenv::DEFAULT_PORT, ""),
        Err(format!(
            "포트가 기본 포트 {} 입니다 — 운영 인스턴스일 수 있습니다",
            dmenv::DEFAULT_PORT
        ))
    );
    assert!(guard_isolated(&abs(&["tmp", "plain"]), "51234", "").is_err());
}

// resolve_start_target 이 만드는 홈이 가드를 실제로 통과해야 한다.
#[test]
fn guard_accepts_what_resolve_start_target_makes() {
    let o = crate::options::StartOpts {
        isolated: true,
        ..Default::default()
    };
    let (home, port) = with_env(&Vars::new(&[]), |env| resolve_start_target(&o, env)).unwrap();
    let res = guard_isolated(&home, &port, &abs(&["home", "u"]));
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(res, Ok(()));
}

// ── 옵션 (FR-E2C-2/3/5) ──

#[test]
fn parse_rejects_port_and_home() {
    for a in ["--port", "--home"] {
        match parse_verify(&args(&[a, "58146"])) {
            Err(ParseError::Invalid(m)) => assert!(m.contains("격리 인스턴스"), "{m}"),
            other => panic!("{a}: {other:?}"),
        }
    }
}

#[test]
fn parse_repo() {
    for a in [&["--repo", "/x/y"][..], &["--repo=/x/y"][..]] {
        assert_eq!(parse_verify(&args(a)).unwrap().repo, "/x/y");
    }
    assert!(parse_verify(&args(&["--repo"])).is_err());
}

#[test]
fn parse_help_and_unknown() {
    assert!(matches!(
        parse_verify(&args(&["--help"])),
        Err(ParseError::Help)
    ));
    assert!(parse_verify(&args(&["--nope"])).is_err());
}

#[test]
fn action_is_listed() {
    assert!(crate::action_names().contains(&"verify"));
    let (code, out, _) = super::dispatch(&["verify", "--help"]);
    assert_eq!(code, 0);
    assert!(out.contains("dongminal verify"), "{out}");
}

// ── 검사 목록 (FR-E2K-1 · FR-E2I-6) — 골든이 자물쇠다 ──

const GOLDEN: [&str; 26] = [
    "기동 표면|서버 프로세스 생존",
    "기동 표면|데몬 종단 생성 (paned.sock)",
    "기동 표면|/api/ping",
    "도구 — PTY + IPC 왕복|도구 생성",
    "도구 — PTY + IPC 왕복|/api/state 에 도구가 보인다",
    "도구 — PTY + IPC 왕복|busy 조회",
    "도구 — PTY + IPC 왕복|도구 출력 조회",
    "도구 — PTY + IPC 왕복|입력→출력 왕복",
    "워크스페이스·설정|/api/workspace",
    "워크스페이스·설정|/api/stats",
    "워크스페이스·설정|/api/settings",
    "git 읽기 표면|검사 대상 저장소 등록",
    "git 읽기 표면|git status",
    "git 읽기 표면|git log",
    "git 읽기 표면|git refs",
    "git 읽기 표면|git signature",
    "git 읽기 표면|git stash",
    "git 읽기 표면|git records",
    "git 읽기 표면|git policy",
    "git 읽기 표면|git jobs",
    "git 읽기 표면|없는 git 경로 404",
    "정적 자산|index.html 의 script 전량 200",
    "정적 자산|구 평면 경로 /js/app.js 404",
    "경계|상대경로 400",
    "경계|읽기 상한 초과 413",
    "경계|정적 응답의 보안 헤더",
];

#[test]
fn checks_golden() {
    let got: Vec<String> = verify_checks()
        .iter()
        .map(|c| format!("{}|{}", c.section, c.name))
        .collect();
    assert_eq!(got, GOLDEN);
}

#[test]
fn every_check_is_named() {
    for c in verify_checks() {
        assert!(!c.name.is_empty() && !c.section.is_empty());
    }
}

// 구획은 이어져 있어야 한다 — 흩어지면 같은 머리말이 두 번 찍힌다.
#[test]
fn sections_are_contiguous() {
    let mut seen = Vec::new();
    let mut prev = "";
    for c in verify_checks() {
        if c.section == prev {
            continue;
        }
        assert!(
            !seen.contains(&c.section),
            "구획 {} 가 흩어져 있다",
            c.section
        );
        seen.push(c.section);
        prev = c.section;
    }
}

// ── 능력 질의 (FR-E2S-3/4) ──

#[test]
fn need_git_repo_reports_why() {
    let repo = abs(&["x"]);
    let s = |caps| VerifySession {
        caps,
        repo: repo.clone(),
        ..VerifySession::default()
    };
    assert_eq!(
        need_git_repo(&s(VerifyCaps::default())),
        (false, "git 이 PATH 에 없다".to_owned())
    );
    assert_eq!(
        need_git_repo(&s(VerifyCaps {
            git_bin: true,
            git_repo: false
        })),
        (false, format!("대상이 git 저장소가 아니다: {repo}"))
    );
    assert!(
        need_git_repo(&s(VerifyCaps {
            git_bin: true,
            git_repo: true
        }))
        .0
    );
}

#[test]
fn need_tool_skips_when_creation_failed() {
    let (ok, why) = need_tool(&VerifySession::default());
    assert!(!ok);
    assert!(why.contains("도구 생성"), "{why}");
    let s = VerifySession {
        tool_id: "t1".to_owned(),
        ..VerifySession::default()
    };
    assert!(need_tool(&s).0);
}

// 검사 목록에 OS 를 근거로 한 조건이 하나도 없어야 한다 (FR-E2S-2).
#[test]
fn no_os_driven_skips() {
    let s = VerifySession {
        caps: VerifyCaps {
            git_bin: true,
            git_repo: true,
        },
        tool_id: "t1".to_owned(),
        repo: abs(&["r"]),
        ..VerifySession::default()
    };
    for c in verify_checks() {
        if let Some(need) = c.need {
            let (ok, why) = need(&s);
            assert!(ok, "{}: 갖춰진 호스트인데 건너뛴다 — {why}", c.name);
        }
    }
}

// ── 정적 자산 추출 (FR-E2K-3) ──

#[test]
fn extract_script_srcs_cases() {
    let html = r#"<!doctype html><html><head>
<script src="js/core/app.js"></script>
<script type="module" src="js/git/panel.js"></script>
<script src="js/core/app.js"></script>
<script src="https://cdn.example.com/x.js"></script>
<script>inline()</script>
</head></html>"#;
    assert_eq!(
        extract_script_srcs(html),
        ["js/core/app.js", "js/git/panel.js"]
    );
    assert!(extract_script_srcs("<html></html>").is_empty());
}

// ── JSON·URL 도우미 ──

#[test]
fn json_quote_escapes_backslash() {
    assert_eq!(json_quote(r"C:\Users\me"), r#""C:\\Users\\me""#);
    assert_eq!(json_quote(r#"a"b"#), r#""a\"b""#);
    assert_eq!(json_quote("a\nb\tc\r"), r#""a\nb\tc\r""#);
}

#[test]
fn json_string_field_cases() {
    let blob = r#"{"ok":true,"id":"t-42","name":"a\"b"}"#;
    assert_eq!(json_string_field(blob, "id"), "t-42");
    assert_eq!(json_string_field(blob, "name"), r#"a\"b"#);
    assert_eq!(json_string_field(blob, "없음"), "");
}

#[test]
fn query_escape_matches_go() {
    assert_eq!(
        query_escape("/a b/c+d?e=f&g~h_i.j-k"),
        "%2Fa+b%2Fc%2Bd%3Fe%3Df%26g~h_i.j-k"
    );
    assert_eq!(query_escape("홈"), "%ED%99%88");
}

// ── 보고자 (FR-E2R-2/4) ──

#[test]
fn skip_is_not_failure() {
    let mut out = Vec::new();
    let mut r = CheckReport::new(&mut out);
    r.ok("통과");
    r.skipped("건너뛴 것", "이유가 있다");
    let (fail, skip) = (r.fail, r.skip);
    drop(r);
    assert_eq!((fail, skip), (0, 1));
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "  ✅ 통과\n  ⏭  건너뛴 것 — 이유가 있다\n"
    );
}

#[test]
fn summary_skip_only_exits_zero() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().to_str().unwrap();
    let mut out = Vec::new();
    let mut r = CheckReport::new(&mut out);
    r.skipped("a", "이유");
    assert_eq!(verify_summary(&mut r, 3, home, ""), 0);
    drop(r);
    assert!(
        String::from_utf8(out)
            .unwrap()
            .ends_with("통과 3건 / 실패 0건 / 건너뜀 1건\n")
    );

    let mut out = Vec::new();
    let mut r = CheckReport::new(&mut out);
    r.bad("x — 깨짐");
    assert_eq!(verify_summary(&mut r, 0, home, ""), 1);
    drop(r);
    assert!(
        String::from_utf8(out)
            .unwrap()
            .ends_with("통과 0건 / 실패 1건 / 건너뜀 0건\n실패 항목:\n  ❌ x — 깨짐\n")
    );
}
