//! Go `handlers_git_patch_test.go` 의 이식.
//!
//! 옮기지 않은 것:
//! - `TestGitPatchReq_HasNoPatchField`: 요청 구조체의 필드를 리플렉션으로 세는 내부 구현 시험이다.
//!   관측 동작(본문의 패치가 실행되지 않는다)은 `git_patch_ignores_client_supplied_patch` 가 본다.
//! - `quoteJSON`: `harness::q`(JSON 리터럴)로 대신한다.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::{Output, Service};
use dm_webserver_domain_git_store::{Store, StoreOptions};
use serde_json::{Value, json};
use tempfile::TempDir;

use super::harness::{FakeBroker, FakePaneHub, FakeWorkspace, abs, q, qe, req};
use super::wfake::write_status;
use crate::GitServer;

/// hunk 두 개짜리 unified diff 다 (Go `gitPatchDiff`).
const PATCH_DIFF: &str = concat!(
    "diff --git a/f.txt b/f.txt\n",
    "index 1111111..2222222 100644\n",
    "--- a/f.txt\n",
    "+++ b/f.txt\n",
    "@@ -2,7 +2,7 @@ ctx\n",
    " line2\n line3\n line4\n-line5\n+FIVE\n line6\n line7\n line8\n",
    "@@ -12,7 +12,7 @@ ctx\n",
    " line12\n line13\n line14\n-line15\n+FIFTEEN\n line16\n line17\n line18\n",
);

fn repo() -> String {
    abs(&["work", "repo"])
}

fn o(stdout: String) -> Output {
    Output {
        stdout: stdout.into_bytes(),
        ..Output::default()
    }
}

#[derive(Default)]
struct PState {
    writes: Vec<Vec<String>>,
    stdins: Vec<String>,
}

/// Go `gitPatchFake`: 읽기·쓰기를 함께 격리하고 diff 출력을 고정한다.
#[derive(Clone)]
struct PatchFake {
    st: Arc<Mutex<PState>>,
    git_dir: Arc<TempDir>,
}

impl PatchFake {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        PatchFake {
            st: Arc::default(),
            git_dir: Arc::new(dir),
        }
    }

    fn lock(&self) -> MutexGuard<'_, PState> {
        self.st.lock().unwrap()
    }

    fn read(&self, dir: &str, args: &[String]) -> Output {
        let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
        let gd = self.git_dir.path().to_string_lossy().into_owned();
        match a(0) {
            "rev-parse" if a(1) == "--show-toplevel" => o(format!("{dir}\n")),
            "rev-parse" => o(format!("{gd}\n{gd}\n")),
            "status" => o(write_status("f.txt", "M.")),
            "diff" => o(PATCH_DIFF.to_owned()),
            _ => Output::default(),
        }
    }

    fn write(&self, args: &[String], stdin: &str) -> Output {
        let mut st = self.lock();
        st.writes.push(args.to_vec());
        st.stdins.push(stdin.to_owned());
        Output::default()
    }

    fn service(&self) -> Service {
        let (r, w) = (self.clone(), self.clone());
        Service::builder()
            .runner(Arc::new(move |_, dir: String, args: Vec<String>| {
                let r = r.clone();
                Box::pin(async move { Ok(r.read(&dir, &args)) })
            }))
            .write_runner(Arc::new(move |_, _, args: Vec<String>, stdin: String| {
                let w = w.clone();
                Box::pin(async move { Ok(w.write(&args, &stdin)) })
            }))
            .build()
    }
}

/// Go `gitPatchServer`: 시계를 고정한다.
fn patch_server(f: &PatchFake) -> Arc<GitServer> {
    let at = SystemTime::now();
    let store = Store::new(
        Arc::new(f.service()),
        StoreOptions::default().clock(Arc::new(move || at)),
    );
    Arc::new(GitServer {
        git: Some(store),
        work: Some(Arc::new(FakeWorkspace::default())),
        commands: Some(Arc::new(FakeBroker::default())),
        tools: Some(Arc::new(FakePaneHub::default())),
        ..GitServer::default()
    })
}

async fn call(s: &Arc<GitServer>, method: &str, path: &str, b: &str) -> (u16, Value) {
    let r = req(s, method, path, b).await;
    (r.code, r.json())
}

fn hunks_url() -> String {
    format!(
        "/api/git/hunks?repo={}&axis=worktree-index&path=f.txt",
        qe(&repo())
    )
}

/// fake 가 주는 diff 의 관측 식별자다. /api/git/hunks 로 받는다 (Go `gitPatchDiffID`).
async fn diff_id(s: &Arc<GitServer>) -> String {
    let (code, out) = call(s, "GET", &hunks_url(), "").await;
    assert_eq!(code, 200, "GET /api/git/hunks: {out}");
    let id = out["diffId"].as_str().unwrap_or_default().to_owned();
    assert!(!id.is_empty(), "diffId 가 없다: {out}");
    id
}

fn patch_body(axis: &str, path: &str, op: &str, id: &str, rest: &str) -> String {
    format!(
        r#"{{"repo":{},"axis":{},"path":{},"op":{},"hunk":0,"diffId":{}{rest}}}"#,
        q(&repo()),
        q(axis),
        q(path),
        q(op),
        q(id)
    )
}

// P2 (V204): 본문에 패치를 실어 보내도 실행되지 않는다. 서버는 자기가 만든 diff 로 패치를 짓는다.
#[tokio::test]
async fn git_patch_ignores_client_supplied_patch() {
    let f = PatchFake::new();
    let s = patch_server(&f);
    let id = diff_id(&s).await;

    let hostile = "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-x\n+pwned\n";
    let rest = format!(r#","patch":{0},"body":{0},"content":{0}"#, q(hostile));
    let b = patch_body("worktree-index", "f.txt", "stage", &id, &rest);
    let (code, out) = call(&s, "POST", "/api/git/patch", &b).await;
    assert_eq!(code, 200, "POST /api/git/patch: {out}");
    let st = f.lock();
    assert_eq!(st.stdins.len(), 1, "쓰기 횟수: {:?}", st.writes);
    let stdin = &st.stdins[0];
    assert!(
        !stdin.contains("pwned") && !stdin.contains("passwd"),
        "클라이언트가 보낸 패치가 실행됐다:\n{stdin}"
    );
    // 서버가 만든 패치다 — 자기 diff 의 첫 hunk 만 담는다.
    assert!(
        stdin.contains("+FIVE"),
        "서버가 만든 패치가 아니다:\n{stdin}"
    );
    assert!(
        !stdin.contains("+FIFTEEN"),
        "고르지 않은 hunk 가 패치에 들었다:\n{stdin}"
    );
    assert_eq!(st.writes[0][0], "apply", "argv = {:?}", st.writes[0]);
}

// P3 (V205): 관측이 바뀌었으면 409 로 거부하고 git 을 돌리지 않는다.
#[tokio::test]
async fn git_patch_rejects_stale_observation() {
    let f = PatchFake::new();
    let s = patch_server(&f);
    let b = patch_body("worktree-index", "f.txt", "stage", "낡은값", "");
    let (code, out) = call(&s, "POST", "/api/git/patch", &b).await;
    assert_eq!(code, 409, "{out}");
    assert_eq!(out["error"], json!(apierr::CODE_STALE_OBSERVATION), "{out}");
    assert!(
        f.lock().writes.is_empty(),
        "거부된 요청이 git 을 돌렸다: {:?}",
        f.lock().writes
    );
}

// P4 (V206): revert 는 파괴적이다 — confirm:true 없이 실행되지 않는다.
#[tokio::test]
async fn git_patch_revert_requires_confirm() {
    let f = PatchFake::new();
    let s = patch_server(&f);
    let id = diff_id(&s).await;
    let b = patch_body("worktree-index", "f.txt", "revert", &id, "");
    let (code, out) = call(&s, "POST", "/api/git/patch", &b).await;
    assert_eq!(
        (code, out["error"].clone()),
        (400, json!(apierr::CODE_CONFIRM_REQUIRED)),
        "confirm 없는 revert: {out}"
    );
    assert!(f.lock().writes.is_empty(), "확인 없는 요청이 git 을 돌렸다");

    // confirm 을 주면 실행된다. 방향은 -R 이고 --cached 가 아니다 — 워킹 트리다.
    let b = patch_body(
        "worktree-index",
        "f.txt",
        "revert",
        &id,
        r#","confirm":true"#,
    );
    let (code, out) = call(&s, "POST", "/api/git/patch", &b).await;
    assert_eq!(code, 200, "confirm 있는 revert: {out}");
    let st = f.lock();
    assert_eq!(st.writes.len(), 1, "쓰기 횟수: {:?}", st.writes);
    let argv = &st.writes[0];
    assert!(
        argv.iter().any(|a| a == "-R") && !argv.iter().any(|a| a == "--cached"),
        "revert argv = {argv:?} — 워킹 트리를 되돌리는 형태가 아니다"
    );
}

// P5 (V204): hunks 는 읽기다. 서버가 만든 경계와 관측 식별자를 함께 준다.
#[tokio::test]
async fn git_hunks_returns_boundaries_and_id() {
    let f = PatchFake::new();
    let s = patch_server(&f);
    let (code, out) = call(&s, "GET", &hunks_url(), "").await;
    assert_eq!(code, 200, "GET /api/git/hunks: {out}");
    let hs = out["hunks"].as_array().cloned().unwrap_or_default();
    assert_eq!(hs.len(), 2, "hunk 수: {out}");
    assert_eq!(hs[0]["oldStart"], json!(2), "hunk[0]: {}", hs[0]);
    assert_eq!(
        hs[0]["lines"].as_array().map_or(0, Vec::len),
        8,
        "hunk[0].lines: {}",
        hs[0]
    );
    // requested 는 요청값 그대로다 (FR-GIT-16·54).
    let rq = &out["requested"];
    assert!(
        rq["axis"] == json!("worktree-index") && rq["path"] == json!("f.txt"),
        "requested = {rq}"
    );
}

// P6 (V204): 모르는 축·op·루트 밖 경로는 400 이고 git 을 돌리지 않는다.
#[tokio::test]
async fn git_patch_rejects_bad_axis_and_op() {
    let f = PatchFake::new();
    let s = patch_server(&f);
    let id = diff_id(&s).await;
    let bodies = [
        patch_body("index-head", "f.txt", "stage", &id, ""),
        patch_body("worktree-index", "f.txt", "nuke", &id, ""),
        patch_body("worktree-index", "../x", "stage", &id, ""),
    ];
    for b in bodies {
        let (code, out) = call(&s, "POST", "/api/git/patch", &b).await;
        assert_eq!(code, 400, "{b}: {out}");
    }
    assert!(
        f.lock().writes.is_empty(),
        "거부된 요청이 git 을 돌렸다: {:?}",
        f.lock().writes
    );
}
