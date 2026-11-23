//! `start --foreground` 의 서버 프로세스 (Go `cmd/dongminal/app.go`). 임시 홈과 60147 이상 포트에서만 돈다.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_dongminal");
const PORT: u16 = 60411;

/// 이 시험이 띄운 PID 하나에 SIGTERM 을 보낸다.
fn term(pid: u32) {
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .status();
}

fn health_ok(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let req =
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.starts_with("HTTP/1.1 200") && out.contains(r#""connected":true"#)
}

// Go buildApp 의 `os.Setenv(DONGMINAL_HOME)` 자리: 환경변수 없이 `--home` 으로 띄워도 serve 첫 줄에서
// 스레드가 하나뿐이라 홈을 환경에 넣는다(넣지 못하면 ERROR 줄이 남는다). 서버는 데몬에 붙어 서고,
// SIGTERM 에 정상 종료 마커를 남긴다.
#[cfg(unix)]
#[test]
fn foreground_serve_sets_home_env_before_threads() {
    let d = tempfile::Builder::new().prefix("dm").tempdir().unwrap();
    let home = d.path().join("h");
    let mut c = Command::new(BIN);
    c.args([
        "start",
        "--foreground",
        "--home",
        home.to_str().unwrap(),
        "--port",
        &PORT.to_string(),
    ]);
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy().starts_with("DONGMINAL_") {
            c.env_remove(k);
        }
    }
    c.env("DONGMINAL_NO_UPDATE_CHECK", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = c.spawn().unwrap();

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut up = false;
    while Instant::now() < deadline {
        if health_ok(PORT) {
            up = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    term(child.id());
    let out = child.wait_with_output().unwrap();
    if let Ok(pid) = std::fs::read_to_string(home.join("paned.pid"))
        && let Ok(pid) = pid.trim().parse::<u32>()
    {
        term(pid);
    }
    let log =
        String::from_utf8_lossy(&out.stderr).into_owned() + &String::from_utf8_lossy(&out.stdout);
    assert!(up, "서버가 서지 않았다:\n{log}");
    assert_eq!(out.status.code(), Some(0), "{log}");
    assert!(
        !log.contains("DONGMINAL_HOME: "),
        "홈을 환경에 넣지 못했다:\n{log}"
    );
    assert!(log.contains("msg=\"server stopped\""), "{log}");
    assert_eq!(
        std::fs::read_to_string(Path::new(&home).join(".lastexit")).unwrap(),
        "clean"
    );
}

fn get_body(port: u16, path: &str) -> Option<String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.starts_with("HTTP/1.1 200")
        .then(|| out.split_once("\r\n\r\n").map(|(_, b)| b.to_owned()))
        .flatten()
}

// DIFF(8.2-fix): `DONGMINAL_NO_UPDATE_CHECK=1` 이 판 확인을 끈다(UPDATE_NOTICE_SRS 킬스위치). Go 기준선은
// Getenv 를 넘기지 않아 이 변수가 먹지 않았다. 설정의 updateCheck 는 기본값(켜짐) 그대로 둔다.
#[cfg(unix)]
#[test]
fn no_update_check_env_disables_update_check() {
    const PORT2: u16 = 60412;
    let d = tempfile::Builder::new().prefix("dm").tempdir().unwrap();
    let home = d.path().join("h");
    let mut c = Command::new(BIN);
    c.args([
        "start",
        "--foreground",
        "--home",
        home.to_str().unwrap(),
        "--port",
        &PORT2.to_string(),
    ]);
    for (k, _) in std::env::vars_os() {
        if k.to_string_lossy().starts_with("DONGMINAL_") {
            c.env_remove(k);
        }
    }
    c.env("DONGMINAL_NO_UPDATE_CHECK", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = c.spawn().unwrap();

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut body = None;
    while Instant::now() < deadline {
        if health_ok(PORT2) {
            body = get_body(PORT2, "/api/update");
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    term(child.id());
    let _ = child.wait();
    if let Ok(pid) = std::fs::read_to_string(home.join("paned.pid"))
        && let Ok(pid) = pid.trim().parse::<u32>()
    {
        term(pid);
    }
    let body = body.expect("서버가 서지 않았다");
    assert!(body.contains(r#""enabled":false"#), "{body}");
}
