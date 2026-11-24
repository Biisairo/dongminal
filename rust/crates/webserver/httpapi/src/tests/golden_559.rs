//! 5.5.9 종단의 Go 골든 대조. 기대값은 go1.27.2 기준선의 핸들러를 임시 시험으로 돌려 뽑았다. 세대
//! 파일의 시각(`modified`)은 양쪽에서 가린다.

use std::sync::Arc;

use otter_gocompat::json::RawMessage;
use otter_shared_chatwire as chatwire;
use otter_shared_toolipc::{
    CHAT_KIND_CHANGED, CHAT_KIND_MSG, ChatEvent, ChatResult, EdgeParams, EdgePortParams, EdgeRef,
    EdgeResult, EdgesEvent,
};
use otter_webserver_domain_ext as ext;

use super::claude_accounts::NoSecrets;
use super::fakes::FakeBroker;
use super::fsenv::FakeWork;
use super::lsp::FakeLsp;
use super::peer::FakeChat;
use super::support::*;
use crate::{ClaudeHooks, Config, Deps, EdgeDaemon, Server};

/// Go 임시 시험의 `zzEdge`.
struct ZzEdge;

impl EdgeDaemon for ZzEdge {
    fn edge_ready(&self) -> bool {
        true
    }
    fn edge(&self, p: EdgeParams) -> Result<EdgeResult, String> {
        if p.op == "profile_name" {
            return Ok(EdgeResult {
                status: 409,
                code: "edge_stale".into(),
                message: "바뀌었다".into(),
                etag: "\"e2\"".into(),
                ..Default::default()
            });
        }
        Ok(EdgeResult {
            status: 200,
            body: RawMessage(format!(r#"{{"op":"{}"}}"#, p.op).into_bytes()),
            etag: "\"e1\"".into(),
            ..Default::default()
        })
    }
    fn edge_port(&self, _: EdgePortParams) -> Result<(), String> {
        Ok(())
    }
}

fn canon(k: &str) -> String {
    k.split('-')
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                Some(f) => f.to_ascii_uppercase().to_string() + &c.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn mask(s: &str) -> String {
    let re = regex::Regex::new(r#"\\"modified\\":\\"[^\\]*\\""#).unwrap();
    re.replace_all(s, r#"\"modified\":\"T\""#).into_owned()
}

fn dump(m: &str, p: &str, r: &Resp) -> String {
    let mut hs: Vec<String> = r
        .headers
        .iter()
        .filter(|(k, _)| k.as_str() != "x-request-id")
        .map(|(k, v)| format!("{}={}", canon(k.as_str()), v.to_str().unwrap()))
        .collect();
    hs.sort();
    format!(
        "== {m} {p}\n{} {}\n{}\n",
        r.status,
        hs.join("|"),
        otter_gocompat::strconv::quote(&r.body)
    )
}

#[tokio::test]
async fn golden_559() {
    let data = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    std::fs::write(data.path().join("workspace.json.bak.1"), "{bad").unwrap();
    let cmds = Arc::new(FakeBroker::default());
    let lsp = FakeLsp {
        statuses: vec![ext::Status {
            pack: "gopls".into(),
            id: "gopls".into(),
            langs: vec!["go".into()],
            found: true,
            exe: "/usr/bin/gopls".into(),
            origin: "path".into(),
            ..Default::default()
        }],
        problems: vec!["x.json: 깨졌다".into()],
        outcome: ext::Outcome {
            reason: "없다".into(),
            ..Default::default()
        },
        ..Default::default()
    };
    lsp.paths
        .lock()
        .unwrap()
        .extend([("b".into(), "/b".into()), ("a".into(), "/a".into())]);
    let srv = Server::new(
        Config {
            data_dir: data.path().to_path_buf(),
            claude_home: home.path().to_path_buf(),
            claude_api: "http://127.0.0.1:0".into(),
            ..Config::default()
        },
        Deps {
            commands: Some(cmds.clone()),
            work: Some(Arc::new(FakeWork::default())),
            lsp: Some(Arc::new(lsp)),
            edge_daemon: Some(Arc::new(ZzEdge)),
            chat_daemon: Some(Arc::new(FakeChat {
                ready: true,
                res: ChatResult {
                    result: RawMessage(br#"{"me":{"id":"u"}}"#.to_vec()),
                    ..Default::default()
                },
                ..Default::default()
            })),
            claude: ClaudeHooks {
                secrets: Some(Arc::new(NoSecrets)),
                procs: Some(Arc::new(|| Ok(Vec::new()))),
            },
            ..Deps::default()
        },
    );
    let bare = Server::new(Config::default(), Deps::default());
    let s = &srv;
    let b = &bare;
    let reqs: Vec<(&Arc<Server>, &str, &str, &str)> = vec![
        (s, "GET", "/api/chat", ""),
        (s, "POST", "/api/chat/send", r#"{"room":"r"}"#),
        (s, "POST", "/api/chat/send", "{"),
        (s, "GET", "/api/edges", ""),
        (s, "PUT", "/api/edges/node", r#"{"a":1}"#),
        (s, "PUT", "/api/profile", r#"{"name":"x"}"#),
        (s, "GET", "/api/snapshot?parts=edges,focus", ""),
        (s, "POST", "/api/lsp/status", "{}"),
        (s, "GET", "/api/lsp/paths", ""),
        (s, "PUT", "/api/lsp/paths", "{bad"),
        (s, "PUT", "/api/lsp/paths", r#"{"paths":{"z":"/z"}}"#),
        (s, "POST", "/api/lsp/install", "{}"),
        (s, "POST", "/api/lsp/install", r#"{"id":"gopls"}"#),
        (s, "GET", "/api/lsp/ws?root=&server=x", ""),
        (s, "GET", "/api/telegram", ""),
        (s, "PUT", "/api/telegram/token", r#"{"token":"x"}"#),
        (s, "PUT", "/api/telegram/token", "{bad"),
        (s, "PUT", "/api/telegram/silence", r#"{"minutes":-1}"#),
        (s, "PUT", "/api/telegram/enabled", r#"{"enabled":true}"#),
        (s, "POST", "/api/telegram/pair", ""),
        (s, "DELETE", "/api/telegram/pair", ""),
        (s, "GET", "/api/claude-accounts", ""),
        (s, "POST", "/api/claude-accounts/add", "{}"),
        (s, "GET", "/api/claude-accounts/history?limit=0", ""),
        (s, "GET", "/api/claude-accounts/history", ""),
        (s, "GET", "/api/claude-accounts/autoswitch", ""),
        (
            s,
            "PUT",
            "/api/claude-accounts/autoswitch",
            r#"{"threshold":10}"#,
        ),
        (s, "GET", "/api/claude-accounts/mappings", ""),
        (s, "PUT", "/api/claude-accounts/mappings", "{}"),
        (s, "GET", "/api/claude-accounts/resolve?cwd=rel", ""),
        (s, "GET", "/api/claude-accounts/unclaimed", ""),
        (
            s,
            "PUT",
            "/api/claude-accounts/item",
            r#"{"id":"nope","alias":"x"}"#,
        ),
        (
            s,
            "POST",
            "/api/claude-accounts/switch",
            r#"{"strategy":"next"}"#,
        ),
        (s, "GET", "/api/workspace/revisions", ""),
        (s, "POST", "/api/workspace/revert", r#"{"gen":9}"#),
        (s, "POST", "/api/workspace/revert", r#"{"gen":2}"#),
        (s, "POST", "/api/workspace/revert", r#"{"gen":1}"#),
        (s, "POST", "/api/workspace/revert", "nope"),
        (b, "GET", "/api/chat", ""),
        (b, "GET", "/api/edges", ""),
        (b, "GET", "/api/telegram", ""),
        (b, "GET", "/api/claude-accounts", ""),
        (b, "POST", "/api/lsp/status", ""),
        (b, "POST", "/api/workspace/revert", r#"{"gen":1}"#),
    ];
    let mut got = String::new();
    for (srv, m, p, body) in reqs {
        let mut hs = vec![("Host", "127.0.0.1")];
        if matches!(m, "POST" | "PUT" | "DELETE") {
            hs.push(("Content-Type", "application/json"));
        }
        let r = call(srv, m, p, &hs, body, LOCAL).await;
        got.push_str(&dump(m, p, &r));
    }
    cmds.published.lock().unwrap().clear();
    srv.chat_pushed(&ChatEvent {
        chat_kind: CHAT_KIND_MSG.into(),
        chat: Some(chatwire::Message {
            id: "m1".into(),
            text: "<b>hi</b>".into(),
            ..Default::default()
        }),
        ..Default::default()
    });
    srv.chat_pushed(&ChatEvent {
        chat_kind: CHAT_KIND_CHANGED.into(),
        ..Default::default()
    });
    srv.edge_pushed(&EdgesEvent {
        removed: Some(EdgeRef {
            fp: "ab".repeat(32),
            name: "노트북".into(),
        }),
        by_peer: true,
        paired: Some(EdgeRef {
            fp: "cd".into(),
            name: "p".into(),
        }),
        ..Default::default()
    });
    srv.edge_resync();
    for p in cmds.published() {
        got.push_str(&format!(
            "== BCAST\n{}\n",
            otter_gocompat::strconv::quote(&p)
        ));
    }
    let want = include_str!("go_golden_559.txt");
    let (got, want) = (mask(&got), mask(want));
    for (i, (g, w)) in got.lines().zip(want.lines()).enumerate() {
        assert_eq!(g, w, "줄 {}", i + 1);
    }
    assert_eq!(got.lines().count(), want.lines().count());
}
