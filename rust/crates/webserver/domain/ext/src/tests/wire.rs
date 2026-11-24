//! 밖에서 보이는 모양: JSON 바이트, HTTP 받기, 실제 명령 실행.

use std::io::Read;
use std::net::TcpListener;

use super::*;
use crate::fetch::HttpFetch;
#[cfg(unix)]
use crate::install::HostExec;
use crate::install::Outcome;
use crate::locate::{Missing, Status};

fn json(v: &impl serde::Serialize) -> String {
    String::from_utf8(dm_gocompat::json::marshal(v).unwrap()).unwrap()
}

#[test]
fn status_json_matches_go() {
    let st = Status {
        pack: "gopls".into(),
        id: "gopls".into(),
        exts: vec![".go".into()],
        missing: Some(Missing {
            kind: "tool".into(),
            name: "go".into(),
        }),
        note: "x".into(),
        ..Status::default()
    };
    assert_eq!(
        json(&st),
        r#"{"pack":"gopls","id":"gopls","exts":[".go"],"found":false,"isolated":false,"missing":{"kind":"tool","name":"go"},"note":"x","canInstall":false}"#
    );
    let st = Status {
        found: true,
        exe: "/a".into(),
        origin: "path".into(),
        can_install: true,
        installing: true,
        ..Status::default()
    };
    assert_eq!(
        json(&st),
        r#"{"pack":"","id":"","found":true,"exe":"/a","origin":"path","isolated":false,"canInstall":true,"installing":true}"#
    );
}

#[test]
fn outcome_json_matches_go() {
    assert_eq!(json(&Outcome::default()), r#"{"ok":false}"#);
    let o = Outcome {
        ok: true,
        reason: "r".into(),
        detail: "d".into(),
        exe: "e".into(),
    };
    assert_eq!(
        json(&o),
        r#"{"ok":true,"reason":"r","detail":"d","exe":"e"}"#
    );
}

/// 60147 이상에서 빈 포트 하나 (C-RSP-1).
fn listen() -> (TcpListener, u16) {
    for port in 60147..61147 {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)) {
            return (l, port);
        }
    }
    panic!("빈 포트가 없다");
}

/// 요청 하나에 정해진 응답을 내는 가짜 서버. 받은 요청 머리를 돌려준다.
fn serve_once(resp: &'static [u8]) -> (u16, std::thread::JoinHandle<String>) {
    let (l, port) = listen();
    let h = std::thread::spawn(move || {
        let (mut c, _) = l.accept().unwrap();
        let mut buf = [0u8; 4096];
        let n = c.read(&mut buf).unwrap();
        c.write_all(resp).unwrap();
        String::from_utf8_lossy(&buf[..n]).into_owned()
    });
    (port, h)
}

#[tokio::test]
async fn http_fetch_ok_and_user_agent() {
    let (port, h) =
        serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello");
    let mut out = Vec::new();
    HttpFetch
        .fetch(
            &Ctx::background(),
            &format!("http://127.0.0.1:{port}/a"),
            &mut out,
        )
        .await
        .unwrap();
    assert_eq!(out, b"hello");
    let req = h.join().unwrap();
    assert!(req.starts_with("GET /a HTTP/1.1\r\n"), "{req}");
    assert!(
        req.to_ascii_lowercase()
            .contains("user-agent: go-http-client/1.1"),
        "{req}"
    );
}

#[tokio::test]
async fn http_fetch_status_text() {
    let (port, h) =
        serve_once(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    let url = format!("http://127.0.0.1:{port}/a");
    let e = HttpFetch
        .fetch(&Ctx::background(), &url, &mut Vec::new())
        .await
        .unwrap_err();
    assert_eq!(e.to_string(), format!("{url}: 404 Not Found"));
    h.join().unwrap();
}

#[tokio::test]
async fn http_fetch_cancelled() {
    let (l, port) = listen();
    let ctx = Ctx::background();
    ctx.cancel();
    let url = format!("http://127.0.0.1:{port}/a");
    let e = HttpFetch
        .fetch(&ctx, &url, &mut Vec::new())
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        format!(
            "Get {}: context canceled",
            dm_gocompat::strconv::quote(&url)
        )
    );
    drop(l);
}

#[cfg(unix)]
mod host_exec {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| (*s).to_owned()).collect()
    }

    #[tokio::test]
    async fn combined_output_and_env() {
        let (_d, dir) = tmp();
        let r = HostExec
            .exec(
                &Ctx::background(),
                "sh",
                &args(&["-c", "echo out; echo err 1>&2; echo $DM_X"]),
                &["DM_X=v".to_owned()],
                &dir,
            )
            .await;
        assert_eq!(r.err, None);
        assert_eq!(String::from_utf8(r.out).unwrap(), "out\nerr\nv\n");
    }

    #[tokio::test]
    async fn exit_status_text() {
        let (_d, dir) = tmp();
        let r = HostExec
            .exec(
                &Ctx::background(),
                "sh",
                &args(&["-c", "exit 3"]),
                &[],
                &dir,
            )
            .await;
        assert_eq!(r.err.as_deref(), Some("exit status 3"));
    }

    #[tokio::test]
    async fn not_found_text() {
        let (_d, dir) = tmp();
        let r = HostExec
            .exec(&Ctx::background(), "dm-no-such-tool-xyz", &[], &[], &dir)
            .await;
        assert_eq!(
            r.err.as_deref(),
            Some(r#"exec: "dm-no-such-tool-xyz": executable file not found in $PATH"#)
        );
    }

    #[tokio::test]
    async fn deadline_kills_with_ctx_error() {
        let (_d, dir) = tmp();
        let ctx = Ctx::background().with_timeout(std::time::Duration::from_millis(100));
        let t = std::time::Instant::now();
        let r = HostExec
            .exec(&ctx, "sh", &args(&["-c", "sleep 30"]), &[], &dir)
            .await;
        assert_eq!(r.err.as_deref(), Some("context deadline exceeded"));
        assert!(
            t.elapsed() < std::time::Duration::from_secs(10),
            "죽이지 않았다"
        );
    }
}
