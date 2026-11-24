//! 가짜 데몬으로 Go 기준선의 관측 동작을 잰다. 실제 데몬(3.x)이 필요한 Go 시험은 가짜 데몬으로 옮겼다.

mod basic;
mod reconnect;
mod timing;
mod wire;

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use otter_gocompat::json;
use otter_shared_platform::{IpcListener, IpcStream};
use otter_shared_toolipc::{METHOD_HELLO, PROTOCOL_VERSION, PanedRequest};
use serde_json::{Value, json};
use tempfile::TempDir;

use crate::ToolClient;

/// 소켓 하나를 연 임시 폴더다. Drop 하면 소켓과 폴더가 사라진다.
pub(super) struct Sock {
    pub path: PathBuf,
    _dir: TempDir,
}

pub(super) fn listen() -> (Sock, IpcListener) {
    let dir = tempfile::Builder::new().prefix("tc").tempdir().unwrap();
    let path = dir.path().join("s");
    let ln = otter_shared_platform::current().ipc.listen(&path).unwrap();
    (Sock { path, _dir: dir }, ln)
}

/// 쓰기를 한 줄씩 지키는 서버 쪽 연결이다.
#[derive(Clone)]
pub(super) struct Peer {
    conn: Arc<IpcStream>,
    wmu: Arc<Mutex<()>>,
}

impl Peer {
    pub fn new(conn: IpcStream) -> Self {
        Self {
            conn: Arc::new(conn),
            wmu: Arc::new(Mutex::new(())),
        }
    }

    /// Go `json.Encoder.Encode` — 값 하나와 개행.
    pub fn send(&self, v: &Value) {
        let mut b = json::marshal(v).unwrap();
        b.push(b'\n');
        self.raw(&b);
    }

    pub fn raw(&self, b: &[u8]) {
        let _g = self.wmu.lock().unwrap();
        let _ = (&*self.conn).write_all(b);
    }

    pub fn close(&self) {
        let _ = self.conn.shutdown(std::net::Shutdown::Both);
    }

    /// 요청 줄을 하나씩 돌린다. 해석하지 못하거나 연결이 끝나면 멈춘다.
    pub fn each_request(&self, mut f: impl FnMut(&str, PanedRequest)) {
        let mut r = BufReader::new(&*self.conn);
        let mut line = String::new();
        loop {
            line.clear();
            match r.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let l = line.trim_end_matches('\n');
            let Ok(req) = json::unmarshal::<PanedRequest>(l.as_bytes()) else {
                return;
            };
            f(l, req);
        }
    }
}

pub(super) fn resp(id: i64, result: Value) -> Value {
    json!({"id": id, "result": result})
}

pub(super) fn err_resp(id: i64, code: i64, message: &str) -> Value {
    json!({"id": id, "error": {"code": code, "message": message}})
}

pub(super) fn version() -> Value {
    json!({"version": PROTOCOL_VERSION})
}

/// 연결 하나를 받아 요청마다 handler 의 답을 보낸다. `None` 은 답하지 않는다(알림을 받는 데몬).
/// 받은 요청 줄을 바이트 그대로 돌려준다.
pub(super) fn fake(
    handler: impl Fn(&PanedRequest) -> Option<Value> + Send + 'static,
) -> (Sock, Receiver<String>) {
    let (sock, ln) = listen();
    let (tx, rx) = mpsc::sync_channel(64);
    thread::spawn(move || {
        let Ok(conn) = ln.accept() else { return };
        let peer = Peer::new(conn);
        peer.each_request(|line, req| {
            let _ = tx.try_send(line.to_owned());
            if let Some(v) = handler(&req) {
                peer.send(&v);
            }
        });
        drop(ln);
    });
    (sock, rx)
}

/// hello 에는 hello 를, 나머지에는 reply 를 답한다 (Go `rawFake`).
pub(super) fn raw_fake(
    hello: Value,
    reply: impl Fn(&PanedRequest) -> Option<Value> + Send + 'static,
) -> (Sock, Receiver<String>) {
    fake(move |req| {
        if req.method == METHOD_HELLO {
            return Some(resp(req.id, hello.clone()));
        }
        reply(req)
    })
}

/// 모든 요청에 빈 결과로 답한다.
pub(super) fn ok_fake(hello: Value) -> (Sock, Receiver<String>) {
    raw_fake(hello, |req| Some(resp(req.id, json!({}))))
}

pub(super) fn dial(sock: &Sock) -> ToolClient {
    ToolClient::dial(&sock.path).unwrap()
}

pub(super) fn next_line(rx: &Receiver<String>) -> String {
    rx.recv_timeout(Duration::from_secs(2))
        .expect("요청이 오지 않았다")
}

pub(super) fn no_line(rx: &Receiver<String>) {
    if let Ok(l) = rx.recv_timeout(Duration::from_millis(100)) {
        panic!("더 나가면 안 되는 요청이 나갔다: {l}");
    }
}

/// cond 가 참이 될 때까지 기다린다.
pub(super) fn wait_until(what: &str, limit: Duration, cond: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + limit;
    while !cond() {
        assert!(std::time::Instant::now() < deadline, "{what}");
        thread::sleep(Duration::from_millis(5));
    }
}

/// 값 하나를 받는 채널 — 콜백에서 시험으로 넘긴다.
pub(super) fn chan<T>() -> (SyncSender<T>, Receiver<T>) {
    mpsc::sync_channel(4096)
}
