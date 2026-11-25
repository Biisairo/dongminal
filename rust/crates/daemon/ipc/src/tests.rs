//! 실제 소켓으로 paned·보고 소켓의 관측 동작을 잰다. 와이어 골든은 Go 시험(wire_typed_test.go 등)의 값이다.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_platform::IpcStream;
use otter_shared_toolhub::ToolManager;
use otter_shared_toolipc as ipc;
use otter_webserver_toolclient::ToolClient;
use tempfile::TempDir;

use crate::PanedServer;

struct Daemon {
    srv: PanedServer,
    sock: PathBuf,
    report: PathBuf,
    pid: PathBuf,
    _dir: TempDir,
}

/// 데몬 하나를 임시 폴더에 띄운다. paned 연결은 하나씩 이어 받는다.
fn daemon(build: &str) -> Daemon {
    let dir = tempfile::Builder::new().prefix("ip").tempdir().unwrap();
    let sock = dir.path().join("s");
    let report = dir.path().join("r");
    let pid = dir.path().join("pid");
    let data = dir.path().join("d");
    std::fs::create_dir_all(&data).unwrap();
    let pm = Arc::new(ToolManager::new(data.to_str().unwrap(), None));
    let srv = PanedServer::new(pm, &sock, Some(&pid));
    srv.set_build_version(build);
    srv.listen().unwrap();
    srv.listen_reports(&report).unwrap();
    let s = srv.clone();
    // Go 처럼 accept 는 연결이 끝난 사정(EOF 포함)을 돌려준다. 서버가 닫힐 때까지 다시 받는다.
    std::thread::spawn(move || {
        while !s.inner.closed.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = s.accept();
        }
    });
    let s = srv.clone();
    std::thread::spawn(move || s.serve_reports());
    Daemon {
        srv,
        sock,
        report,
        pid,
        _dir: dir,
    }
}

struct Rd(Arc<IpcStream>);

impl Read for Rd {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        (&*self.0).read(b)
    }
}

/// 줄 단위 원시 클라이언트다.
struct Raw {
    c: Arc<IpcStream>,
    r: BufReader<Rd>,
}

fn raw(path: &Path) -> Raw {
    let c = otter_shared_platform::current()
        .ipc
        .dial(path, Duration::from_secs(2))
        .unwrap();
    c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let c = Arc::new(c);
    Raw {
        r: BufReader::new(Rd(Arc::clone(&c))),
        c,
    }
}

impl Raw {
    fn send(&mut self, line: &str) {
        (&*self.c)
            .write_all(format!("{line}\n").as_bytes())
            .unwrap();
    }

    fn recv(&mut self) -> String {
        let mut s = String::new();
        assert!(self.r.read_line(&mut s).unwrap() > 0, "연결이 닫혔다");
        s.trim_end_matches('\n').to_owned()
    }

    fn call(&mut self, line: &str) -> String {
        self.send(line);
        self.recv()
    }

    /// id 의 응답이 올 때까지 읽는다. 사이의 push 는 버린다.
    fn recv_id(&mut self, id: i64) -> String {
        let p = format!("{{\"id\":{id},");
        loop {
            let l = self.recv();
            if l.starts_with(&p) {
                return l;
            }
        }
    }

    /// hello 로 서버가 말하는 기능을 알린다. 응답이 오면 연결이 데몬에 실린 것이다.
    fn hello(&mut self, features: &[&str]) {
        let f = features
            .iter()
            .map(|f| format!("\"{f}\""))
            .collect::<Vec<_>>()
            .join(",");
        let got = self.call(&format!(
            r#"{{"id":99,"method":"hello","params":{{"features":[{f}]}}}}"#
        ));
        assert!(got.starts_with(r#"{"id":99,"result""#), "{got}");
    }
}

/// 지금 데몬에 실린 서버 연결이다.
fn curr(d: &Daemon) -> Arc<crate::conn::Conn> {
    crate::conn::lock(&d.srv.inner.curr)
        .clone()
        .expect("연결이 실리지 않았다")
}

#[tokio::test(flavor = "multi_thread")]
async fn hello_wire_golden() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    assert_eq!(
        c.call(r#"{"id":1,"method":"hello","params":{"server_pid":0}}"#),
        r#"{"id":1,"result":{"build":"b","features":["fgtick","snapnotfound","notify","busymany","records","attention","edge","chat","shellprobe","screen"],"version":1}}"#
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn hello_without_build_stamp() {
    let d = daemon("");
    let mut c = raw(&d.sock);
    let got = c.call(r#"{"id":1,"method":"hello","params":{}}"#);
    assert!(got.contains(r#""build":"""#), "{got}");
}

/// 응답 바이트는 Go 와 같다 (FR-OPT-0-3).
#[tokio::test(flavor = "multi_thread")]
async fn response_wire_golden() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    let cases = [
        ("list", "{}", r#"{"id":1,"result":{"tools":null}}"#),
        (
            "backgroundlist",
            "{}",
            r#"{"id":1,"result":{"background":[]}}"#,
        ),
        ("cwd", r#"{"id":"x"}"#, r#"{"id":1,"result":{"cwd":""}}"#),
        (
            "busy",
            r#"{"id":"x"}"#,
            r#"{"id":1,"result":{"busy":false}}"#,
        ),
        (
            "setbackground",
            r#"{"id":"x","background":true}"#,
            r#"{"id":1,"result":{"ok":false}}"#,
        ),
        (
            "write",
            r#"{"id":"x","data":"!!"}"#,
            r#"{"id":1,"error":{"code":-32602,"message":"invalid base64"}}"#,
        ),
        (
            "paste",
            r#"{"id":"x","data":"!!"}"#,
            r#"{"id":1,"error":{"code":-32602,"message":"invalid base64"}}"#,
        ),
        (
            "bogus",
            "{}",
            r#"{"id":1,"error":{"code":-32601,"message":"unknown method: bogus"}}"#,
        ),
        (
            "snapshot",
            r#"{"id":"x"}"#,
            r#"{"id":1,"error":{"code":-32011,"message":"toolhub: tool not found"}}"#,
        ),
        (
            "screen",
            r#"{"id":"x","history":10}"#,
            r#"{"id":1,"error":{"code":-32011,"message":"toolhub: tool not found"}}"#,
        ),
        (
            "screentext",
            r#"{"id":"x","bytes":10}"#,
            r#"{"id":1,"error":{"code":-32011,"message":"toolhub: tool not found"}}"#,
        ),
        (
            "kill",
            r#"{"id":"x"}"#,
            r#"{"id":1,"error":{"code":-32000,"message":"toolhub: tool not found"}}"#,
        ),
        (
            "busymany",
            r#"{"ids":["a"]}"#,
            r#"{"id":1,"result":{"busy":{"a":false}}}"#,
        ),
        (
            "shellprobe",
            r#"{"id":"x","pids":[1]}"#,
            r#"{"id":1,"result":{"state":"unknown"}}"#,
        ),
        ("attendall", "{}", r#"{"id":1,"result":{"cleared":0}}"#),
        ("attend", r#"{"tool":"x"}"#, r#"{"id":1,"result":{}}"#),
    ];
    for (m, p, want) in cases {
        let got = c.call(&format!(r#"{{"id":1,"method":"{m}","params":{p}}}"#));
        assert_eq!(got, want, "{m}");
    }
}

/// 인자를 풀지 못하면 CODE_INVALID_PARAMS 이고 문구는 해석 오류 그대로다.
#[tokio::test(flavor = "multi_thread")]
async fn invalid_params_is_invalid_params() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    assert_eq!(
        c.call(r#"{"id":7,"method":"cwd","params":{"id":3}}"#),
        r#"{"id":7,"error":{"code":-32602,"message":"json: cannot unmarshal number into Go struct field IDParams.id of type string"}}"#
    );
}

/// 응답 없는 알림은 답하지 않는다 (FR-OPT-2-2). 다음 요청의 응답이 먼저 온다.
#[tokio::test(flavor = "multi_thread")]
async fn notify_has_no_reply() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    c.send(r#"{"method":"input","params":{"id":"x","data":"YQ=="}}"#);
    c.send(r#"{"method":"resizenotify","params":{"id":"x","cols":1,"rows":1}}"#);
    assert_eq!(
        c.call(r#"{"id":2,"method":"busy","params":{"id":"x"}}"#),
        r#"{"id":2,"result":{"busy":false}}"#
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn records_set_then_snapshot() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    assert_eq!(
        c.call(r#"{"id":1,"method":"recordset","params":{"kind":"limits","value":{"claude":1}}}"#),
        r#"{"id":1,"result":{}}"#
    );
    assert_eq!(
        c.call(r#"{"id":2,"method":"records","params":{}}"#),
        r#"{"id":2,"result":{"global":{"limits":{"claude":1}},"tools":[]}}"#
    );
    // 종류와 도구가 맞지 않거나 도구가 없으면 거절한다.
    assert_eq!(
        c.call(r#"{"id":3,"method":"recordset","params":{"kind":"limits","tool":"t","value":{}}}"#),
        r#"{"id":3,"error":{"code":-32602,"message":"기록의 종류와 도구가 맞지 않는다"}}"#
    );
    assert_eq!(
        c.call(
            r#"{"id":4,"method":"recordset","params":{"kind":"usage","tool":"gone","value":{}}}"#
        ),
        r#"{"id":4,"error":{"code":-32011,"message":"toolhub: tool not found"}}"#
    );
    // null 은 지운다.
    c.call(r#"{"id":5,"method":"recordset","params":{"kind":"limits","value":null}}"#);
    assert_eq!(
        c.call(r#"{"id":6,"method":"records","params":{}}"#),
        r#"{"id":6,"result":{"tools":[]}}"#
    );
    assert!(d.srv.export_global().is_empty());
}

/// 연결이 끊긴 뒤에도 다음 연결을 받는다. 새 연결이 지금 연결을 대신한다.
#[tokio::test(flavor = "multi_thread")]
async fn accepts_next_connection() {
    let d = daemon("b");
    let mut c1 = raw(&d.sock);
    c1.call(r#"{"id":1,"method":"hello","params":{}}"#);
    drop(c1);
    let mut c2 = raw(&d.sock);
    assert!(
        c2.call(r#"{"id":1,"method":"hello","params":{}}"#)
            .contains("\"version\":1")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn listen_writes_pid_and_rejects_live_socket() {
    let d = daemon("b");
    assert_eq!(
        std::fs::read_to_string(&d.pid).unwrap(),
        format!("{}\n", std::process::id())
    );
    let pm = Arc::new(ToolManager::new("", None));
    let other = PanedServer::new(pm, &d.sock, None);
    let err = other.listen().unwrap_err();
    assert_eq!(
        err.to_string(),
        format!(
            "paned: {} already served by a live daemon",
            d.sock.display()
        )
    );
    d.srv.close();
    assert!(!d.sock.exists() && !d.pid.exists() && !d.report.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn listen_removes_stale_socket() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("s");
    std::fs::write(&sock, b"").unwrap();
    let srv = PanedServer::new(Arc::new(ToolManager::new("", None)), &sock, None);
    srv.listen().unwrap();
    srv.close();
}

#[tokio::test(flavor = "multi_thread")]
async fn daemon_build_file_written_and_cleared() {
    let dir = tempfile::tempdir().unwrap();
    let fp = dir.path().join("paned.build");
    let srv = PanedServer::new(
        Arc::new(ToolManager::new("", None)),
        &dir.path().join("s"),
        None,
    );
    srv.set_daemon_build(&fp, "abc");
    srv.listen().unwrap();
    assert_eq!(std::fs::read_to_string(&fp).unwrap(), "abc\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&fp).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    srv.close();
    let srv = PanedServer::new(
        Arc::new(ToolManager::new("", None)),
        &dir.path().join("s"),
        None,
    );
    srv.set_daemon_build(&fp, "");
    srv.listen().unwrap();
    assert!(!fp.exists(), "빈 지문이면 파일을 지운다");
    srv.close();
}

fn report_call(path: &Path, req: &str) -> String {
    let mut c = raw(path);
    c.call(req)
}

/// 보고 소켓: 모르는 메서드·도구는 거절하고, hello 는 서버와 무관하게 답한다.
#[tokio::test(flavor = "multi_thread")]
async fn report_socket_replies() {
    let d = daemon("b");
    assert_eq!(
        report_call(&d.report, r#"{"method":"report.bogus","body":{}}"#),
        r#"{"ok":false,"error":"보고 소켓이 받지 않는 메서드다: report.bogus"}"#
    );
    assert_eq!(
        report_call(
            &d.report,
            r#"{"method":"report.notify","body":{"toolId":"t1"}}"#
        ),
        r#"{"ok":false,"error":"toolhub: tool not found"}"#
    );
    assert_eq!(
        report_call(&d.report, r#"{"method":"report.notify","body":{}}"#),
        r#"{"ok":false,"error":"toolId 가 비었다"}"#
    );
    assert_eq!(
        report_call(&d.report, r#"{"method":"daemon.hello","body":null}"#),
        r#"{"ok":true}"#
    );
}

/// 교체 제어: 교체기가 없으면 unsupported, 있으면 응답을 쓴 뒤 commit 한다. 너무 큰 요청은 거절한다.
#[tokio::test(flavor = "multi_thread")]
async fn control_reload() {
    let d = daemon("b");
    assert_eq!(
        report_call(
            &d.report,
            r#"{"method":"daemon.reload","body":{"exe":"/x","handover":1}}"#
        ),
        r#"{"ok":false,"error":"reload_unsupported: 이 데몬은 세션 유지 교체를 하지 않습니다"}"#
    );
    let (tx, rx) = std::sync::mpsc::channel();
    d.srv.set_reloader(Some(Arc::new(move |req| {
        if req.exe == "/bad" {
            return Err("reload_exe: 절대경로가 아닙니다".to_owned());
        }
        let tx = tx.clone();
        Ok(Box::new(move || {
            let _ = tx.send(());
        }))
    })));
    assert_eq!(
        report_call(
            &d.report,
            r#"{"method":"daemon.reload","body":{"exe":"/bad","handover":1}}"#
        ),
        r#"{"ok":false,"error":"reload_exe: 절대경로가 아닙니다"}"#
    );
    assert!(rx.try_recv().is_err());
    assert_eq!(
        report_call(
            &d.report,
            r#"{"method":"daemon.reload","body":{"exe":"/ok","handover":1}}"#
        ),
        r#"{"ok":true}"#
    );
    rx.recv_timeout(Duration::from_secs(2))
        .expect("commit 이 불리지 않았다");
    let big = format!(
        r#"{{"method":"daemon.reload","body":{{"exe":"{}"}}}}"#,
        "a".repeat(otter_shared_handover::MAX_REQUEST_BYTES)
    );
    assert_eq!(
        report_call(&d.report, &big),
        r#"{"ok":false,"error":"reload_exe: 요청이 너무 큽니다"}"#
    );
}

/// Rust 서버(toolclient)가 Rust 데몬에 붙는다 (FR-RSP-21 의 데몬 쪽). 기능 협상·목록·기록·report push.
#[tokio::test(flavor = "multi_thread")]
async fn rust_toolclient_interop() {
    let d = daemon("rb");
    let sock = d.sock.clone();
    let pc = tokio::task::spawn_blocking(move || ToolClient::dial(&sock).unwrap())
        .await
        .unwrap();
    assert_eq!(pc.daemon_info().build, "rb");
    assert!(pc.has_feature(ipc::FEATURE_RECORDS) && pc.has_feature(ipc::FEATURE_NOTIFY));
    let (tx, rx) = std::sync::mpsc::channel();
    pc.set_on_report(Some(Arc::new(move |ev: ipc::ReportEvent| {
        let _ = tx.send(ev);
    })));
    let pc = Arc::new(pc);
    let p = Arc::clone(&pc);
    let report = d.report.clone();
    tokio::task::spawn_blocking(move || {
        assert_eq!(p.list_ok(), Some(Vec::new()));
        assert!(p.background_list().is_empty());
        p.record_set("limits", "", RawMessage(b"{\"a\":1}".to_vec()))
            .unwrap();
        let recs = p.records().unwrap();
        assert_eq!(recs.global["limits"].0, b"{\"a\":1}");
        let err = p.snapshot_tool("gone").unwrap_err();
        assert_eq!(err.to_string(), "toolhub: tool not found: gone");
        // 보고 소켓의 보고가 서버에 push 로 온다 — 도구가 없으면 거절되어 push 도 없다.
        assert_eq!(
            report_call(
                &report,
                r#"{"method":"report.notify","body":{"toolId":"t"}}"#
            ),
            r#"{"ok":false,"error":"toolhub: tool not found"}"#
        );
        p.input_notify("x", b"a");
        assert!(!p.busy("x"));
    })
    .await
    .unwrap();
    assert!(rx.try_recv().is_err());
    let raw: ipc::RecordsResult = json::unmarshal(br#"{"tools":[]}"#).unwrap();
    assert!(raw.global.is_empty());
    pc.close();
}

mod fake;
mod features;
mod push;
mod queue;
mod reports;
mod wire;

/// Go toolclient(웹 서버 쪽)가 Rust 데몬에 붙는다. Go 툴체인이 필요하므로 따로 켠다:
/// `OTTER_GO_REF_SRC=<main 의 worktree> rust/scripts/go-ref.sh <bin> rust/crates/daemon/ipc/testdata/gotoolclient` 뒤
/// `OTTER_GO_TOOLCLIENT=<bin> rust/scripts/hermetic.sh cargo test -p otter-daemon-ipc -- --ignored`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "OTTER_GO_TOOLCLIENT 에 Go 시험 프로그램이 있어야 한다"]
async fn go_toolclient_interop() {
    let bin = std::env::var("OTTER_GO_TOOLCLIENT").expect("OTTER_GO_TOOLCLIENT");
    let d = daemon("gb");
    let cwd = d.pid.parent().unwrap().to_path_buf();
    let sock = d.sock.clone();
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new(bin)
            .arg(&sock)
            .arg(&cwd)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success() && stdout.trim_end() == "OK",
        "{stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

// 10.5b: 소켓 폴더를 만들 수 없으면 Go os.MkdirAll 처럼 막힌 칸의 경로로 낸다.
#[tokio::test(flavor = "multi_thread")]
async fn listen_mkdir_error_matches_go() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("f");
    std::fs::write(&blocker, b"x").unwrap();
    let want = format!("mkdir {}: not a directory", blocker.display());
    let srv = PanedServer::new(
        Arc::new(ToolManager::new("", None)),
        &blocker.join("a").join("s"),
        None,
    );
    assert_eq!(srv.listen().unwrap_err().to_string(), want);
    let e = srv
        .listen_reports(&blocker.join("a").join("r"))
        .unwrap_err();
    assert_eq!(e.to_string(), want);
}
