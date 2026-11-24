//! 탐색기 검색·무시·감시·zip 의 시험 (Go `handlers_fs_search_test.go`·`handlers_fs_ignored_test.go`·
//! `handlers_fs_watch_test.go`·`handlers_fs_zip*_test.go`).

use std::collections::BTreeSet;
use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::Full;
use otter_webserver_fswatch::{Change, Kind};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::fsenv::{Env, Res, fs_env, fs_env_with, get, post, qe, req, seed_root, temp_dir, write};
use super::support::{LOCAL, TEST_HOST};
use crate::fs_search::{
    FS_GREP_MAX_LINE, FindHit, GREP_ENGINE_GO, GREP_ENGINE_RIPGREP, GrepMatch, find_files,
    grep_with_go, grep_with_ripgrep, look_ripgrep, parse_ripgrep_json,
};
use crate::fs_watch::{FS_WATCH_DIRS_MAX, fs_changed_payload, git_worktree_rounds};
use crate::fs_zip::{ZIP_MAX_CONCURRENT, zip_download_name, zip_many_name};
use crate::routes::API_ROUTES;
use crate::{Deps, Server};

// ── 검색 ──────────────────────────────────────────────────────────────────────────

/// Go `searchFixture`.
fn search_fixture(home: &str) {
    for (rel, body) in [
        ("src/app.go", "package main\nfunc Handler() {}\n"),
        ("src/util/helper.go", "package util\n// Handler 를 돕는다\n"),
        ("src/app.test.js", "test('Handler', () => {})\n"),
        ("README.md", "no match here\n"),
        ("node_modules/pkg/app.go", "func Handler() {}\n"),
        (".git/config", "Handler\n"),
        ("bin/blob.dat", "Handler\x00\x01\x02binary\n"),
    ] {
        let p = format!("{home}/{rel}");
        std::fs::create_dir_all(std::path::Path::new(&p).parent().unwrap()).unwrap();
        write(&p, body.as_bytes());
    }
}

async fn find(e: &Env, root: &str, q: &str) -> Res {
    get(
        &e.srv,
        &format!("/api/fs/find?root={}&q={}", qe(root), qe(q)),
    )
    .await
}

async fn grep(e: &Env, root: &str, q: &str) -> Res {
    get(
        &e.srv,
        &format!("/api/fs/grep?root={}&q={}", qe(root), qe(q)),
    )
    .await
}

fn path_set(v: &Value, key: &str) -> BTreeSet<String> {
    v[key]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["path"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn find_matches_substring_case_insensitive() {
    let e = fs_env();
    search_fixture(&e.home);
    let r = find(&e, &e.home, "APP").await;
    assert_eq!(r.status, 200, "{}", r.text());
    let got = path_set(&r.json(), "files");
    assert!(
        got.contains("src/app.go") && got.contains("src/app.test.js"),
        "{got:?}"
    );
    assert!(!got.contains("README.md"));
}

#[tokio::test]
async fn find_matches_on_relative_path() {
    let e = fs_env();
    search_fixture(&e.home);
    let got = path_set(&find(&e, &e.home, "util/help").await.json(), "files");
    assert!(got.contains("src/util/helper.go"), "{got:?}");
}

#[tokio::test]
async fn find_skips_excluded_dirs() {
    let e = fs_env();
    search_fixture(&e.home);
    let got = path_set(&find(&e, &e.home, "app.go").await.json(), "files");
    assert!(got.contains("src/app.go"));
    assert!(
        got.iter()
            .all(|p| !p.starts_with("node_modules/") && !p.starts_with(".git/")),
        "{got:?}"
    );
}

#[tokio::test]
async fn find_rejects_unknown_root() {
    let e = fs_env();
    search_fixture(&e.home);
    let r = find(&e, &format!("{}/src", e.home), "app").await;
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["code"], "outside_root");
}

#[tokio::test]
async fn find_truncates_at_limit() {
    let e = fs_env();
    std::fs::create_dir_all(format!("{}/many", e.home)).unwrap();
    for i in 0..30u8 {
        write(
            &format!(
                "{}/many/hit{}{}.txt",
                e.home,
                (b'a' + i % 26) as char,
                (b'a' + i / 26) as char
            ),
            b"x",
        );
    }
    let r = get(
        &e.srv,
        &format!("/api/fs/find?root={}&q=hit&limit=5", qe(&e.home)),
    )
    .await;
    assert_eq!(r.status, 200);
    let v = r.json();
    assert_eq!(v["files"].as_array().unwrap().len(), 5);
    assert_eq!(v["truncated"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn find_does_not_follow_symlink_loop() {
    let e = fs_env();
    search_fixture(&e.home);
    std::os::unix::fs::symlink(&e.home, format!("{}/src/loop", e.home)).unwrap();
    let r = tokio::time::timeout(Duration::from_secs(10), find(&e, &e.home, "app.go"))
        .await
        .expect("순환 심링크에서 끝나지 않았다 — FR-EQO-6 위반");
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn grep_returns_line_matches() {
    let e = fs_env();
    search_fixture(&e.home);
    let r = grep(&e, &e.home, "Handler").await;
    assert_eq!(r.status, 200);
    let v = r.json();
    let m = v["matches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["path"] == "src/app.go")
        .expect("src/app.go 의 결과가 없다")
        .clone();
    assert_eq!(m["line"], 2);
    assert!(m["text"].as_str().unwrap().contains("Handler"));
    assert!(m["col"].as_i64().unwrap() >= 1);
}

#[tokio::test]
async fn grep_skips_binary_and_excluded() {
    let e = fs_env();
    search_fixture(&e.home);
    let got = path_set(&grep(&e, &e.home, "Handler").await.json(), "matches");
    for p in &got {
        assert!(
            !p.starts_with("node_modules/") && !p.starts_with(".git/") && !p.starts_with("bin/"),
            "{p}"
        );
    }
}

#[tokio::test]
async fn grep_reports_engine() {
    let e = fs_env();
    search_fixture(&e.home);
    let v = grep(&e, &e.home, "Handler").await.json();
    let eng = v["engine"].as_str().unwrap();
    assert!(eng == GREP_ENGINE_RIPGREP || eng == GREP_ENGINE_GO, "{eng}");
    let want = if look_ripgrep().is_some() {
        GREP_ENGINE_RIPGREP
    } else {
        GREP_ENGINE_GO
    };
    assert_eq!(eng, want);
}

#[tokio::test]
async fn grep_engines_agree() {
    let (_d, home) = temp_dir();
    search_fixture(&home);
    let Some(rg) = look_ripgrep() else {
        return;
    };
    let ctx = CancellationToken::new();
    let (a, _) = grep_with_ripgrep(&ctx, &rg, &home, "Handler", 100)
        .await
        .unwrap();
    let (b, _) = grep_with_go(&ctx, &home, "Handler", 100).unwrap();
    let norm = |ms: &[GrepMatch]| -> BTreeSet<String> {
        ms.iter()
            .map(|m| format!("{}:{}", m.path, m.line))
            .collect()
    };
    assert_eq!(norm(&a), norm(&b), "FR-EGS-4 위반");
}

#[tokio::test]
async fn grep_treats_shell_metachars_as_literal() {
    let e = fs_env();
    write(&format!("{}/meta.txt", e.home), b"value=$(id); rm -rf /\n");
    let r = grep(&e, &e.home, "$(id)").await;
    assert_eq!(r.status, 200);
    assert!(path_set(&r.json(), "matches").contains("meta.txt"));
}

#[test]
fn grep_stops_on_cancel() {
    let (_d, home) = temp_dir();
    search_fixture(&home);
    let ctx = CancellationToken::new();
    ctx.cancel();
    let start = Instant::now();
    assert!(grep_with_go(&ctx, &home, "Handler", 100).is_err());
    assert!(find_files(&ctx, &home, "app", 100).is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn search_rejects_empty_query() {
    let e = fs_env();
    for p in ["/api/fs/find", "/api/fs/grep"] {
        let r = get(&e.srv, &format!("{p}?root={}&q=", qe(&e.home))).await;
        assert_eq!(r.status, 400, "{p}");
    }
}

/// TC-PRF-19: 조각 내는 규칙 — CRLF 의 col 은 `\r` 을 떼기 전 줄의 자리다.
#[test]
fn grep_with_go_line_splitting_unchanged() {
    let (_d, dir) = temp_dir();
    for (n, b) in [
        ("lf.txt", &b"alpha\nNEEDLE here\nomega\n"[..]),
        ("crlf.txt", b"alpha\r\nxx NEEDLE\r\nomega\r\n"),
        ("noeol.txt", b"alpha\nNEEDLE last"),
        ("bin.dat", b"NEEDLE\x00binary\n"),
        ("empty.txt", b""),
    ] {
        write(&format!("{dir}/{n}"), b);
    }
    let (got, truncated) = grep_with_go(&CancellationToken::new(), &dir, "NEEDLE", 100).unwrap();
    assert!(!truncated);
    let m = |p: &str, line, col, text: &str| GrepMatch {
        path: p.into(),
        line,
        col,
        text: text.into(),
    };
    assert_eq!(
        got,
        vec![
            m("crlf.txt", 2, 4, "xx NEEDLE"),
            m("lf.txt", 2, 1, "NEEDLE here"),
            m("noeol.txt", 2, 1, "NEEDLE last"),
        ]
    );
}

/// FR-OPT-1-12: 룬 가운데서 자르지 않는다.
#[test]
fn grep_clip_keeps_utf8() {
    let (_d, dir) = temp_dir();
    let line = format!("ab{}", "가".repeat(FS_GREP_MAX_LINE));
    std::fs::create_dir_all(&dir).unwrap();
    write(&format!("{dir}/l.txt"), line.as_bytes());
    let (got, _) = grep_with_go(&CancellationToken::new(), &dir, "ab", 10).unwrap();
    let t = &got[0].text;
    assert!(
        t.len() <= FS_GREP_MAX_LINE && t.len() > FS_GREP_MAX_LINE - 4,
        "{}",
        t.len()
    );
    assert!(!t.contains('\u{FFFD}'));
}

#[test]
fn parse_ripgrep_json_rules() {
    let root = "/r";
    let ev = |p: &str, line: i64, start: i64, text: &str| {
        format!(
            r#"{{"type":"match","data":{{"path":{{"text":"{p}"}},"lines":{{"text":"{text}"}},"line_number":{line},"submatches":[{{"start":{start}}}]}}}}"#
        )
    };
    let out = [
        r#"{"type":"begin","data":{"path":{"text":"/r/a"}}}"#.to_owned(),
        ev("/r/a", 3, 2, "xx\\r\\n"),
        "not json".to_owned(),
        r#"{"type":"match","data":{"path":{"text":"/r/b"},"lines":{"text":"y"},"line_number":1,"submatches":[]}}"#
            .to_owned(),
        ev("/r/c", 9, 0, "z"),
    ]
    .join("\r\n");
    let (m, t) = parse_ripgrep_json(out.as_bytes(), root, 2);
    assert!(t);
    assert_eq!(
        m,
        vec![
            GrepMatch {
                path: "a".into(),
                line: 3,
                col: 3,
                text: "xx".into()
            },
            GrepMatch {
                path: "b".into(),
                line: 1,
                col: 1,
                text: "y".into()
            },
        ]
    );
    let (m, t) = parse_ripgrep_json(b"", root, 2);
    assert!(m.is_empty() && !t);
}

#[test]
fn find_files_reports_name() {
    let (_d, dir) = temp_dir();
    std::fs::create_dir_all(format!("{dir}/A")).unwrap();
    write(&format!("{dir}/A/Bc.TXT"), b"x");
    let (f, t) = find_files(&CancellationToken::new(), &dir, "bc.t", 10).unwrap();
    assert!(!t);
    assert_eq!(
        f,
        vec![FindHit {
            path: "A/Bc.TXT".into(),
            name: "Bc.TXT".into()
        }]
    );
}

// ── 무시 ──────────────────────────────────────────────────────────────────────────

fn ignore_repo() -> Option<otter_shared_gittest::Repo> {
    let r = otter_shared_gittest::init()?;
    let dir = r.path().to_path_buf();
    for (rel, body) in [
        (".gitignore", "node_modules/\n*.log\ntracked.log\n"),
        ("node_modules/pkg/a.js", "x\n"),
        ("src/main.js", "x\n"),
        ("app.log", "x\n"),
        ("tracked.log", "x\n"),
    ] {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    otter_shared_gittest::run(&dir, &["add", "-f", "tracked.log"]);
    otter_shared_gittest::run(&dir, &["add", ".gitignore", "src"]);
    otter_shared_gittest::run(&dir, &["commit", "-m", "init"]);
    Some(r)
}

fn transfer_env(root: &str) -> Env {
    let e = fs_env();
    seed_root(&e.ws, root);
    e
}

async fn ignored(e: &Env, root: &str, dir: &str, names: Value) -> Res {
    let body = json!({"root": root, "dir": dir, "names": names}).to_string();
    post(&e.srv, "/api/fs/ignored", &body).await
}

fn names_of(v: &Value) -> Vec<String> {
    v["ignored"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn ignored_only_ignored_names() {
    let Some(repo) = ignore_repo() else {
        return;
    };
    let root = repo.path().to_string_lossy().into_owned();
    let e = transfer_env(&root);
    let r = ignored(
        &e,
        &root,
        &root,
        json!([
            "node_modules",
            "src",
            "app.log",
            "tracked.log",
            ".gitignore"
        ]),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        r.text(),
        "{\"ignored\":[\"node_modules\",\"app.log\"],\"isRepo\":true}\n"
    );
}

#[tokio::test]
async fn ignored_none_is_success_and_subdir() {
    let Some(repo) = ignore_repo() else {
        return;
    };
    let root = repo.path().to_string_lossy().into_owned();
    let e = transfer_env(&root);
    let r = ignored(&e, &root, &root, json!(["src", ".gitignore"])).await;
    assert_eq!(r.status, 200, "종료코드 1 을 실패로 읽었다");
    assert!(names_of(&r.json()).is_empty());
    let r = ignored(&e, &root, &format!("{root}/node_modules"), json!(["pkg"])).await;
    assert_eq!(names_of(&r.json()), vec!["pkg"]);
}

#[tokio::test]
async fn ignored_records_through_shared_service() {
    let Some(repo) = ignore_repo() else {
        return;
    };
    let root = repo.path().to_string_lossy().into_owned();
    let svc = Arc::new(otter_webserver_domain_git_core::Service::new());
    let e = fs_env_with(
        Deps {
            git_service: Some(svc.clone()),
            ..Deps::default()
        },
        |_| {},
    );
    seed_root(&e.ws, &root);
    let r = ignored(&e, &root, &root, json!(["app.log"])).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        svc.records(10).len(),
        1,
        "실행 기록이 남지 않았다 (FR-GXU-10)"
    );
}

#[tokio::test]
async fn ignored_not_repo_is_answer() {
    if otter_shared_gittest::path().is_none() {
        return;
    }
    let (_d, plain) = temp_dir();
    let e = transfer_env(&plain);
    let r = ignored(&e, &plain, &plain, json!(["a.txt"])).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text(), "{\"ignored\":[],\"isRepo\":false}\n");
}

#[tokio::test]
async fn ignored_rejects_outside_unknown_and_paths() {
    let (_d, root) = temp_dir();
    let (_o, outside) = temp_dir();
    let e = transfer_env(&root);
    let r = ignored(&e, &root, &outside, json!(["a.txt"])).await;
    assert_eq!(
        (r.status, r.json()["code"].clone()),
        (403, json!("outside_root"))
    );
    let r = ignored(&e, &outside, &outside, json!(["a.txt"])).await;
    assert_eq!(r.status, 403);
    for bad in ["../outside", "a/b", "a\\b", ".", "..", ""] {
        let r = ignored(&e, &root, &root, json!([bad])).await;
        assert_eq!(r.status, 400, "{bad}");
    }
    let r = ignored(&e, &root, &root, Value::Null).await;
    assert_eq!(r.text(), "{\"ignored\":[]}\n");
}

#[test]
fn routes_registered() {
    for (m, p) in [
        ("POST", "/api/fs/ignored"),
        ("PUT", "/api/fs/watch"),
        ("GET", "/api/fs/find"),
        ("GET", "/api/fs/grep"),
        ("GET", "/api/fs/download-dir"),
        ("GET", "/api/fs/download-many"),
    ] {
        assert!(
            API_ROUTES
                .iter()
                .any(|r| r.method == m && r.matcher.matches(p)),
            "{m} {p} 가 API_ROUTES 에 없다"
        );
    }
}

// ── 감시 ──────────────────────────────────────────────────────────────────────────

async fn watch(e: &Env, body: Value) -> Res {
    req(
        &e.srv,
        "PUT",
        "/api/fs/watch",
        "application/json",
        body.to_string(),
    )
    .await
}

#[cfg(unix)]
#[tokio::test]
async fn watch_registers_valid_dirs_and_drops_others() {
    let e = fs_env();
    let (_d, root) = temp_dir();
    std::fs::create_dir_all(format!("{root}/sub")).unwrap();
    write(&format!("{root}/a.txt"), b"x");
    let w = e.srv.fs.watch.clone().unwrap();
    w.attach("c1");
    let r = watch(
        &e,
        json!({"clientId":"c1","dirs":[root.clone(), format!("{root}/sub"), format!("{root}/a.txt"), format!("{root}/missing"), "relative/dir"]}),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        r.json()["watching"],
        json!([root.clone(), format!("{root}/sub")])
    );
    w.close();
}

#[cfg(unix)]
#[tokio::test]
async fn watch_symlink_keeps_client_spelling() {
    let e = fs_env();
    let (_d, base) = temp_dir();
    std::fs::create_dir_all(format!("{base}/real")).unwrap();
    let link = format!("{base}/link");
    std::os::unix::fs::symlink(format!("{base}/real"), &link).unwrap();
    let w = e.srv.fs.watch.clone().unwrap();
    w.attach("c1");
    let r = watch(&e, json!({"clientId":"c1","dirs":[link.clone()]})).await;
    assert_eq!(r.json()["watching"], json!([link]));
    w.close();
}

#[tokio::test]
async fn watch_too_many_dirs_and_unattached_are_400() {
    let e = fs_env();
    let w = e.srv.fs.watch.clone().unwrap();
    w.attach("c1");
    let dirs: Vec<String> = (0..=FS_WATCH_DIRS_MAX).map(|i| format!("/d{i}")).collect();
    let r = watch(&e, json!({"clientId":"c1","dirs":dirs})).await;
    assert_eq!(r.status, 400);
    let (_d, root) = temp_dir();
    for cid in ["", "nobody"] {
        let r = watch(&e, json!({"clientId":cid,"dirs":[root.clone()]})).await;
        assert_eq!(r.status, 400, "{cid}");
    }
    assert_eq!(FS_WATCH_DIRS_MAX, 1024);
    w.close();
}

/// TC-CH2A-1: 채널 `hello.client` 가 감시 임대를 쥐고, 채널이 닫히면 놓는다. 칸 신원(`slots`)은 쥐지 않는다.
#[tokio::test]
async fn watch_lease_follows_channel_client() {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    let e = fs_env();
    let (_d, root) = temp_dir();
    let port = super::ws::listen(e.srv.clone()).await;
    let (mut c, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/channel?v=1"))
        .await
        .unwrap();
    c.send(Message::text(
        json!({"t":"hello","client":"w1","slots":["s1"]}).to_string(),
    ))
    .await
    .unwrap();
    let body = json!({"clientId":"w1","dirs":[root.clone()]});
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut ok = false;
    while Instant::now() < deadline {
        if watch(&e, body.clone()).await.status == 200 {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(ok, "채널 client 가 감시 임대를 쥐지 않았다");
    assert_eq!(
        watch(&e, json!({"clientId":"s1","dirs":[root.clone()]}))
            .await
            .status,
        400,
        "칸 신원이 감시 임대를 쥐었다"
    );
    drop(c);
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && watch(&e, body.clone()).await.status == 200 {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        watch(&e, body).await.status,
        400,
        "닫힌 채널이 임대를 놓지 않았다"
    );
}

#[test]
fn fs_changed_payload_shape() {
    let c = vec![
        Change::new("/a", Kind::Added),
        Change::new("/b<", Kind::Deleted),
    ];
    assert_eq!(
        String::from_utf8(fs_changed_payload(&c, false)).unwrap(),
        r#"{"action":"fs_changed","args":{"changes":[{"path":"/a","type":"added"},{"path":"/b\u003c","type":"deleted"}]}}"#
    );
    assert_eq!(
        String::from_utf8(fs_changed_payload(&c, true)).unwrap(),
        r#"{"action":"fs_changed","args":{"overflow":true}}"#
    );
    assert_eq!(
        String::from_utf8(fs_changed_payload(&[], false)).unwrap(),
        r#"{"action":"fs_changed","args":{"changes":[]}}"#
    );
}

/// V-ELR-35 (FR-ELR-76).
#[test]
fn git_worktree_rounds_table() {
    for (blob, want) in [
        ("{}", 4),
        ("", 4),
        ("not json", 4),
        (r#"{"gitWorktreeInterval":4000}"#, 4),
        (r#"{"gitWorktreeInterval":1000}"#, 1),
        (r#"{"gitWorktreeInterval":2500}"#, 3),
        (r#"{"gitWorktreeInterval":30000}"#, 30),
        (r#"{"gitWorktreeInterval":500}"#, 4),
        (r#"{"gitWorktreeInterval":60000}"#, 4),
        (r#"{"gitWorktreeInterval":"x"}"#, 4),
    ] {
        assert_eq!(git_worktree_rounds(blob.as_bytes()), want, "{blob}");
    }
}

// ── zip ───────────────────────────────────────────────────────────────────────────

/// Go `zipTree`.
fn zip_tree() -> (tempfile::TempDir, String) {
    let (d, root) = temp_dir();
    for (rel, body) in [
        ("box/a.txt", "aaa\n"),
        ("box/sub/b.txt", "bbb\n"),
        ("box/sub/deep/c.txt", "ccc\n"),
    ] {
        let p = format!("{root}/{rel}");
        std::fs::create_dir_all(std::path::Path::new(&p).parent().unwrap()).unwrap();
        write(&p, body.as_bytes());
    }
    std::fs::create_dir_all(format!("{root}/box/empty")).unwrap();
    (d, root)
}

fn zip_env(root: &str, f: impl FnOnce(&mut Server)) -> Env {
    let e = fs_env_with(Deps::default(), f);
    seed_root(&e.ws, root);
    e
}

async fn download_dir(e: &Env, root: &str, path: &str) -> Res {
    get(
        &e.srv,
        &format!("/api/fs/download-dir?root={}&path={}", qe(root), qe(path)),
    )
    .await
}

async fn download_many(e: &Env, root: &str, paths: &[String]) -> Res {
    let mut t = format!("/api/fs/download-many?root={}", qe(root));
    for p in paths {
        t.push_str(&format!("&path={}", qe(p)));
    }
    get(&e.srv, &t).await
}

/// 중앙 디렉터리로 엔트리 (이름, 내용) 을 읽는다. 이름 순이다.
fn zip_entries(z: &[u8]) -> Vec<(String, Vec<u8>)> {
    let u16_at = |i: usize| usize::from(u16::from_le_bytes([z[i], z[i + 1]]));
    let u32_at = |i: usize| u32::from_le_bytes([z[i], z[i + 1], z[i + 2], z[i + 3]]) as usize;
    let eocd = z.len() - 22;
    assert_eq!(&z[eocd..eocd + 4], b"PK\x05\x06", "zip 이 아니다");
    let mut p = u32_at(eocd + 16);
    let mut out = Vec::new();
    for _ in 0..u16_at(eocd + 10) {
        let method = u16_at(p + 10);
        let csize = u32_at(p + 20);
        let (n, ex, c) = (u16_at(p + 28), u16_at(p + 30), u16_at(p + 32));
        let off = u32_at(p + 42);
        let name = String::from_utf8(z[p + 46..p + 46 + n].to_vec()).unwrap();
        let ds = off + 30 + u16_at(off + 26) + u16_at(off + 28);
        let data = &z[ds..ds + csize];
        let raw = if method == 8 {
            let mut v = Vec::new();
            flate2::read::DeflateDecoder::new(data)
                .read_to_end(&mut v)
                .unwrap();
            v
        } else {
            data.to_vec()
        };
        out.push((name, raw));
        p += 46 + n + ex + c;
    }
    out.sort();
    out
}

fn names(z: &[u8]) -> Vec<String> {
    zip_entries(z).into_iter().map(|(n, _)| n).collect()
}

fn content(z: &[u8], name: &str) -> String {
    let e = zip_entries(z);
    let (_, b) = e.iter().find(|(n, _)| n == name).expect("zip 에 없다");
    String::from_utf8(b.clone()).unwrap()
}

#[tokio::test]
async fn download_dir_preserves_tree() {
    let (_d, root) = zip_tree();
    let e = zip_env(&root, |_| {});
    let r = download_dir(&e, &root, &format!("{root}/box")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.header("Content-Type"), "application/zip");
    assert_eq!(r.header("Content-Length"), "");
    assert_eq!(
        names(&r.body),
        vec![
            "box/a.txt",
            "box/empty/",
            "box/sub/",
            "box/sub/b.txt",
            "box/sub/deep/",
            "box/sub/deep/c.txt"
        ]
    );
    assert_eq!(content(&r.body, "box/sub/deep/c.txt"), "ccc\n");
}

#[tokio::test]
async fn download_dir_disposition_two_forms() {
    let (_d, root) = zip_tree();
    let dir = format!("{root}/한글 폴더");
    std::fs::create_dir_all(&dir).unwrap();
    write(&format!("{dir}/a.txt"), b"x");
    let e = zip_env(&root, |_| {});
    let r = download_dir(&e, &root, &dir).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.header("Content-Disposition"),
        "attachment; filename=\"__ __.zip\"; filename*=UTF-8''%ED%95%9C%EA%B8%80%20%ED%8F%B4%EB%8D%94.zip"
    );
}

#[tokio::test]
async fn download_dir_rejects_file_outside_and_accepts_root() {
    let (_d, root) = zip_tree();
    let (_o, outside) = temp_dir();
    let e = zip_env(&root, |_| {});
    let r = download_dir(&e, &root, &format!("{root}/box/a.txt")).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.header("Content-Disposition"), "");
    assert_eq!(download_dir(&e, &root, &outside).await.status, 403);
    let r = download_dir(&e, &root, &root).await;
    assert_eq!(r.status, 200);
    assert!(!names(&r.body).is_empty());
}

#[tokio::test]
async fn download_dir_over_limit_sends_nothing() {
    let (_d, root) = zip_tree();
    let e = zip_env(&root, |s| s.fs.zip.max_entries = 2);
    let r = download_dir(&e, &root, &format!("{root}/box")).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.header("Content-Disposition"), "");
    assert!(!r.body.starts_with(b"PK"));
    assert_eq!(
        r.text(),
        "{\"code\":\"bad_request\",\"message\":\"폴더가 상한을 넘었다 — 더 작은 폴더를 받으세요\"}\n"
    );
    let e = zip_env(&root, |s| s.fs.zip.max_bytes = 4);
    assert_eq!(
        download_dir(&e, &root, &format!("{root}/box")).await.status,
        400
    );
}

#[cfg(unix)]
#[tokio::test]
async fn download_dir_skips_symlinks_and_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let (_d, root) = zip_tree();
    std::os::unix::fs::symlink(format!("{root}/box/a.txt"), format!("{root}/box/link.txt"))
        .unwrap();
    let bad = format!("{root}/box/secret.txt");
    write(&bad, b"s");
    std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o000)).unwrap();
    let e = zip_env(&root, |_| {});
    let r = download_dir(&e, &root, &format!("{root}/box")).await;
    std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(r.status, 200);
    let n = names(&r.body);
    assert!(
        !n.contains(&"box/link.txt".to_owned()),
        "링크가 zip 에 들어갔다"
    );
    assert_eq!(content(&r.body, "box/a.txt"), "aaa\n");
}

#[tokio::test]
async fn download_dir_over_concurrency_is_429_and_releases_slot() {
    let (_d, root) = zip_tree();
    let e = zip_env(&root, |_| {});
    e.srv
        .fs
        .zip
        .in_flight
        .store(ZIP_MAX_CONCURRENT, Ordering::SeqCst);
    let r = download_dir(&e, &root, &format!("{root}/box")).await;
    assert_eq!(r.status, 429);
    assert_eq!(r.header("Content-Disposition"), "");
    assert_eq!(r.json()["code"], "busy");
    e.srv.fs.zip.in_flight.store(0, Ordering::SeqCst);
    let r = download_dir(&e, &root, &format!("{root}/box")).await;
    assert_eq!(r.status, 200);
    let deadline = Instant::now() + Duration::from_secs(3);
    while e.srv.fs.zip.in_flight.load(Ordering::SeqCst) != 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        e.srv.fs.zip.in_flight.load(Ordering::SeqCst),
        0,
        "자리가 남았다"
    );
    assert_eq!(ZIP_MAX_CONCURRENT, 2);
}

#[tokio::test]
async fn download_many_file_and_dir_at_top() {
    let (_d, root) = zip_tree();
    write(&format!("{root}/top.txt"), b"top\n");
    let e = zip_env(&root, |_| {});
    let r = download_many(
        &e,
        &root,
        &[format!("{root}/top.txt"), format!("{root}/box/sub")],
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        names(&r.body),
        vec!["sub/b.txt", "sub/deep/", "sub/deep/c.txt", "top.txt"]
    );
    assert_eq!(content(&r.body, "top.txt"), "top\n");
    assert!(r.header("Content-Disposition").contains("-2-items.zip"));
}

#[tokio::test]
async fn download_many_rejections_and_sum_limit() {
    let (_d, root) = zip_tree();
    let (_o, outside) = temp_dir();
    std::fs::create_dir_all(format!("{root}/other/sub")).unwrap();
    let e = zip_env(&root, |s| s.fs.zip.max_entries = 4);
    for (paths, code) in [
        (vec![format!("{root}/box/a.txt"), outside.clone()], 403),
        (vec![], 400),
        (
            vec![format!("{root}/box/sub"), format!("{root}/other/sub")],
            400,
        ),
        (
            vec![format!("{root}/box/sub"), format!("{root}/box/a.txt")],
            400,
        ),
    ] {
        let r = download_many(&e, &root, &paths).await;
        assert_eq!(r.status, code, "{paths:?} {}", r.text());
        assert_eq!(r.header("Content-Disposition"), "");
        assert!(!r.body.starts_with(b"PK"));
    }
}

#[test]
fn zip_names() {
    assert_eq!(zip_download_name("/a/box"), "box.zip");
    assert_eq!(zip_download_name("/"), "download.zip");
    assert_eq!(zip_many_name("/a/proj", 3), "proj-3-items.zip");
    assert_eq!(zip_many_name("/", 2), "download-2-items.zip");
}

/// 응답을 다 읽지 않고 끊어도 쓰기가 멈추고 자리가 돌아온다.
#[tokio::test]
async fn download_dir_client_gone_releases_slot() {
    let (_d, root) = zip_tree();
    let e = zip_env(&root, |_| {});
    let r = http::Request::builder()
        .uri(format!(
            "/api/fs/download-dir?root={}&path={}",
            qe(&root),
            qe(&format!("{root}/box"))
        ))
        .header("Host", TEST_HOST)
        .body(Full::new(Bytes::new()))
        .unwrap();
    let res = e.srv.serve_addr(r, LOCAL.to_owned()).await;
    drop(res);
    let deadline = Instant::now() + Duration::from_secs(3);
    while e.srv.fs.zip.in_flight.load(Ordering::SeqCst) != 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(e.srv.fs.zip.in_flight.load(Ordering::SeqCst), 0);
}
