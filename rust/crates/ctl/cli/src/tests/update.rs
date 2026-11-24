//! update_test.go — `dongminal update --check` 는 사람이 직접 묻는 자리다 (FR-UPD-17).

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::args;
use crate::update::{UpdateOpts, parse_update, run_update_with};

/// 어느 요청에나 tag 를 최신으로 답하고, 받은 요청 수를 센다.
fn release_server(tag: &str) -> (String, Arc<AtomicUsize>) {
    let ln = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/latest", ln.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&hits);
    let body = format!(r#"{{"tag_name":"{tag}","html_url":"https://example/rel/{tag}"}}"#);
    std::thread::spawn(move || {
        for conn in ln.incoming() {
            let Ok(mut conn) = conn else { return };
            seen.fetch_add(1, Ordering::SeqCst);
            let mut r = BufReader::new(conn.try_clone().unwrap());
            let mut line = String::new();
            while r.read_line(&mut line).is_ok_and(|n| n > 0) && line != "\r\n" {
                line.clear();
            }
            let _ = write!(
                conn,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    (url, hits)
}

fn run(o: &UpdateOpts, cur: &str) -> (i32, String, String) {
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = run_update_with(o, cur, &mut out, &mut err);
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

fn check(endpoint: String) -> UpdateOpts {
    let mut o = parse_update(&args(&["--check"])).unwrap();
    o.endpoint = endpoint;
    o
}

#[test]
fn check_reports_newer() {
    let (url, _) = release_server("v9.9.9");
    let (code, out, err) = run(&check(url), "v1.0.0");
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        out,
        "지금 판: v1.0.0\n최신 판: v9.9.9\n\n새 판이 있습니다.\n  https://example/rel/v9.9.9\n  내려받은 뒤 dongminal stop --all 하고 바꿔 넣으세요.\n  바꾸기 전에: dongminal backup --out <파일.zip>\n"
    );
}

#[test]
fn check_says_up_to_date() {
    let (url, _) = release_server("v1.0.0");
    let (code, out, err) = run(&check(url), "v1.0.0");
    assert_eq!(code, 0, "{err}");
    assert!(out.ends_with("\n최신입니다.\n"), "{out}");
}

// 개발 빌드는 견줄 기준이 없다 — "뒤졌다" 로 말하면 거짓이다.
#[test]
fn check_dev_build() {
    let (url, _) = release_server("v1.0.0");
    let (code, out, _) = run(&check(url), "dev");
    assert_eq!(code, 0);
    assert_eq!(
        out,
        "지금 판: dev\n최신 판: v1.0.0\n\n개발 빌드입니다 — 릴리스 판과 견줄 기준이 없습니다.\n최신 릴리스: https://example/rel/v1.0.0\n"
    );
}

// `--check` 없이는 밖으로 나가지 않는다.
#[test]
fn without_check_does_not_fetch() {
    let (url, hits) = release_server("v9.9.9");
    let mut o = parse_update(&[]).unwrap();
    o.endpoint = url;
    let (code, out, _) = run(&o, "v1.0.0");
    assert_eq!(code, 0);
    assert_eq!(hits.load(Ordering::SeqCst), 0, "--check 없이 나갔다");
    assert!(out.contains("--check"), "{out}");
}

// 그물이 끊기면 실패로 끝나되 조용하다.
#[test]
fn check_network_failure() {
    let port = super::fake_http::dead_port();
    let (code, out, err) = run(&check(format!("http://127.0.0.1:{port}/nope")), "v1.0.0");
    assert_eq!(code, 1);
    assert!(out.is_empty());
    assert!(
        err.starts_with("최신 판을 확인하지 못했습니다: Get \"http://127.0.0.1:"),
        "{err}"
    );
}
