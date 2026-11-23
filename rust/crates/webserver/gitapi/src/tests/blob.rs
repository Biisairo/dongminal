//! Go `handlers_git_diff_test.go`·`handlers_git_blob_test.go` (FR-GIT-44~48 · M9_SRS FR-M9-20·21).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dm_webserver_domain_git_core::{self as core, Output, Runner, Service};
use dm_webserver_domain_git_store::{Store, StoreOptions};
use tempfile::TempDir;

use super::harness::*;
use crate::GitServer;

const PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R', 0, 0, 0,
    1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
];

const SVG: &str = "<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"></svg>";

/// 마지막 인자(rev)로 blob 을 답하는 fake. cat-file 은 크기를 답한다.
struct DiffFake {
    _dirs: (TempDir, TempDir),
    root: String,
    git_dir: String,
    blobs: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl DiffFake {
    fn new() -> Self {
        let git = TempDir::new().unwrap();
        std::fs::write(git.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let root_dir = TempDir::new().unwrap();
        let root = std::fs::canonicalize(root_dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let git_dir = git.path().to_string_lossy().into_owned();
        DiffFake {
            _dirs: (git, root_dir),
            root,
            git_dir,
            blobs: Arc::default(),
        }
    }

    fn blob(&self, rev: &str, body: &[u8]) {
        self.blobs
            .lock()
            .unwrap()
            .insert(rev.to_owned(), body.to_vec());
    }

    fn runner(&self) -> Runner {
        let (root, git_dir, blobs) = (self.root.clone(), self.git_dir.clone(), self.blobs.clone());
        Arc::new(move |_, _, args: Vec<String>| {
            let o = if args[0] == "rev-parse"
                && args.get(1).map(String::as_str) == Some("--show-toplevel")
            {
                out(&format!("{root}\n"))
            } else if args[0] == "rev-parse" {
                out(&format!("{git_dir}\n{git_dir}\n"))
            } else {
                match blobs.lock().unwrap().get(args.last().unwrap()) {
                    None => Output {
                        exit_code: 128,
                        stderr: "fatal: path 'x' does not exist in 'HEAD'\n".to_owned(),
                        ..Output::default()
                    },
                    Some(b) if args[0] == "cat-file" => out(&format!("{}\n", b.len())),
                    Some(b) => Output {
                        stdout: b.clone(),
                        ..Output::default()
                    },
                }
            };
            Box::pin(async move { Ok::<_, core::Error>(o) })
        })
    }

    fn server(&self, images: bool) -> Arc<GitServer> {
        let svc = Service::builder().runner(self.runner()).build();
        Arc::new(GitServer {
            git: Some(Store::new(Arc::new(svc), StoreOptions::default())),
            images: images.then(|| {
                Arc::new(
                    Service::builder()
                        .runner(self.runner())
                        .max_output(1 << 20)
                        .build(),
                )
            }),
            ..GitServer::default()
        })
    }
}

#[tokio::test]
async fn diff_echoes_requested() {
    let f = DiffFake::new();
    f.blob("HEAD:old.txt", b"old\n");
    f.blob(":new.txt", b"new\n");
    let s = f.server(false);
    let sub = format!("{}/sub", f.root);
    let r = req(
        &s,
        "GET",
        &format!("/api/git/diff-content?repo={sub}&axis=index-head&path=new.txt&origPath=old.txt"),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    let rq = &out["requested"];
    assert_eq!(
        (rq["repo"].as_str(), rq["axis"].as_str()),
        (Some(sub.as_str()), Some("index-head"))
    );
    assert_eq!(
        (rq["path"].as_str(), rq["origPath"].as_str()),
        (Some("new.txt"), Some("old.txt"))
    );
    assert_eq!(
        (rq["oid"].as_str(), rq["parentOid"].as_str()),
        (Some(""), Some(""))
    );
    assert_eq!(out["repo"], f.root);
    assert_eq!(
        (
            out["original"]["kind"].as_str(),
            out["original"]["content"].as_str()
        ),
        (Some("text"), Some("old\n"))
    );
    assert_eq!(
        (
            out["modified"]["kind"].as_str(),
            out["modified"]["content"].as_str()
        ),
        (Some("text"), Some("new\n"))
    );
    assert!(r.text().starts_with("{\"requested\":{\"repo\":"));
}

#[tokio::test]
async fn diff_orig_path_defaults_to_path() {
    let f = DiffFake::new();
    f.blob("HEAD:a.txt", b"head\n");
    f.blob(":a.txt", b"index\n");
    let s = f.server(false);
    let out = req(
        &s,
        "GET",
        &format!(
            "/api/git/diff-content?repo={}&axis=index-head&path=a.txt",
            f.root
        ),
        "",
    )
    .await
    .json();
    assert_eq!(out["requested"]["origPath"], "");
    assert_eq!(out["origPath"], "a.txt");
}

#[tokio::test]
async fn diff_worktree_side_and_note() {
    let f = DiffFake::new();
    std::fs::write(format!("{}/added.txt", f.root), "hi\n").unwrap();
    let s = f.server(false);
    let r = req(
        &s,
        "GET",
        &format!(
            "/api/git/diff-content?repo={}&axis=worktree-index&path=added.txt",
            f.root
        ),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    assert_eq!(out["original"]["kind"], "absent");
    assert_eq!(
        (
            out["modified"]["kind"].as_str(),
            out["modified"]["content"].as_str()
        ),
        (Some("text"), Some("hi\n"))
    );
    assert!(!out["note"].as_str().unwrap_or("").is_empty());
}

#[tokio::test]
async fn diff_rejects() {
    let f = DiffFake::new();
    f.blob(":a.txt", b"x\n");
    let s = f.server(false);
    let base = format!("/api/git/diff-content?repo={}", f.root);
    let cases = [
        (
            "repo 누락",
            "/api/git/diff-content?axis=index-head&path=a.txt".to_owned(),
            400,
            "bad_request",
        ),
        ("축 누락", format!("{base}&path=a.txt"), 400, "bad_request"),
        (
            "모르는 축",
            format!("{base}&axis=bogus-axis&path=a.txt"),
            400,
            "bad_request",
        ),
        (
            "커밋 축 oid 누락",
            format!("{base}&axis=commit-parent&path=a.txt"),
            400,
            "bad_request",
        ),
        (
            "경로 누락",
            format!("{base}&axis=index-head"),
            400,
            "bad_request",
        ),
        (
            "부모 참조",
            format!("{base}&axis=index-head&path=../secret"),
            400,
            "bad_request",
        ),
        (
            "절대경로",
            format!("{base}&axis=index-head&path=/etc/passwd"),
            400,
            "bad_request",
        ),
        (
            "origPath 부모 참조",
            format!("{base}&axis=index-head&path=a.txt&origPath=../secret"),
            400,
            "bad_request",
        ),
        (
            "양쪽 없음",
            format!("{base}&axis=index-head&path=nowhere.txt"),
            404,
            "not_found",
        ),
        (
            "모르는 인코딩",
            format!("{base}&axis=index-head&path=a.txt&encoding=nope"),
            400,
            "bad_request",
        ),
    ];
    for (name, target, code, err) in cases {
        let r = req(&s, "GET", &target, "").await;
        assert_eq!(
            (r.code, r.json()["error"].clone()),
            (code, serde_json::json!(err)),
            "{name}: {}",
            r.text()
        );
    }
    let r = req(
        &s,
        "GET",
        &format!("{base}&axis=index-head&path=a.txt&encoding=nope"),
        "",
    )
    .await;
    assert_eq!(r.json()["message"], "모르는 인코딩: nope");
}

#[tokio::test]
async fn diff_unavailable() {
    let s = Arc::new(GitServer::default());
    let r = req(
        &s,
        "GET",
        &format!(
            "/api/git/diff-content?repo={}&axis=index-head&path=a.txt",
            qe(&abs(&["r"]))
        ),
        "",
    )
    .await;
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (503, serde_json::json!("git_unavailable"))
    );
}

fn blob_url(f: &DiffFake, rest: &str) -> String {
    format!("/api/git/blob?repo={}{rest}", f.root)
}

#[tokio::test]
async fn blob_serves_original_with_locks() {
    let f = DiffFake::new();
    f.blob("HEAD:a.png", PNG);
    let s = f.server(true);
    let r = req(
        &s,
        "GET",
        &blob_url(&f, "&axis=worktree-head&path=a.png&side=original"),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    assert_eq!(r.headers["content-type"], "image/png");
    assert_eq!(r.headers["x-content-type-options"], "nosniff");
    assert!(r.headers.get("content-security-policy").is_none());
    assert_eq!(r.headers["content-length"], PNG.len().to_string().as_str());
    assert_eq!(r.body, PNG);
}

#[tokio::test]
async fn blob_serves_modified_from_worktree() {
    let f = DiffFake::new();
    std::fs::write(format!("{}/b.png", f.root), PNG).unwrap();
    let s = f.server(true);
    let r = req(
        &s,
        "GET",
        &blob_url(&f, "&axis=worktree-head&path=b.png&side=modified"),
        "",
    )
    .await;
    assert_eq!((r.code, r.body.as_slice()), (200, PNG));
}

#[tokio::test]
async fn blob_svg_carries_sandbox() {
    let f = DiffFake::new();
    f.blob("HEAD:i.svg", SVG.as_bytes());
    let s = f.server(true);
    let r = req(
        &s,
        "GET",
        &blob_url(&f, "&axis=worktree-head&path=i.svg&side=original"),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    assert_eq!(r.headers["content-type"], "image/svg+xml");
    assert_eq!(r.headers["content-security-policy"], "sandbox");
}

#[tokio::test]
async fn blob_rejects_non_image() {
    let f = DiffFake::new();
    f.blob("HEAD:a.txt", b"plain\n");
    f.blob("HEAD:evil.svg", b"<html><script>alert(1)</script></html>");
    let s = f.server(true);
    for p in ["a.txt", "evil.svg"] {
        let r = req(
            &s,
            "GET",
            &blob_url(&f, &format!("&axis=worktree-head&path={p}&side=original")),
            "",
        )
        .await;
        assert_eq!(r.code, 415, "{p}: {}", r.text());
        assert_eq!(
            r.text(),
            "{\"error\":\"not_an_image\",\"message\":\"not an image\"}\n"
        );
    }
}

#[tokio::test]
async fn blob_rejections_are_distinct() {
    let f = DiffFake::new();
    f.blob("HEAD:a.png", PNG);
    let s = f.server(true);
    for (name, rest, code) in [
        ("side 없음", "&axis=worktree-head&path=a.png", 400),
        ("side 이상", "&axis=worktree-head&path=a.png&side=both", 400),
        ("축 이상", "&axis=nope&path=a.png&side=original", 400),
        (
            "없는 파일",
            "&axis=worktree-head&path=zz.png&side=original",
            404,
        ),
    ] {
        let r = req(&s, "GET", &blob_url(&f, rest), "").await;
        assert_eq!(r.code, code, "{name}: {}", r.text());
    }
}

#[tokio::test]
async fn blob_without_image_service_is_unavailable() {
    let f = DiffFake::new();
    f.blob("HEAD:a.png", PNG);
    let s = f.server(false);
    let r = req(
        &s,
        "GET",
        &blob_url(&f, "&axis=worktree-head&path=a.png&side=original"),
        "",
    )
    .await;
    assert_eq!(r.code, 503);
    assert_eq!(r.json()["message"], "그림 전용 git 실행기가 없다");
}

#[tokio::test]
async fn diff_image_mime() {
    for (name, path, body, mime, kind) in [
        ("PNG", "a.png", PNG, "image/png", "binary"),
        ("SVG", "i.svg", SVG.as_bytes(), "image/svg+xml", "text"),
        ("텍스트", "a.txt", b"plain\n".as_slice(), "", "text"),
    ] {
        let f = DiffFake::new();
        f.blob(&format!("HEAD:{path}"), body);
        let s = f.server(true);
        let r = req(
            &s,
            "GET",
            &format!(
                "/api/git/diff-content?repo={}&axis=worktree-head&path={path}",
                f.root
            ),
            "",
        )
        .await;
        assert_eq!(r.code, 200, "{name}: {}", r.text());
        let out = r.json();
        assert_eq!(out["imageMime"].as_str().unwrap_or(""), mime, "{name}");
        assert_eq!(out["original"]["kind"], kind, "{name}");
        if !mime.is_empty() {
            assert!(
                out["note"].as_str().unwrap_or("").is_empty(),
                "{name}: note 가 남았다"
            );
        }
    }
}

#[tokio::test]
async fn diff_no_image_service_leaves_mime_empty() {
    let f = DiffFake::new();
    f.blob("HEAD:a.png", PNG);
    let s = f.server(false);
    let out = req(
        &s,
        "GET",
        &format!(
            "/api/git/diff-content?repo={}&axis=worktree-head&path=a.png",
            f.root
        ),
        "",
    )
    .await
    .json();
    assert!(out.get("imageMime").is_none());
}

// Go `handlers_git_diff_commit_test.go`: 커밋 축은 리비전을 되돌려주고 좌우를 지킨다.
#[tokio::test]
async fn diff_commit_axis_echoes_revisions() {
    let f = DiffFake::new();
    f.blob("aaa:a.txt", b"new\n");
    f.blob("bbb:a.txt", b"old\n");
    let s = f.server(false);
    let r = req(
        &s,
        "GET",
        &format!(
            "/api/git/diff-content?repo={}&axis=commit-parent&path=a.txt&oid=aaa&parentOid=bbb",
            f.root
        ),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    for (k, v) in [
        ("axis", "commit-parent"),
        ("oid", "aaa"),
        ("parentOid", "bbb"),
        ("path", "a.txt"),
    ] {
        assert_eq!(out["requested"][k], v, "{k}");
    }
    assert_eq!(
        (
            out["original"]["content"].as_str(),
            out["modified"]["content"].as_str()
        ),
        (Some("old\n"), Some("new\n"))
    );
    let r = req(
        &s,
        "GET",
        &format!(
            "/api/git/diff-content?repo={}&axis=commit-parent&path=a.txt&oid=-x",
            f.root
        ),
        "",
    )
    .await;
    assert_eq!(
        (r.code, r.json()["error"].clone()),
        (400, serde_json::json!("bad_request"))
    );
}

// Go `handlers_git_diff_limit_test.go`: diff 본문은 편집기 상한(32 MiB)까지 낸다 (FR-OPT-15-1).
// 실제 git 을 쓴다. file-head 갈래는 5.4.3 이 옮긴다.
async fn limit_case(size: usize, change: bool) -> serde_json::Value {
    let Some(repo) = dm_shared_gittest::repo() else {
        return serde_json::Value::Null;
    };
    let p = repo.path();
    std::fs::write(p.join("big.txt"), "a".repeat(size)).unwrap();
    dm_shared_gittest::run(p, &["add", "big.txt"]);
    dm_shared_gittest::run(p, &["commit", "-qm", "big.txt"]);
    if change {
        std::fs::write(p.join("big.txt"), "b".repeat(size)).unwrap();
    }
    let s = Arc::new(GitServer {
        git: Some(Store::new(
            Arc::new(Service::new()),
            StoreOptions::default(),
        )),
        ..GitServer::default()
    });
    let r = req(
        &s,
        "GET",
        &format!(
            "/api/git/diff-content?repo={}&axis=worktree-head&path=big.txt",
            qe(&p.to_string_lossy())
        ),
        "",
    )
    .await;
    assert_eq!(r.code, 200, "{}", &r.text()[..200.min(r.text().len())]);
    r.json()
}

#[tokio::test]
async fn diff_at_editor_limit() {
    let max = dm_shared_editorlimit::FILE_MAX_BYTES as usize;
    let out = limit_case(max, true).await;
    if out.is_null() {
        return;
    }
    for side in ["original", "modified"] {
        assert_eq!(out[side]["kind"], "text", "{side}");
        assert_eq!(out[side]["content"].as_str().unwrap().len(), max, "{side}");
    }
}

#[tokio::test]
async fn diff_over_editor_limit() {
    let out = limit_case(dm_shared_editorlimit::FILE_MAX_BYTES as usize + 1, false).await;
    if out.is_null() {
        return;
    }
    assert_eq!(out["original"]["kind"], "too_large");
    assert!(out["original"]["content"].as_str().unwrap_or("").is_empty());
}
