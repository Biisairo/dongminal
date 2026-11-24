//! Go `handlers_git_test.go` (GIT_SRS §3.8 FR-GIT-60~63, 검증 V3·V4·V13·V16·V28·V29).

use std::sync::{Arc, Mutex};

use otter_webserver_apierr as apierr;
use otter_webserver_domain_git_core::{self as core, Kind, Output};
use otter_webserver_domain_git_store::Observation;
use serde_json::{Value, json};

use super::harness::*;
use crate::reply::{Bare, git_error_code};
use crate::{GitServer, RepoWatcher};

fn work_repo() -> String {
    abs(&["work", "repo"])
}
fn work_repo_sub() -> String {
    abs(&["work", "repo", "sub"])
}

fn endpoints() -> Vec<(&'static str, String, String)> {
    let r = abs(&["r"]);
    vec![
        ("GET", "/api/git/repos".to_owned(), String::new()),
        (
            "POST",
            "/api/git/repos/pin".to_owned(),
            format!(r#"{{"path":{}}}"#, q(&r)),
        ),
        (
            "POST",
            "/api/git/repos/unpin".to_owned(),
            format!(r#"{{"path":{}}}"#, q(&r)),
        ),
        (
            "GET",
            format!("/api/git/status?repo={}", qe(&r)),
            String::new(),
        ),
        (
            "GET",
            format!("/api/git/signature?repo={}", qe(&r)),
            String::new(),
        ),
    ]
}

// H1 (V28, FR-GIT-61): 5개 라우트가 표에 있다.
#[test]
fn routes_registered() {
    for (method, path, _) in endpoints() {
        let path = path.split('?').next().unwrap();
        assert!(
            otter_webserver_httproute::dispatch(&crate::routes::ROUTES, method, path).is_some(),
            "{method} {path} 가 표에 없다"
        );
    }
}

// H2: git 이 없으면 전부 503 git_unavailable 이다.
#[tokio::test]
async fn endpoints_unavailable() {
    let s = Arc::new(GitServer {
        work: Some(Arc::new(FakeWorkspace::default())),
        ..GitServer::default()
    });
    for (method, path, body) in endpoints() {
        let r = req(&s, method, &path, &body).await;
        assert_eq!(r.code, 503, "{method} {path}");
        assert_eq!(r.json()["error"], "git_unavailable", "{method} {path}");
        assert_eq!(r.headers["x-error-code"], "git_unavailable");
    }
}

// 응답 바이트가 Go 와 같다 — 오류 방언·끝 개행·Content-Type.
#[tokio::test]
async fn unavailable_bytes() {
    let s = Arc::new(GitServer::default());
    let r = req(&s, "GET", "/api/git/status?repo=/x", "").await;
    assert_eq!(
        r.text(),
        "{\"error\":\"git_unavailable\",\"message\":\"git 서비스가 구성되지 않았다\"}\n"
    );
    assert_eq!(r.headers["content-type"], "application/json");
}

// /api/git/ 밖이나 표에 없는 경로는 처리하지 않는다.
#[tokio::test]
async fn not_handled() {
    let e = env();
    assert!(
        e.s.handle(
            http::Request::new(http_body_util::Empty::<bytes::Bytes>::new()),
            None
        )
        .await
        .is_none()
    );
    for path in ["/api/files", "/api/git/nope", "/api/gitx"] {
        let r = http::Request::builder()
            .uri(path)
            .body(http_body_util::Empty::<bytes::Bytes>::new())
            .unwrap();
        assert!(e.s.handle(r, None).await.is_none(), "{path}");
    }
    // 메서드가 다르면 처리하지 않는다.
    let r = req(&e.s, "POST", "/api/git/status", "").await;
    assert_eq!(r.code, 404);
    // 경로는 퍼센트 디코딩한 값으로 고른다 (Go r.URL.Path).
    let r = req(&e.s, "GET", "/api/git/%70olicy", "").await;
    assert_eq!(r.code, 200);
}

// V-FLW-2 (FR-FLW-2): 목록은 핀만 답한다. 핀이 없으면 rev-parse 가 돌지 않는다.
#[tokio::test]
async fn repos_no_follow() {
    let e = env();
    e.hub.set_cwd("t1", &work_repo_sub());
    let roots = Arc::new(Mutex::new(0));
    let (rc, root) = (roots.clone(), work_repo());
    e.g.set_root(move |_| {
        *rc.lock().unwrap() += 1;
        out(&format!("{root}\n"))
    });
    let r = req(&e.s, "GET", "/api/git/repos?tool=t1", "").await;
    assert_eq!(r.code, 200, "{}", r.text());
    assert!(r.json().get("follow").is_none());
    assert_eq!(*roots.lock().unwrap(), 0);
    assert_eq!(r.text(), "{\"pinned\":[]}\n");
}

fn pin_ws(e: &Env, pins: &[&str]) {
    let list: Vec<String> = pins.iter().map(|p| q(p)).collect();
    e.ws.set(&format!(
        r#"{{"schemaVersion":2,"git":{{"pinned":[{}]}}}}"#,
        list.join(",")
    ));
}

// 배지는 Store.Observed 만 읽는다. status 를 한 번 관측한 뒤에야 값이 생긴다.
#[tokio::test]
async fn repos_badge_from_observation() {
    let e = env();
    pin_ws(&e, &[&work_repo()]);
    e.g.root_at(&work_repo());
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&work_repo())),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let r = req(&e.s, "GET", "/api/git/repos", "").await;
    assert_eq!(r.code, 200);
    let out = r.json();
    let pinned = out["pinned"].as_array().unwrap();
    assert_eq!(pinned.len(), 1);
    let badge = &pinned[0]["badge"];
    assert_eq!(badge["total"], 1);
    assert_eq!(badge["branch"], "main");
    assert_eq!(badge["detached"], false);
    assert_ne!(badge["observedAtUnixMs"], 0);
    assert!(
        badge.get("outputTruncated").is_none(),
        "잘리지 않았는데 열쇠가 있다"
    );
    assert_eq!(pinned[0]["root"], work_repo());
}

// 배지가 잘림을 말한다 (FR-SAF-21 · FR-WRD-81).
#[tokio::test]
async fn repos_badge_says_truncated() {
    let e = env();
    e.g.status_truncated
        .store(true, std::sync::atomic::Ordering::SeqCst);
    pin_ws(&e, &[&work_repo()]);
    e.g.root_at(&work_repo());
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&work_repo())),
        "",
    )
    .await;
    assert_eq!(r.code, 200);
    let out = req(&e.s, "GET", "/api/git/repos", "").await.json();
    assert_eq!(out["pinned"][0]["badge"]["outputTruncated"], true);
}

// H4 (V24, FR-GIT-24): /api/git/repos 는 git status 를 실행하지 않는다.
#[tokio::test]
async fn repos_never_runs_status() {
    let e = env();
    let (a, b, c) = (abs(&["a"]), abs(&["b"]), abs(&["c"]));
    pin_ws(&e, &[&a, &b, &c]);
    let r = req(&e.s, "GET", "/api/git/repos?tool=t1", "").await;
    assert_eq!(r.code, 200);
    assert_eq!(e.g.count("status"), 0);
    let out = r.json();
    let pinned = out["pinned"].as_array().unwrap();
    assert_eq!(pinned.len(), 3);
    assert_eq!(pinned[0]["path"], a);
    assert_eq!(pinned[0]["name"], "a");
    assert_eq!(pinned[0]["isRepo"], true);
    assert_eq!(pinned[0]["badge"], Value::Null);
    // 순서가 계약이다.
    assert_eq!(pinned[2]["path"], c);
    // 항목의 키는 Go 처럼 정렬되어 나간다.
    let keys: Vec<&String> = pinned[0].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["badge", "isRepo", "name", "path", "reason", "root"]);
}

// 저장소가 아니게 된 핀은 목록에서 지우지 않는다.
#[tokio::test]
async fn repos_pinned_not_repo_kept() {
    let e = env();
    let gone = abs(&["gone"]);
    pin_ws(&e, &[&gone]);
    e.g.set_root(|_| not_repo_out());
    let out = req(&e.s, "GET", "/api/git/repos", "").await.json();
    let p = &out["pinned"][0];
    assert_eq!(p["path"], gone);
    assert_eq!(p["isRepo"], false);
    assert_eq!(p["reason"], "not_a_git_repo");
    assert!(p.get("root").is_none());
}

// H5 (V16, FR-GIT-12): 저장소가 아닌 경로의 핀은 404 로 거부하고 목록을 바꾸지 않는다.
#[tokio::test]
async fn pin_rejects_non_repo() {
    let e = env();
    e.g.set_root(|_| not_repo_out());
    let body = format!(r#"{{"path":{}}}"#, q(&abs(&["tmp", "plain"])));
    let r = req(&e.s, "POST", "/api/git/repos/pin", &body).await;
    assert_eq!(r.code, 404, "{}", r.text());
    assert_eq!(r.text(), "{\"error\":\"not_a_git_repo\"}\n");
    assert_eq!(r.headers["x-error-code"], "not_a_git_repo");
    assert_eq!(e.ws.saves(), 0);
}

// GV-c: 상대경로는 저장소 추가 대화상자의 답과 같은 코드다.
#[tokio::test]
async fn pin_rejects_relative_path() {
    let e = env();
    let r = req(&e.s, "POST", "/api/git/repos/pin", r#"{"path":"rel/path"}"#).await;
    assert_eq!(r.code, 400);
    assert_eq!(r.json()["error"], apierr::CODE_ABS_PATH_NEEDED);
    let r = req(&e.s, "POST", "/api/git/repos/pin", r#"{"path":"  "}"#).await;
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (400, json!(apierr::CODE_EMPTY_PATH))
    );
    assert_eq!(e.ws.saves(), 0);
}

// 본문 해석 실패는 400 이고 사유를 준다.
#[tokio::test]
async fn pin_bad_body() {
    let e = env();
    let r = req(&e.s, "POST", "/api/git/repos/pin", "").await;
    assert_eq!(r.code, 400);
    assert_eq!(
        r.text(),
        "{\"error\":\"bad_request\",\"message\":\"본문이 JSON 이 아니다: unexpected end of JSON input\"}\n"
    );
    let r = req(&e.s, "POST", "/api/git/repos/pin", r#"{"path":1}"#).await;
    assert_eq!(r.code, 400);
    assert_eq!(
        r.json()["message"],
        "본문이 JSON 이 아니다: path: number 값은 맞지 않다"
    );
}

// H6 (V16, FR-GIT-62): 보낸 하위 경로가 아니라 rev-parse 결과를 저장한다.
#[tokio::test]
async fn pin_stores_rev_parse_root() {
    let e = env();
    e.g.root_at(&work_repo());
    let sub = format!("{}/dir", work_repo_sub());
    let r = req(
        &e.s,
        "POST",
        "/api/git/repos/pin",
        &format!(r#"{{"path":{}}}"#, q(&sub)),
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    assert_eq!(out["root"], work_repo());
    assert_eq!(out["pinned"], json!([work_repo()]));
    assert!(e.ws.raw().contains(&q(&work_repo())));
}

// H7 (V16, FR-GIT-11): 핀은 멱등이고 unpin 이 지운다. 다른 키는 지나간다.
#[tokio::test]
async fn pin_idempotent_and_preserves_other_keys() {
    let e = env();
    e.ws.set(r#"{"schemaVersion":2,"windows":[{"id":"w1"}],"activeWindow":"w1"}"#);
    e.g.root_at(&work_repo());
    let body = format!(r#"{{"path":{}}}"#, q(&work_repo()));
    for i in 0..2 {
        let r = req(&e.s, "POST", "/api/git/repos/pin", &body).await;
        assert_eq!(r.code, 200, "{i}: {}", r.text());
        assert_eq!(r.json()["pinned"].as_array().unwrap().len(), 1);
    }
    let doc: Value = serde_json::from_str(&e.ws.raw()).unwrap();
    assert_eq!(doc["schemaVersion"], 2);
    assert_eq!(doc["activeWindow"], "w1");
    assert_eq!(doc["windows"].as_array().unwrap().len(), 1);

    let r = req(&e.s, "POST", "/api/git/repos/unpin", &body).await;
    assert_eq!(r.code, 200, "{}", r.text());
    assert_eq!(r.json()["pinned"], json!([]));
    // unpin 은 rev-parse 를 하지 않는다 — 저장소가 아니게 된 핀도 지울 수 있다.
    let r = req(
        &e.s,
        "POST",
        "/api/git/repos/unpin",
        r#"{"path":"/never/pinned"}"#,
    )
    .await;
    assert_eq!(r.code, 200);
    // 빈 path 는 400 이다.
    let r = req(&e.s, "POST", "/api/git/repos/unpin", r#"{"path":""}"#).await;
    assert_eq!(
        r.text(),
        "{\"error\":\"bad_request\",\"message\":\"path 가 없다\"}\n"
    );
}

// 핀 목록 저장의 실패는 원인을 싣지 않는다 (FR-QG-5).
#[tokio::test]
async fn pin_save_fail() {
    let e = env();
    e.ws.stale.store(true, std::sync::atomic::Ordering::SeqCst);
    e.g.root_at(&work_repo());
    let r = req(
        &e.s,
        "POST",
        "/api/git/repos/pin",
        &format!(r#"{{"path":{}}}"#, q(&work_repo())),
    )
    .await;
    assert_eq!(r.code, 500);
    assert_eq!(
        r.text(),
        "{\"error\":\"git_failed\",\"message\":\"핀 목록을 저장하지 못했다\"}\n"
    );
}

// H8 (V16·V21, FR-GIT-31): 핀 변경은 다른 창에 브로드캐스트된다.
#[tokio::test]
async fn pin_broadcasts_workspace_changed() {
    let e = env();
    e.g.root_at(&work_repo());
    let body = format!(r#"{{"path":{}}}"#, q(&work_repo()));
    assert_eq!(
        req(&e.s, "POST", "/api/git/repos/pin", &body).await.code,
        200
    );
    assert_eq!(
        req(&e.s, "POST", "/api/git/repos/unpin", &body).await.code,
        200
    );
    let published = e.cb.published.lock().unwrap();
    assert_eq!(published.len(), 2);
    for p in published.iter() {
        let msg: Value = serde_json::from_slice(p).unwrap();
        assert_eq!(msg["action"], "workspace_changed");
    }
}

// H9 (V4, FR-GIT-16): /status·/signature 응답의 requested 는 요청값 그대로다.
#[tokio::test]
async fn status_signature_echo_requested() {
    let e = env();
    e.g.root_at(&work_repo());
    for path in ["/api/git/status", "/api/git/signature"] {
        let r = req(
            &e.s,
            "GET",
            &format!("{path}?repo={}", qe(&work_repo_sub())),
            "",
        )
        .await;
        assert_eq!(r.code, 200, "{path}: {}", r.text());
        let out = r.json();
        assert_eq!(out["requested"], work_repo_sub());
        assert_eq!(out["repo"], work_repo());
        assert!(!out["signature"].is_null(), "{path}");
    }
}

// H10 (V29, FR-GIT-62): /status 의 repo 는 rev-parse 로 재확인한 값이다.
#[tokio::test]
async fn status_reconfirms_repo() {
    let e = env();
    e.g.root_at(&work_repo());
    let target = format!("{}/deep/sub", work_repo());
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&target)),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    assert_eq!(out["repo"], work_repo());
    assert_eq!(out["cached"], false);
    assert_eq!(out["status"]["repo"], work_repo());
    assert_eq!(out["status"]["total"], 1);
    assert_eq!(out["isRepo"], true);
    assert_eq!(out["rootMatch"], false);
    assert!(out["actions"].is_object());
    assert_eq!(out["rowActions"], json!({}));
    assert!(!out["mark"].as_str().unwrap().is_empty());
    assert!(e.g.count("status") >= 1);
    // 키는 Go map 처럼 정렬되어 나간다.
    let keys: Vec<&String> = out.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "actions",
            "cached",
            "isRepo",
            "mark",
            "observedAtUnixMs",
            "repo",
            "requested",
            "requestedResolved",
            "rootMatch",
            "rowActions",
            "signature",
            "status"
        ]
    );
}

// ifMark 가 지금 관측과 같으면 목록을 싣지 않는다 (FR-OPT-4-7).
#[tokio::test]
async fn status_if_mark_unchanged() {
    let e = env();
    e.g.root_at(&work_repo());
    let base = format!("/api/git/status?repo={}", qe(&work_repo()));
    let mark = req(&e.s, "GET", &base, "").await.json()["mark"]
        .as_str()
        .unwrap()
        .to_owned();
    let out = req(&e.s, "GET", &format!("{base}&ifMark={}", qe(&mark)), "")
        .await
        .json();
    assert_eq!(out["unchanged"], true);
    assert!(out.get("status").is_none());
    assert_eq!(out["mark"], mark);
    let other = req(&e.s, "GET", &format!("{base}&ifMark=zzz"), "")
        .await
        .json();
    assert!(other.get("unchanged").is_none());
}

// H11: 오류 매핑. 클라이언트가 종류를 구분할 수 있어야 한다.
#[tokio::test]
async fn status_error_mapping() {
    type RootRes = fn(&str) -> Result<Output, core::Error>;
    let x = abs(&["x"]);
    let cases: [(&str, String, Option<RootRes>, u16, &str); 6] = [
        ("repo 누락", String::new(), None, 400, "bad_request"),
        ("상대경로", "?repo=rel".to_owned(), None, 400, "bad_request"),
        (
            "git 없음",
            format!("?repo={}", qe(&x)),
            Some(|_| {
                Err(core::Error::new(
                    Kind::GitMissing,
                    "exec: \"git\": not found",
                ))
            }),
            503,
            "git_missing",
        ),
        (
            "마감 초과",
            format!("?repo={}", qe(&x)),
            Some(|_| Err(core::Error::new(Kind::Timeout, "10s"))),
            504,
            "git_timeout",
        ),
        (
            "그 밖",
            format!("?repo={}", qe(&x)),
            Some(|_| {
                Ok(Output {
                    exit_code: 1,
                    stderr: "fatal: boom".to_owned(),
                    ..Output::default()
                })
            }),
            500,
            "git_failed",
        ),
        (
            "잘못된 이스케이프는 없는 인자다",
            "?repo=%zz".to_owned(),
            None,
            400,
            "bad_request",
        ),
    ];
    for (name, query, root, code, err) in cases {
        let e = env();
        if let Some(f) = root {
            e.g.set_root_result(f);
        }
        let r = req(&e.s, "GET", &format!("/api/git/status{query}"), "").await;
        assert_eq!(r.code, code, "{name}: {}", r.text());
        let out = r.json();
        assert_eq!(out["error"], err, "{name}");
        assert!(out["message"].is_string(), "{name}");
    }
    let e = env();
    let r = req(&e.s, "GET", "/api/git/status", "").await;
    assert_eq!(r.json()["message"], "repo 인자가 없다");
    let r = req(&e.s, "GET", "/api/git/status?repo=rel", "").await;
    assert_eq!(r.json()["message"], "repo 는 절대경로여야 한다");

    // stderr tail 보존.
    let e = env();
    e.g.set_root(|_| Output {
        exit_code: 1,
        stderr: "fatal: something specific".to_owned(),
        ..Output::default()
    });
    let r = req(&e.s, "GET", &format!("/api/git/status?repo={}", qe(&x)), "").await;
    assert!(
        r.json()["message"]
            .as_str()
            .unwrap()
            .contains("something specific")
    );
}

// V-ANA-1·2 (FR-ANA-1·6): 저장소가 아닌 것은 답이지 부재가 아니다.
#[tokio::test]
async fn status_not_repo_is_answer() {
    let e = env();
    e.g.set_root(|_| not_repo_out());
    let x = abs(&["x"]);
    let r = req(&e.s, "GET", &format!("/api/git/status?repo={}", qe(&x)), "").await;
    assert_eq!(r.code, 200);
    let out = r.json();
    assert_eq!(out["isRepo"], false);
    assert_eq!(out["requested"], x);
    assert!(out.get("error").is_none());
    assert_eq!(out["mark"], "");
    assert_eq!(out["status"], Value::Null);
    assert_eq!(out["repo"], "");
}

#[derive(Default)]
struct SpyWatcher {
    notes: Mutex<Vec<String>>,
}

impl RepoWatcher for SpyWatcher {
    fn note(&self, repo: &str, _: &Observation) {
        self.notes.lock().unwrap().push(repo.to_owned());
    }
    fn note_for(&self, repo: &str, _: &Observation, _: &str) {
        self.notes.lock().unwrap().push(repo.to_owned());
    }
    fn note_scoped(&self, repo: &str, _: &Observation, _: &str, _: &str) {
        self.notes.lock().unwrap().push(repo.to_owned());
    }
    fn release_scope(&self, _: &str, _: &str) {}
}

// V-ANA-2 (FR-ANA-6): 답할 수 없는 저장소는 감시에 넣지 않는다. 답할 수 있으면 넣는다.
#[tokio::test]
async fn status_not_repo_is_not_watched() {
    let w = Arc::new(SpyWatcher::default());
    let g = GitFake::new();
    g.set_root(|_| not_repo_out());
    let wc = w.clone();
    let e = env_with(g, move |s| s.watch = Some(wc));
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&abs(&["x"]))),
        "",
    )
    .await;
    assert_eq!(r.code, 200);
    assert!(w.notes.lock().unwrap().is_empty());

    e.g.root_at(&work_repo());
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&work_repo())),
        "",
    )
    .await;
    assert_eq!(r.code, 200);
    assert_eq!(*w.notes.lock().unwrap(), [work_repo()]);
}

// V-ANA-3 (FR-ANA-3): 소실은 여전히 404 다.
#[tokio::test]
async fn status_repo_missing_stays_404() {
    let e = env();
    e.g.set_root_result(|_| Err(core::Error::new(Kind::RepoMissing, "gone")));
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/status?repo={}", qe(&abs(&["x"]))),
        "",
    )
    .await;
    assert_eq!(r.code, 404);
    assert_eq!(r.json()["error"], "repo_missing");
}

// V-ANA-8 (D-1): 매핑표는 그대로다 — 다른 종단은 저장소 아님을 404 로 적는다.
#[tokio::test]
async fn not_repo_other_endpoints_stay_404() {
    assert_eq!(git_error_code(&Bare(Kind::NotRepo)).0, 404);
    let e = env();
    e.g.set_root(|_| not_repo_out());
    let r = req(
        &e.s,
        "GET",
        &format!("/api/git/signature?repo={}", qe(&abs(&["x"]))),
        "",
    )
    .await;
    assert_eq!(r.code, 404);
    assert_eq!(
        r.text(),
        "{\"error\":\"not_a_git_repo\",\"message\":\"not_a_git_repo\"}\n"
    );
}

// H12 (V13, FR-GIT-63): 동시 N 요청이 status 를 1회만 실행한다.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_concurrent_single_flight() {
    let e = env();
    let sem = Arc::new(tokio::sync::Semaphore::new(0));
    *e.g.status_hold.lock().unwrap() = Some(sem.clone());
    let entered = e.g.status_entered.clone();
    let target = format!("/api/git/status?repo={}", qe(&work_repo()));
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let (s, t) = (e.s.clone(), target.clone());
        tasks.push(tokio::spawn(
            async move { req(&s, "GET", &t, "").await.code },
        ));
    }
    entered.notified().await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    sem.close();
    for t in tasks {
        assert_eq!(t.await.unwrap(), 200);
    }
    assert_eq!(e.g.count("status"), 1);
}

// FR-GIT-217 (V94): 취소는 499 git_canceled 이고, 마감 초과는 504, 그 밖은 500 이다.
#[test]
fn error_code_canceled_is_client_closed() {
    let (code, name) = git_error_code(&core::Error::new(Kind::Canceled, "wrapped"));
    assert_eq!(code.as_u16(), apierr::STATUS_CLIENT_CLOSED);
    assert_eq!(name, "git_canceled");
    assert_eq!(git_error_code(&core::Error::new(Kind::Timeout, "x")).0, 504);
    assert_eq!(git_error_code(&core::Error::other("boom")).0, 500);
}

// FR-RMS-4: 소실은 자기 코드로 나간다.
#[test]
fn error_code_repo_missing() {
    let (code, name) = git_error_code(&core::Error::new(Kind::RepoMissing, "wrapped"));
    assert_eq!((code.as_u16(), name), (404, "repo_missing"));
    assert_eq!(git_error_code(&Bare(Kind::NotRepo)).1, "not_a_git_repo");
    let (code, name) = git_error_code(&core::Error::other("boom"));
    assert_eq!((code.as_u16(), name), (500, "git_failed"));
}
