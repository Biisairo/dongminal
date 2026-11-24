//! Go `handlers_git_history_test.go`·`handlers_git_history_initial_test.go` (GIT_SRS §3C · FR-GDT-21).

use std::sync::{Arc, Mutex};

use dm_webserver_domain_git_core::{self as core, Output, Service};
use dm_webserver_domain_git_store::{Store, StoreOptions};
use serde_json::{Value, json};
use tempfile::TempDir;

use super::harness::*;
use crate::GitServer;

const OID: &str = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const O1: &str = "b1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

#[derive(Default)]
struct Outs {
    log: String,
    tree: String,
    refs: String,
    status: String,
    log_fail: bool,
}

struct HistFake {
    _dirs: (TempDir, TempDir),
    root: String,
    git_dir: String,
    outs: Arc<Mutex<Outs>>,
    argvs: Arc<Mutex<Vec<String>>>,
    s: Arc<GitServer>,
}

impl HistFake {
    fn new() -> Self {
        let (r, g) = (TempDir::new().unwrap(), TempDir::new().unwrap());
        let root = std::fs::canonicalize(r.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let git_dir = g.path().to_string_lossy().into_owned();
        let outs: Arc<Mutex<Outs>> = Arc::default();
        let argvs: Arc<Mutex<Vec<String>>> = Arc::default();
        let (ro, gd, o, a) = (root.clone(), git_dir.clone(), outs.clone(), argvs.clone());
        let svc = Service::builder()
            .runner(Arc::new(move |_, _, args: Vec<String>| {
                let res = if args[0] == "rev-parse"
                    && args.get(1).map(String::as_str) == Some("--show-toplevel")
                {
                    out(&format!("{ro}\n"))
                } else if args[0] == "rev-parse" {
                    out(&format!("{gd}\n{gd}\n"))
                } else {
                    a.lock().unwrap().push(args.join(" "));
                    let o = o.lock().unwrap();
                    match args[0].as_str() {
                        "log" if o.log_fail => Output {
                            exit_code: 128,
                            stderr:
                                "fatal: your current branch 'main' does not have any commits yet\n"
                                    .to_owned(),
                            ..Output::default()
                        },
                        "log" => out(&o.log),
                        "status" => out(&o.status),
                        "diff-tree" => out(&o.tree),
                        "for-each-ref" => out(&o.refs),
                        "config" => out("remote.origin.url=/tmp/remote.git\n"),
                        _ => Output {
                            exit_code: 128,
                            stderr: "fatal: 예상하지 못한 호출\n".to_owned(),
                            ..Output::default()
                        },
                    }
                };
                Box::pin(async move { Ok::<_, core::Error>(res) })
            }))
            .build();
        let s = Arc::new(GitServer {
            git: Some(Store::new(Arc::new(svc), StoreOptions::default())),
            ..GitServer::default()
        });
        HistFake {
            _dirs: (r, g),
            root,
            git_dir,
            outs,
            argvs,
            s,
        }
    }

    fn initial(oid: &str) -> Self {
        let f = Self::new();
        f.outs.lock().unwrap().status = format!("# branch.oid {oid}\0# branch.head main\0");
        std::fs::write(format!("{}/HEAD", f.git_dir), "ref: refs/heads/main\n").unwrap();
        f
    }

    fn calls(&self) -> Vec<String> {
        self.argvs.lock().unwrap().clone()
    }

    async fn get(&self, target: &str) -> (u16, Value) {
        let r = req(&self.s, "GET", target, "").await;
        (r.code, r.json())
    }
}

fn log_rec(oid: &str, parents: &str, dec: &str, subject: &str) -> String {
    [
        oid,
        &oid[..4],
        parents,
        "김 동민",
        "dy@example.com",
        "1700000000",
        "1700000060",
        dec,
        subject,
    ]
    .join("\0")
}

fn detail_rec(oid: &str, parents: &str, subject: &str, body: &str) -> String {
    [
        oid,
        &oid[..4],
        parents,
        "김 동민",
        "dy@example.com",
        "1700000000",
        "1700000060",
        "",
        subject,
        "커미터",
        "c@example.com",
        body,
    ]
    .join("\0")
}

fn endpoints() -> [String; 3] {
    let r = qe(&abs(&["r"]));
    [
        format!("/api/git/log?repo={r}"),
        format!("/api/git/commit?repo={r}&oid={OID}"),
        format!("/api/git/refs?repo={r}"),
    ]
}

#[tokio::test]
async fn routes_and_unavailable() {
    let s = Arc::new(GitServer::default());
    for ep in endpoints() {
        let path = ep.split('?').next().unwrap();
        assert!(
            dm_webserver_httproute::dispatch(&crate::routes::ROUTES, "GET", path).is_some(),
            "{path}"
        );
        let r = req(&s, "GET", &ep, "").await;
        assert_eq!(
            (r.code, r.json()["error"].clone()),
            (503, json!("git_unavailable")),
            "{ep}"
        );
    }
}

#[tokio::test]
async fn log_echoes_requested() {
    let f = HistFake::new();
    f.outs.lock().unwrap().log = [
        log_rec(
            OID,
            O1,
            "HEAD -> refs/heads/main, tag: refs/tags/v1.0",
            "머지 · 제목",
        ),
        log_rec(O1, "", "", "root"),
    ]
    .join("\0");
    let sub = format!("{}/sub", f.root);
    let (code, out) = f
        .get(&format!(
            "/api/git/log?repo={sub}&ref=refs/heads/main&skip=300&limit=100&order=topo\
             &author=%EA%B9%80&since=2024-01-01&until=2024-02-01&path=d+ir%2Fa.txt&grep=fix"
        ))
        .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        out["requested"],
        json!({"repo": sub, "ref": "refs/heads/main", "skip": 300, "limit": 100, "order": "topo",
               "author": "김", "since": "2024-01-01", "until": "2024-02-01", "path": "d ir/a.txt",
               "grep": "fix", "reflog": false})
    );
    assert_eq!(out["repo"], f.root);
    let cs = out["commits"].as_array().unwrap();
    assert_eq!(cs.len(), 2);
    assert_eq!(cs[0]["oid"], OID);
    assert_eq!(cs[0]["parents"].as_array().unwrap().len(), 1);
    assert_eq!(cs[1]["parents"], json!([]));
    assert_eq!(cs[0]["isHead"], true);
    assert_eq!(
        cs[0]["refs"][0],
        json!({"name": "main", "kind": "local", "isHead": true})
    );
    assert_eq!(
        (
            cs[0]["refs"][1]["name"].clone(),
            cs[0]["refs"][1]["kind"].clone()
        ),
        (json!("v1.0"), json!("tag"))
    );
}

#[tokio::test]
async fn log_stop_sends_head_only() {
    const N1: &str = "c1c2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
    let f = HistFake::new();
    f.outs.lock().unwrap().log = [
        log_rec(N1, OID, "HEAD -> refs/heads/main", "새 커밋"),
        log_rec(OID, O1, "tag: refs/tags/v1.0", "머지"),
        log_rec(O1, "", "", "root"),
    ]
    .join("\0");
    let (code, out) = f
        .get(&format!(
            "/api/git/log?repo={}&limit=300&stop={OID}",
            f.root
        ))
        .await;
    assert_eq!(code, 200, "{out}");
    let cs = out["commits"].as_array().unwrap();
    assert_eq!((cs.len(), cs[0]["oid"].clone()), (1, json!(N1)));
    assert_eq!(out["requested"]["stop"], OID);
    let tail = &out["tail"];
    assert_eq!(tail["count"], 2);
    // FNV-1a 32 of "OID\nO1\n".
    assert_eq!(tail["digest"], fnv(&[OID, O1]));
    assert_eq!(tail["refs"].as_array().unwrap().len(), 1);
    assert_eq!(
        (
            tail["refs"][0]["i"].clone(),
            tail["refs"][0]["isHead"].clone()
        ),
        (json!(0), json!(false))
    );

    let (_, out) = f
        .get(&format!("/api/git/log?repo={}&stop=deadbeef", f.root))
        .await;
    assert_eq!(out["commits"].as_array().unwrap().len(), 3);
    assert!(out.get("tail").is_none());
    let (_, out) = f.get(&format!("/api/git/log?repo={}", f.root)).await;
    assert!(out.get("tail").is_none());
    assert!(out["requested"].get("stop").is_none());
    let (code, out) = f
        .get(&format!("/api/git/log?repo={}&skip=100&stop={OID}", f.root))
        .await;
    assert_eq!(code, 400);
    assert_eq!(out["message"], "stop 은 skip 과 함께 쓸 수 없다");
}

fn fnv(oids: &[&str]) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for o in oids {
        for b in o.bytes().chain([b'\n']) {
            h ^= u32::from(b);
            h = h.wrapping_mul(0x0100_0193);
        }
    }
    format!("{h:08x}")
}

// Go `TestGitOidDigest_Known` — 실제 응답으로 확인한다.
#[tokio::test]
async fn oid_digest_known() {
    let f = HistFake::new();
    f.outs.lock().unwrap().log = [log_rec("aaaa", "", "", "s")].join("\0");
    let (_, out) = f
        .get(&format!("/api/git/log?repo={}&stop=aaaa", f.root))
        .await;
    let mut h: u32 = 0x811c_9dc5;
    for b in "aaaa\n".bytes() {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    assert_eq!(out["tail"]["digest"], format!("{h:08x}"));
    assert_eq!(fnv(&[]), "811c9dc5");
    assert_eq!(fnv(&["a"]), "2524c6d2");
}

#[tokio::test]
async fn log_reports_effective_limit() {
    let f = HistFake::new();
    for (qs, want) in [("", 300), ("&limit=100", 100), ("&limit=999999", 2000)] {
        let (code, out) = f.get(&format!("/api/git/log?repo={}{qs}", f.root)).await;
        assert_eq!(code, 200, "{out}");
        assert_eq!(out["limit"], want, "{qs}");
    }
    let (_, out) = f.get(&format!("/api/git/log?repo={}", f.root)).await;
    assert_eq!(out["commits"], json!([]));
}

#[tokio::test]
async fn log_rejects_bad_params() {
    let f = HistFake::new();
    for qs in [
        "&order=reverse",
        "&skip=abc",
        "&limit=abc",
        "&skip=-1",
        "&ref=--all",
        "&reflog=yes",
    ] {
        let (code, out) = f.get(&format!("/api/git/log?repo={}{qs}", f.root)).await;
        assert_eq!(
            (code, out["error"].clone()),
            (400, json!("bad_request")),
            "{qs}"
        );
    }
    assert!(f.calls().is_empty(), "거부했는데 실행했다: {:?}", f.calls());
    let (_, out) = f
        .get(&format!("/api/git/log?repo={}&skip=abc", f.root))
        .await;
    assert_eq!(out["message"], "skip 는 0 이상의 정수여야 한다: abc");
    let (_, out) = f
        .get(&format!("/api/git/log?repo={}&reflog=yes", f.root))
        .await;
    assert_eq!(out["message"], "reflog 는 참·거짓이어야 한다: yes");
}

#[tokio::test]
async fn log_reflog_toggle() {
    for (qs, want) in [
        ("", false),
        ("&reflog=0", false),
        ("&reflog=1", true),
        ("&reflog=true", true),
        ("&reflog=T", true),
    ] {
        let f = HistFake::new();
        let (code, out) = f.get(&format!("/api/git/log?repo={}{qs}", f.root)).await;
        assert_eq!(code, 200, "{qs}: {out}");
        assert_eq!(out["requested"]["reflog"], want, "{qs}");
        let call = f.calls().join(" | ");
        assert_eq!(call.contains(" --reflog "), want, "{qs}: {call}");
    }
}

#[tokio::test]
async fn commit_echoes_requested() {
    let f = HistFake::new();
    {
        let mut o = f.outs.lock().unwrap();
        o.log = detail_rec(OID, "p1 p2", "머지 제목", "머지 제목\n\n본문\n");
        o.tree = "R100\0old name.txt\0d ir/한글 파일.txt\0".to_owned();
    }
    let sub = format!("{}/sub", f.root);
    let (code, out) = f
        .get(&format!("/api/git/commit?repo={sub}&oid={OID}&parent=1"))
        .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(
        out["requested"],
        json!({"repo": sub, "oid": OID, "parent": 1})
    );
    assert_eq!(out["repo"], f.root);
    assert_eq!(out["parentIndex"], 1);
    assert_eq!(out["committerName"], "커미터");
    assert_eq!(out["body"], "머지 제목\n\n본문\n");
    assert_eq!(out["files"].as_array().unwrap().len(), 1);
    let f0 = &out["files"][0];
    assert_eq!(
        (
            f0["status"].as_str(),
            f0["path"].as_str(),
            f0["origPath"].as_str()
        ),
        (Some("R"), Some("d ir/한글 파일.txt"), Some("old name.txt"))
    );
    let calls = f.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[1].ends_with(&format!("{OID}^2 {OID}")), "{calls:?}");
}

#[tokio::test]
async fn commit_rejects_bad_params() {
    let f = HistFake::new();
    f.outs.lock().unwrap().log = detail_rec(OID, "p1", "s", "s\n");
    for qs in [
        "".to_owned(),
        format!("&oid={OID}&parent=abc"),
        format!("&oid={OID}&parent=1"),
        format!("&oid={OID}&parent=-1"),
        "&oid=--all".to_owned(),
    ] {
        let (code, out) = f.get(&format!("/api/git/commit?repo={}{qs}", f.root)).await;
        assert_eq!(
            (code, out["error"].clone()),
            (400, json!("bad_request")),
            "{qs}"
        );
    }
    let (_, out) = f.get(&format!("/api/git/commit?repo={}", f.root)).await;
    assert_eq!(out["message"], "oid 인자가 없다");
}

#[tokio::test]
async fn commit_unknown_oid_is_not_found() {
    let f = HistFake::new();
    let (code, out) = f
        .get(&format!("/api/git/commit?repo={}&oid={OID}", f.root))
        .await;
    assert_eq!(
        (code, out["error"].clone()),
        (404, json!("not_found")),
        "{out}"
    );
}

#[tokio::test]
async fn refs_echoes_requested() {
    let f = HistFake::new();
    f.outs.lock().unwrap().refs = [
        [
            "refs/heads/main",
            "aa",
            "origin/main",
            "[ahead 2, behind 1]",
            "*",
            "제목",
            "1700000000",
        ]
        .join("\0"),
        [
            "refs/remotes/origin/main",
            "bb",
            "",
            "",
            " ",
            "제목",
            "1700000001",
        ]
        .join("\0"),
        ["refs/tags/v1.0", "cc", "", "", " ", "제목", "1700000002"].join("\0"),
    ]
    .join("\n")
        + "\n";
    let sub = format!("{}/sub", f.root);
    let (code, out) = f.get(&format!("/api/git/refs?repo={sub}")).await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["requested"], json!({"repo": sub}));
    assert_eq!(out["repo"], f.root);
    let refs = out["refs"].as_array().unwrap();
    assert_eq!(refs.len(), 3);
    for (k, v) in [
        ("name", json!("refs/heads/main")),
        ("short", json!("main")),
        ("kind", json!("local")),
        ("oid", json!("aa")),
        ("upstream", json!("origin/main")),
        ("ahead", json!(2)),
        ("behind", json!(1)),
        ("isHead", json!(true)),
        ("atUnixMs", json!(1_700_000_000_000_i64)),
    ] {
        assert_eq!(refs[0][k], v, "{k}");
    }
    assert_eq!(
        (refs[1]["kind"].clone(), refs[2]["kind"].clone()),
        (json!("remote"), json!("tag"))
    );
    // 원격 ref 는 원격 이름을 가른다 (GT-e).
    assert_eq!(refs[1]["remote"], "origin");
    f.outs.lock().unwrap().refs.clear();
    let (_, out) = f.get(&format!("/api/git/refs?repo={}", f.root)).await;
    assert_eq!(out["refs"], json!([]));
}

#[tokio::test]
async fn history_repo_param() {
    let f = HistFake::new();
    for ep in ["/api/git/log", "/api/git/refs", "/api/git/commit"] {
        for qs in ["", "?repo=relative/path"] {
            let (code, out) = f.get(&format!("{ep}{qs}")).await;
            assert_eq!(
                (code, out["error"].clone()),
                (400, json!("bad_request")),
                "{ep}{qs}"
            );
        }
    }
}

#[tokio::test]
async fn initial_without_observation_empty_list() {
    let f = HistFake::initial("(initial)");
    let (code, out) = f.get(&format!("/api/git/log?repo={}", f.root)).await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["initial"], true);
}

#[tokio::test]
async fn initial_without_observation_exit128() {
    let f = HistFake::initial("(initial)");
    f.outs.lock().unwrap().log_fail = true;
    let r = req(&f.s, "GET", &format!("/api/git/log?repo={}", f.root), "").await;
    assert_eq!(r.code, 200, "{}", r.text());
    let out = r.json();
    assert_eq!(out["initial"], true);
    assert_eq!(out["commits"], json!([]));
    assert_eq!(out["signature"], "");
}

#[tokio::test]
async fn not_initial_when_observation_has_commit() {
    let f = HistFake::initial("1111111111111111111111111111111111111111");
    let (code, out) = f
        .get(&format!("/api/git/log?repo={}&author=nobody", f.root))
        .await;
    assert_eq!(code, 200, "{out}");
    assert!(out.get("initial").is_none_or(|v| v == false));
}

#[tokio::test]
async fn rejected_does_not_observe() {
    let f = HistFake::initial("(initial)");
    let (code, _) = f
        .get(&format!("/api/git/log?repo={}&order=reverse", f.root))
        .await;
    assert_eq!(code, 400);
    assert!(f.calls().is_empty(), "{:?}", f.calls());
}
