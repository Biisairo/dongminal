//! 검사용 HTTP 서버. 요청마다 연결 하나를 받고 닫는다.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

pub(crate) struct FakeServer {
    /// `127.0.0.1:<port>`
    pub addr: String,
    pub port: String,
    bodies: Arc<Mutex<Vec<String>>>,
}

impl FakeServer {
    /// `POST /api/server/bind` 에는 status·reply 를, `/api/ping` 에는 200 을, 나머지에는 404 를 준다.
    pub(crate) fn start(status: u16, reply: &'static str) -> Self {
        Self::spawn(status, reply, None)
    }

    /// `/api/health` 에 body 를 준다.
    pub(crate) fn start_health(body: &'static str) -> Self {
        Self::spawn(200, "", Some(body))
    }

    pub(crate) fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    fn spawn(status: u16, reply: &'static str, health: Option<&'static str>) -> Self {
        let ln = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = ln.local_addr().unwrap();
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&bodies);
        std::thread::spawn(move || {
            for conn in ln.incoming() {
                let Ok(conn) = conn else { return };
                serve_one(conn, status, reply, health, &seen);
            }
        });
        Self {
            addr: addr.to_string(),
            port: addr.port().to_string(),
            bodies,
        }
    }

    pub(crate) fn bodies(&self) -> Vec<String> {
        self.bodies.lock().unwrap().clone()
    }
}

fn serve_one(
    conn: TcpStream,
    status: u16,
    reply: &str,
    health: Option<&str>,
    seen: &Mutex<Vec<String>>,
) {
    let mut r = BufReader::new(conn.try_clone().unwrap());
    let mut line = String::new();
    if r.read_line(&mut line).is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let path = parts.next().unwrap_or("").to_owned();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':')
            && k.eq_ignore_ascii_case("content-length")
        {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0; len];
    let _ = r.read_exact(&mut body);
    let (code, text) = match (method.as_str(), path.as_str()) {
        ("POST", "/api/server/bind") => {
            seen.lock()
                .unwrap()
                .push(String::from_utf8_lossy(&body).into_owned());
            (status, reply)
        }
        (_, "/api/health") if health.is_some() => (200, health.unwrap_or_default()),
        (_, "/api/ping" | "/") => (200, ""),
        _ => (404, ""),
    };
    let mut w = conn;
    let _ = write!(
        w,
        "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
}

/// 아무도 듣지 않는 포트 — 열었다 닫아 확실히 비운다.
pub(crate) fn dead_port() -> String {
    let ln = TcpListener::bind("127.0.0.1:0").unwrap();
    ln.local_addr().unwrap().port().to_string()
}
