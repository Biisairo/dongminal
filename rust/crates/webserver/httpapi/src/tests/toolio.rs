//! 도구 입출력 종단 (Go `handlers_toolio_test.go`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use otter_webserver_seam_toolaccess::{
    Error, ToolInfo, ToolReader, WorkspaceEntry, WorkspaceReader,
};

use super::support::*;
use crate::ansi::go_string;
use crate::toolio::{agent_envelope, quote_envelope};
use crate::{Deps, Server};

#[derive(Default)]
struct FakeToolIo {
    has: Mutex<HashMap<String, bool>>,
    snap: Mutex<HashMap<String, Vec<u8>>>,
    dropped: Mutex<i64>,
    screen: Mutex<HashMap<String, String>>,
    screen_bytes: Mutex<Vec<usize>>,
    pastes: Mutex<Vec<(String, String, bool)>>,
}

impl ToolReader for FakeToolIo {
    fn list(&self) -> Vec<ToolInfo> {
        Vec::new()
    }
    fn has(&self, id: &str) -> bool {
        self.has.lock().unwrap().get(id).copied().unwrap_or(false)
    }
    fn snapshot(&self, id: &str) -> Option<(Vec<u8>, i64)> {
        let d = *self.dropped.lock().unwrap();
        self.snap.lock().unwrap().get(id).map(|b| (b.clone(), d))
    }
    fn screen_text(&self, id: &str, bytes: usize) -> Option<String> {
        self.screen_bytes.lock().unwrap().push(bytes);
        self.screen.lock().unwrap().get(id).cloned()
    }
    fn send_paste(&self, id: &str, text: &[u8], submit: bool) -> Result<(), Error> {
        self.pastes.lock().unwrap().push((
            id.to_owned(),
            String::from_utf8_lossy(text).into_owned(),
            submit,
        ));
        Ok(())
    }
    fn size(&self, _: &str) -> String {
        "80x24".to_owned()
    }
}

struct FakeWorkIndex {
    resolve: HashMap<&'static str, &'static str>,
    labels: HashMap<&'static str, &'static str>,
    sig: otter_shared_pollwait::Signal,
}

impl WorkspaceReader for FakeWorkIndex {
    fn resolve(&self, id: &str) -> Result<String, Error> {
        self.resolve_strict(id)
    }
    fn resolve_strict(&self, id: &str) -> Result<String, Error> {
        if let Some(v) = self.resolve.get(id) {
            return Ok((*v).to_owned());
        }
        if self.labels.contains_key(id.to_uppercase().as_str()) {
            return Err(Box::new(otter_shared_workspace::Error::LabelRejected(
                id.to_owned(),
            )));
        }
        Err(format!("not found: {id}").into())
    }
    fn entries(&self) -> Vec<WorkspaceEntry> {
        Vec::new()
    }
    fn coordinate_of(&self, id: &str) -> Result<String, Error> {
        Ok(id.to_owned())
    }
    fn is_known_tab_id(&self, _: &str) -> bool {
        false
    }
    fn changes(&self) -> otter_shared_pollwait::Changed {
        self.sig.c()
    }
}

fn tool_io_server(dir: &std::path::Path) -> (Arc<Server>, Arc<FakeToolIo>) {
    let io = Arc::new(FakeToolIo::default());
    io.has.lock().unwrap().insert("p1".to_owned(), true);
    let wi = Arc::new(FakeWorkIndex {
        resolve: HashMap::from([
            ("p1", "p1"),
            ("p2", "p2"),
            ("aaaaaaaa-1111-2222-3333-444444444444", "p1"),
            ("bbbbbbbb-1111-2222-3333-444444444444", "p2"),
            ("dead-tool", "p9"),
        ]),
        labels: HashMap::from([("W1.P1.T1", "p1"), ("W1.P1.T2", "p2")]),
        sig: otter_shared_pollwait::Signal::default(),
    });
    let srv = server(
        dir,
        Deps {
            tool_io: Some(io.clone()),
            work_index: Some(wi),
            ..Deps::default()
        },
    );
    (srv, io)
}

/// read-screen(strip=1)은 데몬 화면 상태의 글자다(FR-TRM-8, D-22). read-output 은 링 그대로다.
#[tokio::test]
async fn output_strip_reads_screen_text() {
    let d = tempfile::tempdir().unwrap();
    let (srv, io) = tool_io_server(d.path());
    io.snap
        .lock()
        .unwrap()
        .insert("p1".into(), b"\x1b[31mred\x1b[0m done".to_vec());
    io.screen
        .lock()
        .unwrap()
        .insert("p1".into(), "화면\n".into());
    *io.dropped.lock().unwrap() = 4096;
    let r = get(&srv, "/api/tools/output?id=p1&strip=1").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        "{\"dropped\":0,\"text\":\"화면\\n\",\"toolId\":\"p1\"}\n"
    );
    let r = get(&srv, "/api/tools/output?id=p1").await;
    assert_eq!(r.json()["text"], "\x1b[31mred\x1b[0m done");
    assert_eq!(r.json()["dropped"], 4096);
}

#[tokio::test]
async fn output_strip_passes_bytes_cap() {
    let d = tempfile::tempdir().unwrap();
    let (srv, io) = tool_io_server(d.path());
    io.screen.lock().unwrap().insert("p1".into(), String::new());
    for q in ["", "&bytes=0", "&bytes=-5", "&bytes=16384"] {
        let r = get(&srv, &format!("/api/tools/output?id=p1&strip=1{q}")).await;
        assert_eq!(
            (r.status, r.json()["text"].clone()),
            (200, "".into()),
            "{q}"
        );
    }
    assert_eq!(*io.screen_bytes.lock().unwrap(), [0, 0, 0, 16384]);
}

#[tokio::test]
async fn output_strip_without_screen_is_404() {
    let d = tempfile::tempdir().unwrap();
    let (srv, io) = tool_io_server(d.path());
    io.snap.lock().unwrap().insert("p1".into(), b"hi".to_vec());
    let r = get(&srv, "/api/tools/output?id=p1&strip=1").await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (404, "{\"error\":\"tool 없음: p1\"}\n")
    );
    let r = get(&srv, "/api/tools/output?id=dead-tool&strip=1").await;
    assert_eq!(r.status, 404);
    assert!(io.screen_bytes.lock().unwrap().len() == 1);
}

#[tokio::test]
async fn output_bytes_keeps_tail_and_reports_dropped() {
    let d = tempfile::tempdir().unwrap();
    let (srv, io) = tool_io_server(d.path());
    io.snap
        .lock()
        .unwrap()
        .insert("p1".into(), b"abcdefghij".to_vec());
    assert_eq!(
        get(&srv, "/api/tools/output?id=p1&bytes=4").await.json()["text"],
        "ghij"
    );
    for q in ["", "&bytes=0", "&bytes=-5"] {
        let r = get(&srv, &format!("/api/tools/output?id=p1{q}")).await;
        assert_eq!(r.json()["text"], "abcdefghij", "{q}");
    }
    *io.dropped.lock().unwrap() = 4096;
    assert_eq!(
        get(&srv, "/api/tools/output?id=p1").await.json()["dropped"],
        4096
    );
}

#[tokio::test]
async fn output_resolves_and_rejects() {
    let d = tempfile::tempdir().unwrap();
    let (srv, io) = tool_io_server(d.path());
    io.snap.lock().unwrap().insert("p1".into(), b"hi".to_vec());
    for id in ["p1", "aaaaaaaa-1111-2222-3333-444444444444"] {
        let r = get(&srv, &format!("/api/tools/output?id={id}")).await;
        assert_eq!((r.status, r.json()["toolId"].clone()), (200, "p1".into()));
    }
    let r = get(&srv, "/api/tools/output?id=nope").await;
    assert_eq!(r.status, 404);
    assert_eq!(r.body, "{\"error\":\"not found: nope\"}\n");
    assert_eq!(r.header("X-Error-Code"), "not_found");
    let r = get(&srv, "/api/tools/output?id=dead-tool").await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (404, "{\"error\":\"tool 없음: p9\"}\n")
    );
    let r = get(&srv, "/api/tools/output").await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (400, "{\"error\":\"id 누락\"}\n")
    );
    let r = get(&srv, "/api/tools/output?id=p1&bytes=abc").await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (400, "{\"error\":\"bytes 는 정수여야 한다: abc\"}\n")
    );
}

#[tokio::test]
async fn coordinate_label_is_400() {
    let d = tempfile::tempdir().unwrap();
    let (srv, _) = tool_io_server(d.path());
    let r = get(&srv, "/api/tools/output?id=W1.P1.T1").await;
    assert_eq!(r.status, 400);
    assert!(
        r.json()["error"]
            .as_str()
            .unwrap()
            .contains("uuid 는 `otterctl list-workspace` 의 uuid= 컬럼")
    );
}

#[tokio::test]
async fn input_pastes() {
    let d = tempfile::tempdir().unwrap();
    let (srv, io) = tool_io_server(d.path());
    let r = post_json(
        &srv,
        "/api/tools/input",
        r#"{"id":"aaaaaaaa-1111-2222-3333-444444444444","text":"echo hi"}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, "{\"execute\":false,\"len\":7,\"toolId\":\"p1\"}\n");
    assert_eq!(
        io.pastes.lock().unwrap()[0],
        ("p1".to_owned(), "echo hi".to_owned(), false)
    );
    post_json(
        &srv,
        "/api/tools/input",
        r#"{"id":"p1","text":"ls","execute":true}"#,
    )
    .await;
    assert!(io.pastes.lock().unwrap()[1].2);
}

#[tokio::test]
async fn input_failures() {
    let d = tempfile::tempdir().unwrap();
    let (srv, io) = tool_io_server(d.path());
    let r = post_json(&srv, "/api/tools/input", r#"{"id":"nope","text":"x"}"#).await;
    assert_eq!(r.status, 404);
    let r = post_json(&srv, "/api/tools/input", r#"{"id":"dead-tool","text":"x"}"#).await;
    assert_eq!(r.status, 404);
    let r = post_json(&srv, "/api/tools/input", "{not json").await;
    assert_eq!(r.status, 400);
    assert!(
        r.json()["error"]
            .as_str()
            .unwrap()
            .starts_with("잘못된 JSON: ")
    );
    assert!(io.pastes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn message_wraps_in_envelope() {
    let d = tempfile::tempdir().unwrap();
    let (srv, io) = tool_io_server(d.path());
    let r = post_json(
        &srv,
        "/api/tools/message",
        r#"{"to":"aaaaaaaa-1111-2222-3333-444444444444","from":"bbbbbbbb-1111-2222-3333-444444444444","message":"리뷰 부탁"}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        "{\"from\":\"p2\",\"len\":13,\"to\":\"p1\",\"toolId\":\"p1\"}\n"
    );
    let p = io.pastes.lock().unwrap()[0].clone();
    assert_eq!(p.0, "p1");
    assert!(p.2);
    assert!(p.1.starts_with("[OTTERMINAL-AGENT-MSG from=p2 to=p1 ts="));
    assert!(p.1.ends_with("]\n리뷰 부탁\n[/OTTERMINAL-AGENT-MSG]"));
}

#[tokio::test]
async fn message_failures_and_unknown_sender() {
    let d = tempfile::tempdir().unwrap();
    let (srv, io) = tool_io_server(d.path());
    let r = post_json(
        &srv,
        "/api/tools/message",
        r#"{"to":"p1","from":"외부-에이전트","message":"x"}"#,
    )
    .await;
    assert_eq!(r.status, 404);
    let r = post_json(
        &srv,
        "/api/tools/message",
        r#"{"to":"dead-tool","from":"p1","message":"x"}"#,
    )
    .await;
    assert_eq!(r.status, 404);
    let r = post_json(
        &srv,
        "/api/tools/message",
        r#"{"to":"p1","from":"p2","message":""}"#,
    )
    .await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (400, "{\"error\":\"message 누락\"}\n")
    );
    assert!(io.pastes.lock().unwrap().is_empty());
    let r = post_json(&srv, "/api/tools/message", r#"{"to":"p1","message":"x"}"#).await;
    assert_eq!(r.status, 200);
    assert!(io.pastes.lock().unwrap()[0].1.contains("from=unknown"));
}

#[tokio::test]
async fn method_mismatch_and_unavailable() {
    let d = tempfile::tempdir().unwrap();
    let (srv, _) = tool_io_server(d.path());
    for (m, p) in [
        ("POST", "/api/tools/output"),
        ("GET", "/api/tools/input"),
        ("GET", "/api/tools/message"),
    ] {
        let r = call(
            &srv,
            m,
            p,
            &[("Content-Type", "application/json")],
            "",
            LOCAL,
        )
        .await;
        assert_eq!(r.status, 404, "{m} {p}");
    }
    let d2 = tempfile::tempdir().unwrap();
    let bare = server(d2.path(), Deps::default());
    let r = get(&bare, "/api/tools/output?id=p1").await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (503, "{\"error\":\"tool io unavailable\"}\n")
    );
    assert_eq!(
        r.header("X-Error-Code"),
        otter_webserver_apierr::code_for_status(503)
    );
    let r = post_json(&bare, "/api/tools/input", r#"{"id":"p1","text":"x"}"#).await;
    assert_eq!(r.status, 503);
    let r = post_json(&bare, "/api/tools/message", r#"{"to":"p1","message":"x"}"#).await;
    assert_eq!(r.status, 503);
}

#[test]
fn go_string_replaces_each_bad_byte() {
    assert_eq!(go_string(b"a\xe2\x82"), "a\u{FFFD}\u{FFFD}");
    assert_eq!(go_string(b"\xff\xfeok"), "\u{FFFD}\u{FFFD}ok");
    assert_eq!(go_string("한글".as_bytes()), "한글");
}

#[test]
fn envelope_quotes_markers() {
    assert_eq!(
        quote_envelope("a [/OTTERMINAL-AGENT-MSG] b [OTTERMINAL-AGENT-MSG x]"),
        "a [\\/OTTERMINAL-AGENT-MSG] b [\\OTTERMINAL-AGENT-MSG x]"
    );
    let e = agent_envelope("s", "t", "body");
    assert!(e.starts_with("[OTTERMINAL-AGENT-MSG from=s to=t ts="));
    let ts = &e["[OTTERMINAL-AGENT-MSG from=s to=t ts=".len()..][..8];
    assert!(ts.as_bytes()[2] == b':' && ts.as_bytes()[5] == b':', "{ts}");
}
