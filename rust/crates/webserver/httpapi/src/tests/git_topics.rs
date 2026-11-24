//! git 토픽 (`docs/internal/perf/CHANNEL_PROTOCOL.md` §10.5 C4). 실제 git 저장소와 실제 WS 로 잰다.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use otter_webserver_domain_git_core::{Ctx, Service};
use otter_webserver_domain_git_store::{Store, StoreOptions};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use super::ws::listen;
use crate::{Config, Deps, Server};

type Client =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const WAIT: Duration = Duration::from_secs(5);

struct Env {
    _dir: tempfile::TempDir,
    _repo: tempfile::TempDir,
    root: String,
    srv: Arc<Server>,
    port: u16,
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?}");
}

async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q"]);
    std::fs::write(repo.path().join("a.txt"), "a").unwrap();
    git(repo.path(), &["add", "."]);
    git(repo.path(), &["commit", "-qm", "a"]);
    let root = std::fs::canonicalize(repo.path())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let srv = Server::new(
        Config {
            data_dir: dir.path().to_path_buf(),
            ..Config::default()
        },
        Deps {
            git_store: Some(Store::new(
                Arc::new(Service::new()),
                StoreOptions::default(),
            )),
            ..Deps::default()
        },
    );
    let port = listen(srv.clone()).await;
    Env {
        _dir: dir,
        _repo: repo,
        root,
        srv,
        port,
    }
}

async fn open(port: u16) -> Client {
    let (mut c, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/channel?v=1"))
        .await
        .unwrap();
    c.send(Message::text(json!({"t":"hello","slots":[]}).to_string()))
        .await
        .unwrap();
    assert_eq!(next(&mut c).await.unwrap()["t"], "hello");
    c
}

async fn next(c: &mut Client) -> Option<Value> {
    loop {
        match tokio::time::timeout(WAIT, c.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            _ => return None,
        }
    }
}

async fn sub(c: &mut Client, topic: &str) {
    c.send(Message::text(json!({"t":"sub","topic":topic}).to_string()))
        .await
        .unwrap();
}

async fn send(c: &mut Client, v: Value) {
    c.send(Message::text(v.to_string())).await.unwrap();
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !f() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(f(), "{what}");
}

/// TC-CH4-7: `git:<root>` 의 full 은 관측(repo·mark)이다. 구독하는 동안 서버가 그 저장소를
/// 감시하고, 바뀌면 새 mark 의 full 을 민다.
#[tokio::test]
async fn git_topic_full_then_change_pushes_new_mark() {
    let e = env().await;
    let topic = format!("git:{}", e.root);
    let mut c = open(e.port).await;
    sub(&mut c, &topic).await;
    let v = next(&mut c).await.unwrap();
    assert_eq!(v["t"], "full", "{v}");
    assert_eq!(v["data"]["repo"], e.root.as_str());
    let first = v["data"]["mark"].as_str().unwrap_or_default().to_owned();
    assert!(!first.is_empty(), "{v}");

    let w = e.srv.git_watch.clone().unwrap();
    until("구독이 감시를 세우지 않았다", || {
        w.watching() == 1
    })
    .await;

    std::fs::write(std::path::Path::new(&e.root).join("b.txt"), "b").unwrap();
    let mut got = None;
    for _ in 0..20 {
        w.tick(&Ctx::background()).await;
        if let Ok(Some(v)) = tokio::time::timeout(Duration::from_millis(200), next(&mut c)).await {
            got = Some(v);
            break;
        }
    }
    let v = got.expect("변화가 오지 않았다");
    assert_eq!(v["t"], "full", "{v}");
    assert_ne!(v["data"]["mark"], first.as_str(), "{v}");
}

/// TC-CH4-8: 진행 중 git 작업은 `git.jobs` full 이다.
#[tokio::test]
async fn git_jobs_topic_full() {
    let e = env().await;
    let mut c = open(e.port).await;
    sub(&mut c, "git.jobs").await;
    let v = next(&mut c).await.unwrap();
    assert_eq!(v["t"], "full", "{v}");
    assert_eq!(v["data"], json!({"jobs": []}));
}

/// TC-CH4-9: 없는 잡의 `gitjob:<id>` 는 모르는 토픽이다.
#[tokio::test]
async fn gitjob_unknown_is_unknown_topic() {
    let e = env().await;
    let mut c = open(e.port).await;
    sub(&mut c, "gitjob:없는것").await;
    let v = next(&mut c).await.unwrap();
    assert_eq!(v["t"], "error", "{v}");
    assert_eq!(v["code"], "unknown_topic");
    send(&mut c, json!({"t":"ping","n":1})).await;
    assert_eq!(next(&mut c).await.unwrap()["t"], "pong");
}
