//! 시험. Go `internal/helper/runtimebin` 의 관측 동작 시험과 골든을 옮긴 것이다.
//!
//! 시험 서버와 닫힌 포트는 60147 이상에서만 고른다 (C-RSP-1). 홈은 언제나 임시 폴더다.

mod behavior;
mod golden;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::Value;

use crate::ctx::{Ctx, Env};

/// 시험 서버가 받은 요청 하나.
#[derive(Clone, Debug, Default)]
pub(crate) struct Req {
    pub method: String,
    /// 경로와 질의(`/api/x?a=b`).
    pub target: String,
    pub content_type: String,
    pub body: Vec<u8>,
}

impl Req {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }
    pub fn query(&self, key: &str) -> Option<String> {
        let q = self.target.split_once('?')?.1;
        q.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (k == key).then(|| unescape(v))
        })
    }
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap_or(b'?'));
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) type Handler = Arc<dyn Fn(&Req) -> (u16, Vec<u8>) + Send + Sync>;

/// 60147 이상에서 빈 포트를 하나 묶는다.
fn bind_high() -> TcpListener {
    static NEXT: AtomicU16 = AtomicU16::new(0);
    let base = 60147 + (std::process::id() % 2000) as u16 * 2;
    loop {
        let off = NEXT.fetch_add(1, Ordering::SeqCst);
        let port = base.wrapping_add(off);
        if port < 60147 {
            continue;
        }
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)) {
            return l;
        }
    }
}

/// 아무도 듣지 않는 60147 이상의 포트.
pub(crate) fn closed_port() -> u16 {
    let l = bind_high();
    l.local_addr().unwrap().port()
}

/// 요청마다 handler 의 답을 돌려주는 HTTP/1.1 시험 서버.
pub(crate) struct TestServer {
    pub port: u16,
    pub reqs: Arc<Mutex<Vec<Req>>>,
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl TestServer {
    pub fn new(handler: impl Fn(&Req) -> (u16, Vec<u8>) + Send + Sync + 'static) -> Self {
        let l = bind_high();
        let port = l.local_addr().unwrap().port();
        let reqs = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let handler: Handler = Arc::new(handler);
        let (r2, s2) = (reqs.clone(), stop.clone());
        let join = thread::spawn(move || {
            for conn in l.incoming() {
                if s2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(conn) = conn else { continue };
                let (h, r) = (handler.clone(), r2.clone());
                thread::spawn(move || serve(conn, &h, &r));
            }
        });
        Self {
            port,
            reqs,
            stop,
            join: Some(join),
        }
    }

    /// 고정된 답을 내는 서버.
    pub fn fixed(status: u16, body: &str) -> Self {
        let body = body.as_bytes().to_vec();
        Self::new(move |_| (status, body.clone()))
    }

    pub fn requests(&self) -> Vec<Req> {
        self.reqs.lock().unwrap().clone()
    }

    /// 이 서버를 가리키는 시험 환경. 도구 id 는 `self-tool` 이다.
    pub fn env(&self, home: &Path) -> Env {
        env_at(home, self.port)
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

fn serve(conn: TcpStream, h: &Handler, reqs: &Mutex<Vec<Req>>) {
    let mut rd = BufReader::new(conn.try_clone().unwrap());
    {
        let mut line = String::new();
        if rd.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let mut req = Req {
            method: parts.next().unwrap_or_default().to_owned(),
            target: parts.next().unwrap_or_default().to_owned(),
            ..Default::default()
        };
        let mut len = 0usize;
        loop {
            let mut h = String::new();
            if rd.read_line(&mut h).unwrap_or(0) == 0 {
                return;
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                match k.trim().to_ascii_lowercase().as_str() {
                    "content-length" => len = v.trim().parse().unwrap_or(0),
                    "content-type" => req.content_type = v.trim().to_owned(),
                    _ => {}
                }
            }
        }
        req.body = vec![0; len];
        if rd.read_exact(&mut req.body).is_err() {
            return;
        }
        reqs.lock().unwrap().push(req.clone());
        let (status, body) = h(&req);
        let mut w = conn.try_clone().unwrap();
        let mut head = format!("HTTP/1.1 {status} X\r\nConnection: close\r\n");
        if status != 204 && status != 304 {
            head += &format!("Content-Length: {}\r\n", body.len());
        }
        head += "\r\n";
        let _ = w.write_all(head.as_bytes());
        let _ = w.write_all(&body);
        let _ = w.flush();
    }
}

/// home 을 대체 홈으로 삼고 그 주소 파일을 port 로 쓴 시험 환경이다 (Go `pointAt`).
pub(crate) fn env_at(home: &Path, port: u16) -> Env {
    dm_shared_serverconf::write_addr(home, &format!("127.0.0.1:{port}")).unwrap();
    let mut env = Env::with_vars([(dm_shared_dmenv::ENV_TOOL_ID, "self-tool")]);
    env.fallback_home = Some(home.to_path_buf());
    env.open_local = Some(|out, u| {
        let _ = writeln!(out, "OPEN {u}");
        Ok(())
    });
    env
}

/// 헬퍼 하나를 돌린 결과 (종료 코드, stdout, stderr).
pub(crate) fn run_with(
    env: &Env,
    f: crate::RunFn,
    args: &[&str],
    stdin: &[u8],
) -> (i32, String, String) {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let mut inp = stdin;
    let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
    let code = {
        let mut ctx = Ctx::new(&mut out, &mut err, &mut inp, env);
        f(&mut ctx, &args)
    };
    (
        code,
        String::from_utf8_lossy(&out).into_owned(),
        String::from_utf8_lossy(&err).into_owned(),
    )
}

pub(crate) fn dm(env: &Env, args: &[&str]) -> (i32, String, String) {
    run_with(env, crate::dmctl::run_dmctl, args, b"")
}

/// Go `%q` 로 찍은 문자열 목록 (`["a" "b"]`).
pub(crate) fn q_list(args: &[&str]) -> String {
    let parts: Vec<String> = args
        .iter()
        .map(|a| dm_gocompat::strconv::quote(a))
        .collect();
    format!("[{}]", parts.join(" "))
}

pub(crate) fn q(s: &str) -> String {
    dm_gocompat::strconv::quote(s)
}

/// 골든을 블록(머리 줄 + 들여쓴 줄들)으로 나눈다.
pub(crate) fn blocks(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.split_inclusive('\n') {
        if let Some(last) = out.last_mut().filter(|_| line.starts_with("  ")) {
            last.push_str(line);
        } else {
            out.push(line.to_owned());
        }
    }
    out
}

pub(crate) fn read_testdata(name: &str) -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata")
            .join(name),
    )
    .unwrap()
}

/// 줄 단위로 처음 다른 곳을 보이며 비교한다.
pub(crate) fn assert_same(got: &str, want: &str, what: &str) {
    if got == want {
        return;
    }
    let (g, w): (Vec<&str>, Vec<&str>) = (got.split('\n').collect(), want.split('\n').collect());
    for i in 0..g.len().min(w.len()) {
        assert_eq!(g[i], w[i], "{what}: {}번째 줄이 다르다", i + 1);
    }
    panic!("{what}: 줄 수가 다르다 got={} want={}", g.len(), w.len());
}
