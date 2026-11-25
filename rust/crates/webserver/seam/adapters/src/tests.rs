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

/// 연결 주인은 300, 표는 1 ← 100 ← 200 ← 300 이다. 부모 조회 횟수를 센다.
#[derive(Default)]
struct WalkInfo {
    parent_pid_calls: std::sync::atomic::AtomicUsize,
    parents_calls: std::sync::atomic::AtomicUsize,
}

impl ProcInfo for WalkInfo {
    fn has_children(&self, _: i32) -> bool {
        false
    }
    fn children_of(&self, _: &[i32]) -> HashMap<i32, bool> {
        HashMap::new()
    }
    fn cwd(&self, _: i32) -> Option<String> {
        None
    }
    fn cwds(&self, _: &[i32]) -> HashMap<i32, String> {
        HashMap::new()
    }
    fn names(&self, _: &[i32]) -> HashMap<i32, String> {
        HashMap::new()
    }
    fn listener_pids(&self, _: &str) -> Vec<i32> {
        Vec::new()
    }
    fn parent_pid(&self, pid: i32) -> Option<i32> {
        use std::sync::atomic::Ordering;
        self.parent_pid_calls.fetch_add(1, Ordering::Relaxed);
        self.parents().and_then(|m| m.get(&pid).copied())
    }
    fn parents(&self) -> Option<HashMap<i32, i32>> {
        use std::sync::atomic::Ordering;
        self.parents_calls.fetch_add(1, Ordering::Relaxed);
        Some([(100, 1), (200, 100), (300, 200)].into())
    }
    fn connection_owner_pid(&self, _: &str) -> Option<i32> {
        Some(300)
    }
}

#[test]
fn client_resolver_reads_parent_table_once() {
    use std::sync::atomic::Ordering;
    let c = Client {
        hub: Some(Arc::new(FakeHub {
            list: vec![info("7", 100)],
        })),
    };
    let w = WalkInfo::default();
    assert_eq!(
        c.resolve_with(&w, "127.0.0.1:1").unwrap(),
        ("7".to_owned(), 100)
    );
    assert_eq!(w.parent_pid_calls.load(Ordering::Relaxed), 0);
    assert_eq!(w.parents_calls.load(Ordering::Relaxed), 1);
    let none = Client {
        hub: Some(Arc::new(FakeHub {
            list: vec![info("7", 999)],
        })),
    };
    assert_eq!(
        none.resolve_with(&w, "127.0.0.1:1")
            .unwrap_err()
            .to_string(),
        "clientPID=300 가 어느 도구에도 속하지 않음"
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
