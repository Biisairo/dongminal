//! Go `handlers_git_ignore_test.go` 의 이식. fake 는 `stash.rs` 의 `StashFake`(Go `gitM5Fake`)다.
//!
//! 옮기지 않은 Go 테스트: 없다 (14개 전부 옮겼다).
//!
//! clean 의 경로 인자는 `:(literal)<경로>` 다 (DIFF-14) — 이 파일의 Go 기대도 이미 같다.

use std::collections::BTreeMap;
use std::path::Path;

use otter_webserver_apierr as apierr;
use tempfile::TempDir;

use super::harness::q;
use super::stash::{
    StashFake, call, clean_status, qrepo, stash_a, stash_b, stash_server, stash_two,
};

/// Go `gitIgnoreStatus`: untracked 하나를 가진 status 다.
fn ignore_status(path: &str) -> String {
    clean_status() + "? " + path + "\0"
}

/// Go `gitInitialStatus`: 커밋이 없는 저장소의 status 다.
fn initial_status() -> String {
    "# branch.oid (initial)\0# branch.head main\0".to_owned()
}

fn tmp_repo() -> (TempDir, String) {
    let d = TempDir::new().unwrap();
    let p = d.path().to_string_lossy().into_owned();
    (d, p)
}

fn joined(w: &[Vec<String>]) -> Vec<String> {
    w.iter().map(|a| a.join(" ")).collect()
}

// F1 (V200): 저장소 루트 밖을 대상으로 삼지 않는다. 쓰지 않고 400 이다.
#[tokio::test]
async fn api_git_ignore_rejects_escape() {
    let (_d, repo) = tmp_repo();
    for p in ["../outside.txt", "/etc/passwd", "src/../../x", ""] {
        let f = StashFake::new();
        let s = stash_server(&f);
        let (code, out) = call(
            &s,
            "POST",
            "/api/git/ignore",
            &format!(r#"{{"repo":{},"paths":["{p}"]}}"#, q(&repo)),
        )
        .await;
        assert_eq!(
            (code, out["error"].as_str()),
            (400, Some(apierr::CODE_IGNORE_PATH)),
            "{p:?}: {out}"
        );
        assert!(
            !Path::new(&repo).join(".gitignore").exists(),
            "{p:?} 로 .gitignore 가 만들어졌다"
        );
        assert!(f.wrote().is_empty(), "git 이 실행됐다: {:?}", f.wrote());
    }
}

// F2 (V200): 중복 줄을 더하지 않는다. 두 번째 응답의 added 는 비고 skipped 가 그 사실을 말한다.
#[tokio::test]
async fn api_git_ignore_no_duplicate() {
    let (_d, repo) = tmp_repo();
    let f = StashFake::new();
    let s = stash_server(&f);
    let body = format!(r#"{{"repo":{},"paths":["a.txt"]}}"#, q(&repo));

    let (code, out) = call(&s, "POST", "/api/git/ignore", &body).await;
    assert_eq!((code, &out["ok"]), (200, &serde_json::json!(true)), "{out}");
    assert_eq!(out["added"], serde_json::json!(["/a.txt"]), "{out}");

    let (code, out) = call(&s, "POST", "/api/git/ignore", &body).await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        out["added"].as_array().map_or(0, Vec::len),
        0,
        "added = {}",
        out["added"]
    );
    assert_eq!(out["skipped"], serde_json::json!(["/a.txt"]), "{out}");
    let b = std::fs::read_to_string(Path::new(&repo).join(".gitignore")).unwrap();
    assert_eq!(b, "/a.txt\n");
    // git 을 실행하지 않는다 (FR-GIT-273).
    for a in f.wrote() {
        assert_eq!(a[0], "status", "git 이 실행됐다: {:?}", f.wrote());
    }
}

// F3 (V203): Clean 은 `confirm:true` 없이 실행되지 않는다.
#[tokio::test]
async fn api_git_uncommitted_clean_requires_confirm() {
    let f = StashFake::new();
    f.lock().status = ignore_status("u.txt");
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/uncommitted/clean",
        &format!(r#"{{"repo":{}}}"#, qrepo()),
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (400, Some(apierr::CODE_CONFIRM_REQUIRED)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "확인 없이 실행됐다: {:?}", f.wrote());
}

// F4 (V203): Clean 은 `clean -q -f -d` 를 한 번 실행한다. `-x` 는 붙지 않는다.
// 경로는 `:(literal)` 이다 (DIFF-14).
#[tokio::test]
async fn api_git_uncommitted_clean() {
    let f = StashFake::new();
    f.lock().status = ignore_status("u.txt");
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/uncommitted/clean",
        &format!(r#"{{"repo":{},"confirm":true,"paths":["u.txt"]}}"#, qrepo()),
    )
    .await;
    assert_eq!((code, &out["ok"]), (200, &serde_json::json!(true)), "{out}");
    assert_eq!(
        joined(&f.wrote()),
        vec!["clean -q -f -d -- :(literal)u.txt"]
    );
}

// F4b (FR-GIT-277 개정): `paths` 가 없으면 400 이고 실행하지 않는다.
#[tokio::test]
async fn api_git_uncommitted_clean_requires_paths() {
    let cases = BTreeMap::from([
        ("없음", r#","confirm":true}"#),
        ("빈 배열", r#","confirm":true,"paths":[]}"#),
    ]);
    for (name, tail) in cases {
        let f = StashFake::new();
        f.lock().status = ignore_status("u.txt");
        let s = stash_server(&f);
        let (code, out) = call(
            &s,
            "POST",
            "/api/git/uncommitted/clean",
            &format!(r#"{{"repo":{}{tail}"#, qrepo()),
        )
        .await;
        assert_eq!(
            (code, out["error"].as_str()),
            (400, Some(apierr::CODE_BAD_REQUEST)),
            "{name}: {out}"
        );
        assert!(f.wrote().is_empty(), "{name}: 실행됐다: {:?}", f.wrote());
    }
}

// F4c (FR-GIT-277 개정): 확인한 목록과 지금의 untracked 가 다르면 409 stale_observation.
#[tokio::test]
async fn api_git_uncommitted_clean_changed_set() {
    let f = StashFake::new();
    f.lock().status = ignore_status("new.txt");
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/uncommitted/clean",
        &format!(r#"{{"repo":{},"confirm":true,"paths":["u.txt"]}}"#, qrepo()),
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (409, Some(apierr::CODE_STALE_OBSERVATION)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "실행됐다: {:?}", f.wrote());
}

// F5 (V203): 지울 것이 없으면 실행하지 않는다.
#[tokio::test]
async fn api_git_uncommitted_clean_nothing_to_clean() {
    let f = StashFake::new();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/uncommitted/clean",
        &format!(r#"{{"repo":{},"confirm":true,"paths":["u.txt"]}}"#, qrepo()),
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (409, Some(apierr::CODE_NOTHING_TO_CLEAN)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "실행됐다: {:?}", f.wrote());
}

// F6 (V203): Reset 은 mixed 이고 확인을 요구하지 않는다.
#[tokio::test]
async fn api_git_uncommitted_reset() {
    let f = StashFake::new();
    // `rev-parse --verify HEAD` 가 커밋을 답하게 한다.
    f.lock().branches.insert("HEAD".to_owned());
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/uncommitted/reset",
        &format!(r#"{{"repo":{}}}"#, qrepo()),
    )
    .await;
    assert_eq!((code, &out["ok"]), (200, &serde_json::json!(true)), "{out}");
    assert_eq!(joined(&f.wrote()), vec!["reset -q --mixed HEAD"]);
}

// F7 (V203): 커밋이 없으면 Reset 을 실행하지 않는다.
#[tokio::test]
async fn api_git_uncommitted_reset_no_head() {
    let f = StashFake::new();
    f.lock().status = initial_status();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/uncommitted/reset",
        &format!(r#"{{"repo":{}}}"#, qrepo()),
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (409, Some(apierr::CODE_NO_HEAD)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "실행됐다: {:?}", f.wrote());
}

fn stash_fake() -> StashFake {
    let f = StashFake::new();
    f.lock().stashes = stash_two();
    f
}

// F8 (V199): Branch from stash 는 `stash branch <name> <stash>` 를 실행한다.
#[tokio::test]
async fn api_git_stash_branch() {
    let f = stash_fake();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/stash/branch",
        &format!(
            r#"{{"repo":{},"oid":"{}","name":"feat/from-stash"}}"#,
            qrepo(),
            stash_b()
        ),
    )
    .await;
    assert_eq!((code, &out["ok"]), (200, &serde_json::json!(true)), "{out}");
    assert_eq!(
        joined(&f.wrote()),
        vec!["stash branch feat/from-stash stash@{1}"]
    );
}

// F9 (FR-GIT-250.3): 이름·지목은 실행 전에 본다.
#[tokio::test]
async fn api_git_stash_branch_rejects() {
    let a = stash_a();
    let r = qrepo();
    let cases = [
        format!(r#"{{"repo":{r},"oid":"{a}","name":""}}"#),
        format!(r#"{{"repo":{r},"oid":"{a}","name":"--force"}}"#),
        format!(r#"{{"repo":{r},"oid":"stash@{{0}}","name":"ok"}}"#),
        format!(r#"{{"repo":{r},"oid":"{a}","index":0,"name":"ok"}}"#),
        format!(r#"{{"repo":{r},"oid":"{a}","name":"bad name"}}"#),
    ];
    for body in &cases {
        let f = stash_fake();
        let s = stash_server(&f);
        let (code, out) = call(&s, "POST", "/api/git/stash/branch", body).await;
        assert_eq!(code, 400, "{body}: {out}");
        assert!(f.wrote().is_empty(), "{body}: 실행됐다 {:?}", f.wrote());
    }
}

// F10 (V199, REPO_FIX 01 §5.3): 목록에 없는 oid 는 409 stash_moved 이며 실행하지 않는다.
#[tokio::test]
async fn api_git_stash_branch_moved_oid() {
    let f = stash_fake();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/stash/branch",
        &format!(
            r#"{{"repo":{},"oid":"{}","name":"feat"}}"#,
            qrepo(),
            "d".repeat(40)
        ),
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (409, Some(apierr::CODE_STASH_MOVED)),
        "{out}"
    );
    assert!(f.wrote().is_empty(), "실행됐다: {:?}", f.wrote());
}

// §5.3: 이미 있는 브랜치 이름이면 실행 전 409 branch_exists — options 는 싣지 않는다.
#[tokio::test]
async fn api_git_stash_branch_existing_name_no_options() {
    let f = stash_fake();
    let s = stash_server(&f);
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/stash/branch",
        &format!(
            r#"{{"repo":{},"oid":"{}","name":"main"}}"#,
            qrepo(),
            stash_a()
        ),
    )
    .await;
    assert_eq!(
        (code, out["error"].as_str()),
        (409, Some(apierr::CODE_BRANCH_EXISTS)),
        "{out}"
    );
    assert!(out.get("options").is_none(), "options 가 실렸다: {out}");
    assert!(f.wrote().is_empty(), "실행됐다: {:?}", f.wrote());
}

// F11: 라우트가 표에 등록돼 있어야 한다 (FR-GIT-61).
#[test]
fn bundle_f_routes_registered() {
    for (method, path) in [
        ("POST", "/api/git/stash/branch"),
        ("POST", "/api/git/ignore"),
        ("GET", "/api/git/file-head"),
        ("POST", "/api/git/uncommitted/reset"),
        ("POST", "/api/git/uncommitted/clean"),
    ] {
        assert!(
            otter_webserver_httproute::dispatch(&crate::routes::ROUTES, method, path).is_some(),
            "{method} {path} 라우트가 없다"
        );
    }
}
