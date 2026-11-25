use std::fs;

use otter_shared_workspace::{FilePersister, Liveness};

use super::*;

#[derive(Default)]
struct FakeHub {
    list: Vec<HubToolInfo>,
}

impl ToolSource for FakeHub {
    fn list(&self) -> Vec<HubToolInfo> {
        self.list.clone()
    }
    fn has(&self, id: &str) -> bool {
        self.list.iter().any(|m| m.id == id)
    }
    fn snapshot_tool(&self, id: &str) -> Result<ToolSnapshot, Error> {
        if self.has(id) {
            Ok(ToolSnapshot::default())
        } else {
            Err("tool not found".into())
        }
    }
    fn screen_text(&self, id: &str, bytes: usize) -> Result<String, Error> {
        if self.has(id) {
            Ok(format!("{id}:{bytes}\n"))
        } else {
            Err("tool not found".into())
        }
    }
    fn send_paste(&self, id: &str, _: &[u8], _: bool) -> Result<(), Error> {
        if self.has(id) {
            Ok(())
        } else {
            Err("tool not found".into())
        }
    }
}

fn tool_of(list: Vec<HubToolInfo>) -> Tool {
    Tool {
        hub: Some(Arc::new(FakeHub { list })),
    }
}

fn info(id: &str, pid: i64) -> HubToolInfo {
    HubToolInfo {
        id: id.into(),
        name: "Shell".into(),
        pid,
        ..Default::default()
    }
}

#[test]
fn tool_adapter_empty_hub() {
    let a = tool_of(vec![]);
    assert!(a.list().is_empty());
    assert!(!a.has("nope"));
    assert_eq!(a.snapshot("nope"), None);
    assert_eq!(a.screen_text("nope", 0), None);
    assert_eq!(Tool::default().screen_text("nope", 0), None);
    assert_eq!(a.size("nope"), "?");
    assert!(a.send_paste("nope", b"x", false).is_err());
    let e = Tool::default().send_paste("nope", b"x", false).unwrap_err();
    assert_eq!(e.to_string(), "tool 없음: nope");
}

#[test]
fn tool_adapter_daemon_list_shell_pid() {
    let a = tool_of(vec![HubToolInfo {
        cols: 120,
        rows: 40,
        ..info("1", 4242)
    }]);
    let got = a.list();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].shell_pid, 4242);
    assert_eq!(a.size("1"), "120x40");
    assert_eq!(a.screen_text("1", 16).as_deref(), Some("1:16\n"));
}

#[test]
fn tool_adapter_foreground_name() {
    let a = tool_of(vec![HubToolInfo {
        fg_name: "claude".into(),
        ..info("1", 4242)
    }]);
    assert_eq!(a.list()[0].foreground_name, "claude");
    assert_eq!(tool_of(vec![info("1", 1)]).list()[0].foreground_name, "");
}

#[test]
fn client_resolver_unknown_addr() {
    let c = Client {
        hub: Some(Arc::new(FakeHub {
            list: vec![info("7", i64::from(std::process::id() as i32))],
        })),
    };
    let e = c.resolve_client_pane("127.0.0.1:1").unwrap_err();
    assert_eq!(
        e.to_string(),
        "클라이언트 PID를 찾을 수 없음 (remoteAddr=127.0.0.1:1)"
    );
}

struct NoLive;
impl Liveness for NoLive {
    fn is_live(&self, _: &str) -> bool {
        false
    }
}

fn ws_with(blob: Option<&[u8]>) -> (tempfile::TempDir, Workspace) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ws.json");
    if let Some(b) = blob {
        fs::write(&path, b).unwrap();
    }
    let m = Manager::new(Arc::new(NoLive), Arc::new(FilePersister::new(path))).unwrap();
    (dir, Workspace { ws: Arc::new(m) })
}

#[test]
fn workspace_adapter_resolve_and_entries() {
    let (_d, a) = ws_with(None);
    assert!(a.entries().is_empty());
    assert!(a.resolve("nonexistent").is_err());
    a.ws.close();
}

#[test]
fn workspace_adapter_entries_shape() {
    let blob = br#"{"schemaVersion": 2, "windows":[{"id":"s1","name":"S","layout":{"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"T","toolId":"42"}]}}],"activeWindow":"s1"}"#;
    let (_d, a) = ws_with(Some(blob));
    let e = a.entries();
    assert_eq!(e.len(), 1, "{e:?}");
    assert_eq!(e[0].tool_id, "42");
    assert_eq!(e[0].label, "W1.P1.T1");
    a.ws.close();
}
