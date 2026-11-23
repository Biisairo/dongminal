//! 출처 게이트 (Go `reqgate_test.go`). `/api/tools/headless` 는 아직 없는 종단이라 게이트를
//! 지나면 404 다 — 시험은 게이트의 상태(403·415·421)만 본다.

use std::sync::Arc;

use super::support::*;
use crate::Deps;
use crate::access::AccessConfig;
use crate::req::Req;
use crate::reqgate::{HostAllow, request_gate};

const HEADLESS: &str = "/api/tools/headless";

fn ok_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Content-Type", "application/json"),
        ("Origin", TEST_ORIGIN),
        ("Sec-Fetch-Site", "same-origin"),
    ]
}

fn set(h: &mut Vec<(&'static str, &'static str)>, k: &'static str, v: &'static str) {
    h.retain(|(n, _)| *n != k);
    h.push((k, v));
}

async fn gate_req(
    srv: &Arc<crate::Server>,
    method: &str,
    path: &str,
    h: &[(&'static str, &'static str)],
) -> u16 {
    call(srv, method, path, h, "{}", LOCAL).await.status
}

fn gate_srv(dir: &std::path::Path) -> Arc<crate::Server> {
    server(dir, Deps::default())
}

fn gate_srv_with(dir: &std::path::Path, c: AccessConfig, allowed: &[&str]) -> Arc<crate::Server> {
    let srv = server_with(
        dir,
        Deps::default(),
        allowed.iter().map(|s| (*s).to_owned()).collect(),
    );
    let st = srv.access.as_ref().unwrap();
    quiet(st);
    st.set_config(c).unwrap();
    srv
}

async fn host_status(srv: &Arc<crate::Server>, host: &str) -> (u16, String) {
    let r = call(srv, "GET", "/api/state", &[("Host", host)], "", LOCAL).await;
    (r.status, r.body)
}

async fn host_origin_status(srv: &Arc<crate::Server>, host: &str, origin: &str) -> u16 {
    let mut h = vec![
        ("Host", host),
        ("Content-Type", "application/json"),
        ("Sec-Fetch-Site", "same-origin"),
    ];
    if !origin.is_empty() {
        h.push(("Origin", origin));
    }
    call(srv, "POST", HEADLESS, &h, "{}", LOCAL).await.status
}

#[tokio::test]
async fn cross_origin_post_rejected() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let mut h = ok_headers();
    set(&mut h, "Origin", "https://evil.example");
    assert_eq!(gate_req(&srv, "POST", HEADLESS, &h).await, 403);
}

#[tokio::test]
async fn no_origin_allowed() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let h = vec![("Content-Type", "application/json")];
    assert_ne!(gate_req(&srv, "POST", HEADLESS, &h).await, 403);
}

#[tokio::test]
async fn text_plain_rejected() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let mut h = ok_headers();
    set(&mut h, "Content-Type", "text/plain");
    let r = call(&srv, "POST", HEADLESS, &h, "{}", LOCAL).await;
    assert_eq!(r.status, 415);
    assert_eq!(
        r.body,
        "application/json 또는 multipart/form-data 여야 합니다\n"
    );
    assert_eq!(r.header("X-Error-Code"), "forbidden");
}

#[tokio::test]
async fn same_origin_json_passes() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let got = gate_req(&srv, "POST", HEADLESS, &ok_headers()).await;
    assert!(![403, 415, 421].contains(&got), "status={got}");
    let mut h = ok_headers();
    set(&mut h, "Content-Type", "Application/JSON; charset=utf-8");
    let got = gate_req(&srv, "POST", HEADLESS, &h).await;
    assert!(![403, 415, 421].contains(&got), "status={got}");
}

#[tokio::test]
async fn cross_site_fetch_rejected() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let mut h = ok_headers();
    set(&mut h, "Sec-Fetch-Site", "cross-site");
    assert_eq!(gate_req(&srv, "POST", HEADLESS, &h).await, 403);
}

#[tokio::test]
async fn unknown_host_rejected_on_get() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let (st, body) = host_status(&srv, "evil.example").await;
    assert_eq!(st, 421);
    assert_eq!(
        body,
        "허용되지 않은 Host 입니다 — 설정 ▸ 접속 의 '이 컴퓨터의 별명' 에 이 이름을 추가하세요\n"
    );
}

#[tokio::test]
async fn unknown_host_carries_host_rejected_code() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let r = call(
        &srv,
        "GET",
        "/api/state",
        &[("Host", "evil.example")],
        "",
        LOCAL,
    )
    .await;
    assert_eq!(r.header("X-Error-Code"), "host_rejected");
    assert_eq!(r.header("Content-Type"), "text/plain; charset=utf-8");
}

#[tokio::test]
async fn known_hosts_pass() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    for host in [
        "localhost",
        "localhost:58146",
        "127.0.0.1",
        "127.0.0.1:58146",
        "[::1]:58146",
    ] {
        let r = call(&srv, "GET", "/api/ping", &[("Host", host)], "", LOCAL).await;
        assert_ne!(r.status, 421, "Host {host}");
    }
}

#[tokio::test]
async fn port_normalized() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let a = host_status(&srv, "127.0.0.1:9999").await.0;
    let b = host_status(&srv, "127.0.0.1").await.0;
    assert_eq!(a, b);
}

#[tokio::test]
async fn forwarded_headers_ignored() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let r = call(
        &srv,
        "GET",
        "/api/state",
        &[("Host", "evil.example"), ("X-Forwarded-Host", "localhost")],
        "",
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 421);
}

#[tokio::test]
async fn exempt_paths() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    for path in ["/", "/api/ping"] {
        let r = call(
            &srv,
            "GET",
            path,
            &[("Origin", "https://evil.example")],
            "",
            LOCAL,
        )
        .await;
        assert_ne!(r.status, 403, "{path}");
    }
}

#[tokio::test]
async fn exempt_is_method_scoped() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let mut h = ok_headers();
    set(&mut h, "Origin", "https://evil.example");
    assert_eq!(gate_req(&srv, "POST", "/api/ping", &h).await, 403);
}

#[tokio::test]
async fn deny_is_opaque() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    let r = call(
        &srv,
        "POST",
        HEADLESS,
        &[
            ("Content-Type", "application/json"),
            ("Origin", "https://evil.example"),
        ],
        "{}",
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body, "forbidden\n");
    assert!(!r.body.contains("127.0.0.1") && !r.body.contains("localhost"));
}

#[tokio::test]
async fn host_alias_passes() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv_with(
        d.path(),
        cfg(false, vec![], vec![entry("macmini-office")]),
        &[],
    );
    assert_ne!(host_status(&srv, "macmini-office:58146").await.0, 421);
}

#[tokio::test]
async fn unknown_alias_rejected_without_leaking() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv_with(
        d.path(),
        cfg(false, vec![], vec![entry("secret-name")]),
        &[],
    );
    let (st, body) = host_status(&srv, "evil.example").await;
    assert_eq!(st, 421);
    assert!(!body.contains("secret-name"));
}

#[tokio::test]
async fn host_alias_normalization() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv_with(
        d.path(),
        cfg(false, vec![], vec![entry("macmini-office")]),
        &[],
    );
    for host in [
        "macmini-office",
        "macmini-office:9999",
        "MACMINI-OFFICE",
        "macmini-office.",
    ] {
        assert_ne!(host_status(&srv, host).await.0, 421, "Host {host}");
    }
}

#[tokio::test]
async fn host_alias_applies_to_origin() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv_with(
        d.path(),
        cfg(false, vec![], vec![entry("macmini-office")]),
        &[],
    );
    assert_ne!(
        host_origin_status(&srv, "macmini-office:58146", "http://macmini-office:58146").await,
        403
    );
    let mut h = ok_headers();
    set(&mut h, "Origin", "http://macmini-office:58146");
    assert_eq!(gate_req(&srv, "POST", HEADLESS, &h).await, 403);
}

#[tokio::test]
async fn disabled_alias_is_ignored() {
    let d = tempfile::tempdir().unwrap();
    let mut off = entry("macmini-office");
    off.enabled = false;
    let srv = gate_srv_with(d.path(), cfg(false, vec![], vec![off]), &[]);
    assert_eq!(host_status(&srv, "macmini-office").await.0, 421);
}

#[tokio::test]
async fn alias_independent_of_enforcement_toggle() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv_with(
        d.path(),
        cfg(false, vec![], vec![entry("macmini-office")]),
        &[],
    );
    assert_ne!(host_status(&srv, "macmini-office").await.0, 421);
}

#[tokio::test]
async fn acl_entry_name_no_longer_allows_host() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv_with(d.path(), cfg(false, vec![entry("macmini")], vec![]), &[]);
    assert_eq!(host_status(&srv, "macmini").await.0, 421);
}

#[tokio::test]
async fn allowed_host_wildcard_still_works() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv_with(d.path(), AccessConfig::default(), &["*.ts.net"]);
    assert_ne!(
        host_status(&srv, "macmini-office.tail5da9ae.ts.net")
            .await
            .0,
        421
    );
}

#[tokio::test]
async fn other_port_origin_rejected() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    assert_eq!(
        host_origin_status(&srv, "localhost:58146", "http://localhost:3000").await,
        403
    );
}

#[tokio::test]
async fn deployment_origins_pass() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv_with(
        d.path(),
        cfg(false, vec![], vec![entry("macmini-office")]),
        &["*.ts.net", "192.168.1.5"],
    );
    for (host, origin) in [
        ("localhost:58146", "http://localhost:58146"),
        ("192.168.1.5:58146", "http://192.168.1.5:58146"),
        ("macmini-office:58146", "http://macmini-office:58146"),
        ("localhost:8080", "http://localhost:8080"),
        ("x.tail.ts.net", "https://x.tail.ts.net"),
    ] {
        let got = host_origin_status(&srv, host, origin).await;
        assert!(
            got != 403 && got != 421,
            "Host {host} · Origin {origin} → {got}"
        );
    }
}

#[tokio::test]
async fn origin_host_mismatch_rejected() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    assert_eq!(
        host_origin_status(&srv, "localhost:58146", "http://127.0.0.1:58146").await,
        403
    );
}

#[tokio::test]
async fn opaque_origin_rejected() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    for o in ["null", "file://", "chrome-extension://abc", "http://%zz"] {
        assert_eq!(
            host_origin_status(&srv, "localhost:58146", o).await,
            403,
            "{o}"
        );
    }
}

#[test]
fn origin_without_host_rejected() {
    let allow = HostAllow::new(None, Vec::new());
    let mut r = Req::for_test(http::Method::POST, HEADLESS, "{}");
    r.host = String::new();
    r.headers
        .insert("Content-Type", "application/json".parse().unwrap());
    r.headers
        .insert("Origin", "http://localhost:58146".parse().unwrap());
    let res = request_gate(&allow, &r).expect("거절이어야 한다");
    assert_eq!(res.status(), 403);
}

#[tokio::test]
async fn origin_authority_normalized() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    for (host, origin) in [
        ("[::1]:58146", "http://[::1]:58146"),
        ("LOCALHOST:58146", "http://localhost:58146"),
        ("localhost.:58146", "http://localhost:58146"),
    ] {
        assert_ne!(
            host_origin_status(&srv, host, origin).await,
            403,
            "{host} {origin}"
        );
    }
}

#[tokio::test]
async fn origin_default_port_not_inferred() {
    let d = tempfile::tempdir().unwrap();
    let srv = gate_srv(d.path());
    assert_eq!(
        host_origin_status(&srv, "localhost:58146", "http://localhost").await,
        403
    );
}
