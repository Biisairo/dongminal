//! 접근 허용 목록 (Go `access_test.go`·`access_check_test.go`·`access_save_test.go`·
//! `access_matcher_test.go`·`access_denied_test.go`·`access_lookup_unlocked_test.go`).

use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::support::*;
use crate::Deps;
use crate::access::{AccessConfig, AccessStore, SaveError};
use crate::access_api::access_gate;
use crate::netx::parse_addr;
use crate::req::Req;

fn gate_status(st: &Arc<AccessStore>, remote: &str, path: &str) -> u16 {
    gate_status_h(st, remote, path, &[])
}

fn gate_status_h(st: &Arc<AccessStore>, remote: &str, path: &str, h: &[(&str, &str)]) -> u16 {
    let mut r = Req::for_test(http::Method::GET, path, "");
    r.remote_addr = remote.to_owned();
    for (k, v) in h {
        r.headers.insert(
            http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            v.parse().unwrap(),
        );
    }
    access_gate(Some(st), &r).map_or(200, |res| res.status().as_u16())
}

fn on(vals: &[&str]) -> AccessConfig {
    cfg(true, vals.iter().map(|v| entry(v)).collect(), vec![])
}

fn set_ifaddrs(st: &AccessStore, addrs: &[&str]) {
    let v: Vec<IpAddr> = addrs.iter().map(|a| a.parse().unwrap()).collect();
    *st.interface_addrs.write().unwrap() = Arc::new(move || Ok(v.clone()));
}

fn set_lookup(
    st: &AccessStore,
    f: impl Fn(&str) -> Result<Vec<String>, String> + Send + Sync + 'static,
) {
    *st.lookup_host.write().unwrap() = Arc::new(f);
}

#[test]
fn save_reload() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(on(&["10.0.0.1"])).unwrap();
    let again = AccessStore::new(d.path().join("access.json"));
    let got = again.config();
    assert!(got.enabled);
    assert_eq!(got.entries.unwrap()[0].value, "10.0.0.1");
}

#[test]
fn saved_file_matches_go_layout() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(cfg(true, vec![entry("10.0.0.1")], vec![]))
        .unwrap();
    let raw = std::fs::read_to_string(d.path().join("access.json")).unwrap();
    assert_eq!(
        raw,
        "{\n  \"enabled\": true,\n  \"entries\": [\n    {\n      \"id\": \"e-10.0.0.1\",\n      \"value\": \"10.0.0.1\",\n      \"enabled\": true\n    }\n  ]\n}"
    );
}

#[test]
fn unreadable_file_starts_open() {
    let d = tempfile::tempdir().unwrap();
    let missing = AccessStore::new(d.path().join("nope.json"));
    assert!(!missing.config().enabled);
    let broken = d.path().join("broken.json");
    std::fs::write(&broken, "{ this is not json").unwrap();
    let st = AccessStore::new(broken);
    assert!(!st.config().enabled);
    assert!(st.config().entries.is_none());
}

#[test]
fn self_address_always_allowed() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    set_ifaddrs(&st, &["100.89.214.106"]);
    st.refresh();
    st.set_config(cfg(true, vec![], vec![])).unwrap();
    for a in ["127.0.0.1:5000", "[::1]:5000", "100.89.214.106:5000"] {
        assert_eq!(gate_status(&st, a, "/"), 200, "{a}");
    }
    assert_eq!(gate_status(&st, "100.117.248.111:5000", "/"), 403);
}

#[test]
fn loopback_survives_interface_failure() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    *st.interface_addrs.write().unwrap() =
        Arc::new(|| Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)));
    st.refresh();
    st.set_config(cfg(true, vec![], vec![])).unwrap();
    assert_eq!(gate_status(&st, "127.0.0.1:5000", "/"), 200);
}

#[test]
fn ignores_forwarded_headers() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(on(&["10.0.0.1"])).unwrap();
    let got = gate_status_h(
        &st,
        "203.0.113.9:5000",
        "/",
        &[("X-Forwarded-For", "10.0.0.1"), ("X-Real-IP", "10.0.0.1")],
    );
    assert_eq!(got, 403);
}

#[test]
fn disabled_passes_everything() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(cfg(false, vec![], vec![])).unwrap();
    assert_eq!(gate_status(&st, "203.0.113.9:5000", "/"), 200);
}

#[tokio::test]
async fn blocks_unlisted_without_leaking() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let st = srv.access.as_ref().unwrap();
    quiet(st);
    st.set_config(on(&["10.0.0.1"])).unwrap();
    let r = call(&srv, "GET", "/api/ping", &[], "", "203.0.113.9:5000").await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body, "forbidden\n");
    assert_eq!(r.header("X-Error-Code"), "forbidden");
    assert!(
        !r.header("X-Request-Id").is_empty(),
        "거절에도 요청 ID 가 있다"
    );
}

#[test]
fn covers_every_surface() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(cfg(true, vec![], vec![])).unwrap();
    for p in [
        "/",
        "/index.html",
        "/api/state",
        "/api/settings",
        "/channel",
    ] {
        assert_eq!(gate_status(&st, "203.0.113.9:5000", p), 403, "{p}");
    }
}

#[test]
fn literal_cidr_hostname() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    set_lookup(&st, |h| {
        if h == "macmini" {
            Ok(vec!["100.117.248.111".to_owned()])
        } else {
            Err("no".to_owned())
        }
    });
    st.refresh();
    st.set_config(on(&["10.0.0.1", "192.168.7.0/24", "macmini"]))
        .unwrap();
    for (a, want) in [
        ("10.0.0.1:5000", 200),
        ("10.0.0.2:5000", 403),
        ("192.168.7.55:5000", 200),
        ("192.168.8.55:5000", 403),
        ("100.117.248.111:5000", 200),
        ("100.117.248.112:5000", 403),
    ] {
        assert_eq!(gate_status(&st, a, "/"), want, "{a}");
    }
}

#[test]
fn no_dns_on_request_path() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    set_lookup(&st, move |_| {
        c.fetch_add(1, Ordering::SeqCst);
        Ok(vec!["100.117.248.111".to_owned()])
    });
    st.set_config(on(&["macmini"])).unwrap();
    let before = calls.load(Ordering::SeqCst);
    for _ in 0..5 {
        gate_status(&st, "100.117.248.111:5000", "/");
    }
    assert_eq!(calls.load(Ordering::SeqCst), before);
}

#[test]
fn resolve_failure_blocks_and_surfaces() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    set_lookup(&st, |h| Err(format!("lookup {h}: no such host")));
    st.set_config(on(&["macmini.local"])).unwrap();
    assert_eq!(gate_status(&st, "100.117.248.111:5000", "/"), 403);
    let v = st.view();
    assert_eq!(v.entries.len(), 1);
    assert_eq!(v.entries[0].error, "lookup macmini.local: no such host");
}

#[test]
fn disabled_entry_is_ignored() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    let mut off = entry("10.0.0.1");
    off.enabled = false;
    st.set_config(cfg(true, vec![off], vec![])).unwrap();
    assert_eq!(gate_status(&st, "10.0.0.1:5000", "/"), 403);
}

#[test]
fn rejects_invalid_value() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    for bad in [
        "",
        "   ",
        "10.0.0.300",
        "192.168.0.0/99",
        "has space",
        "http://macmini",
    ] {
        assert!(st.set_config(on(&[bad])).is_err(), "{bad:?}");
    }
    assert!(st.config().entries.is_none());
}

#[test]
fn invalid_value_messages_match_go() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    assert_eq!(
        st.set_config(on(&["  "])),
        Err(SaveError::Invalid("entries[0]: 빈 값".to_owned()))
    );
    assert_eq!(
        st.set_config(on(&["10.0.0.1", "nope!!"])),
        Err(SaveError::Invalid(
            "entries[1]: \"nope!!\" 는 IP·CIDR·호스트명 중 어느 것도 아니다".to_owned()
        ))
    );
    assert_eq!(
        st.set_config(cfg(false, vec![], vec![entry("*.ts.net")])),
        Err(SaveError::Invalid(
            "hosts[0]: \"*.ts.net\" — 와일드카드는 쓸 수 없다. 이 컴퓨터가 불리는 이름을 그대로 적는다"
                .to_owned()
        ))
    );
    assert_eq!(
        st.set_config(cfg(false, vec![], vec![entry("a:1")])),
        Err(SaveError::Invalid(
            "hosts[0]: \"a:1\" 는 이름이 아니다 — IP·대역·포트·스킴은 위쪽 허용 목록이 담당한다"
                .to_owned()
        ))
    );
}

#[tokio::test]
async fn api_round_trip_and_broadcast() {
    let d = tempfile::tempdir().unwrap();
    let hub = otter_webserver_hub::CommandHub::new();
    let sub = otter_webserver_hub::CommandBroker::add(&*hub).unwrap();
    let srv = server(
        d.path(),
        Deps {
            commands: Some(hub),
            ..Deps::default()
        },
    );
    quiet(srv.access.as_ref().unwrap());
    let body = r#"{"enabled":true,"entries":[{"id":"a","value":"10.0.0.1","label":"nas","enabled":true}]}"#;
    let r = call(
        &srv,
        "PUT",
        "/api/access",
        &[("Content-Type", "application/json")],
        body,
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(r.body, "");
    assert_eq!(r.header("ETag").len(), 16);
    let g = get(&srv, "/api/access").await;
    assert_eq!(g.status, 200);
    assert_eq!(g.header("ETag"), r.header("ETag"));
    let v = g.json();
    assert_eq!(v["enabled"], true);
    assert_eq!(v["entries"][0]["value"], "10.0.0.1");
    assert_eq!(
        sub.try_recv().as_deref(),
        Some(&br#"{"action":"access_changed","args":{}}"#[..])
    );
    assert!(sub.try_recv().is_none(), "방송은 정확히 1회");
}

#[tokio::test]
async fn api_get_body_matches_go_shape() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let st = srv.access.as_ref().unwrap();
    quiet(st);
    st.set_config(cfg(false, vec![entry("10.0.0.1")], vec![]))
        .unwrap();
    let r = call(
        &srv,
        "GET",
        "/api/access",
        &[("Host", "LocalHost:1")],
        "",
        "100.117.248.111:5000",
    )
    .await;
    let hn = srv.hosts.hostname.clone();
    let mut want = String::from(
        r#"{"enabled":false,"entries":[{"id":"e-10.0.0.1","value":"10.0.0.1","enabled":true}],"you":"100.117.248.111","hosts":null"#,
    );
    if !hn.is_empty() {
        want.push_str(&format!(r#","hostname":"{hn}""#));
    }
    want.push_str(",\"host\":\"localhost\"}\n");
    assert_eq!(r.body, want);
    assert_eq!(r.header("Content-Type"), "application/json");
}

#[tokio::test]
async fn api_invalid_value_is_400() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let r = call(
        &srv,
        "PUT",
        "/api/access",
        &[("Content-Type", "application/json")],
        r#"{"enabled":true,"entries":[{"id":"a","value":"nope!!","enabled":true}]}"#,
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(
        r.body,
        "entries[0]: \"nope!!\" 는 IP·CIDR·호스트명 중 어느 것도 아니다\n"
    );
    assert_eq!(r.header("X-Error-Code"), "bad_request");
    assert!(srv.access.as_ref().unwrap().config().entries.is_none());
}

#[tokio::test]
async fn api_bad_json_and_stale() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let h = [("Content-Type", "application/json")];
    let r = call(&srv, "PUT", "/api/access", &h, "{nope", LOCAL).await;
    assert_eq!((r.status, r.body.as_str()), (400, "invalid json\n"));
    assert_eq!(r.header("X-Error-Code"), "invalid_json");
    let h = [
        ("Content-Type", "application/json"),
        ("If-Match", "deadbeef"),
    ];
    let r = call(&srv, "PUT", "/api/access", &h, "{}", LOCAL).await;
    assert_eq!((r.status, r.body.as_str()), (409, "stale revision\n"));
    assert_eq!(r.header("X-Error-Code"), "stale_revision");
    assert_eq!(r.header("ETag").len(), 16);
}

#[tokio::test]
async fn api_reports_caller_address() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let r = call(&srv, "GET", "/api/access", &[], "", "100.117.248.111:5000").await;
    assert_eq!(r.json()["you"], "100.117.248.111");
}

#[test]
fn host_alias_save_reload() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(cfg(
        false,
        vec![entry("10.0.0.1")],
        vec![entry("macmini-office")],
    ))
    .unwrap();
    let again = AccessStore::new(d.path().join("access.json")).config();
    assert_eq!(again.hosts.unwrap()[0].value, "macmini-office");
    assert_eq!(again.entries.unwrap().len(), 1);
}

#[test]
fn host_alias_missing_key_is_empty() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("access.json");
    std::fs::write(
        &p,
        r#"{"enabled":true,"entries":[{"id":"a","value":"10.0.0.1","enabled":true}]}"#,
    )
    .unwrap();
    let c = AccessStore::new(p).config();
    assert!(c.hosts.is_none());
    assert!(c.enabled);
    assert_eq!(c.entries.unwrap().len(), 1);
}

#[test]
fn host_alias_accepts_hostnames() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    for ok in [
        "macmini-office",
        "macmini-office.tail5da9ae.ts.net",
        "macmini.local",
    ] {
        st.set_config(cfg(false, vec![], vec![entry(ok)])).unwrap();
    }
}

#[test]
fn host_alias_rejects_wildcards_and_non_names() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    let long = "a".repeat(254);
    let bad = [
        "",
        "   ",
        "*",
        "*.",
        "*.ts.net",
        "*.local",
        "a*b",
        "?",
        "**",
        "100.89.214.106",
        "::1",
        "192.168.0.0/24",
        "http://macmini-office",
        "macmini-office:58146",
        "macmini-office/x",
        "u@macmini-office",
        "-x",
        "x-",
        "x..y",
        long.as_str(),
    ];
    for v in bad {
        assert!(
            st.set_config(cfg(false, vec![], vec![entry(v)])).is_err(),
            "{v:?}"
        );
    }
    assert!(st.config().hosts.is_none());
}

#[test]
fn host_alias_normalized_on_save() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(cfg(false, vec![], vec![entry("  MacMini-Office.  ")]))
        .unwrap();
    assert_eq!(st.config().hosts.unwrap()[0].value, "macmini-office");
}

#[test]
fn host_alias_all_or_nothing() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(cfg(false, vec![], vec![entry("macmini-office")]))
        .unwrap();
    assert!(
        st.set_config(cfg(
            false,
            vec![],
            vec![entry("macbook-air"), entry("*.ts.net")]
        ))
        .is_err()
    );
    let h = st.config().hosts.unwrap();
    assert_eq!(h.len(), 1);
    assert_eq!(h[0].value, "macmini-office");
}

#[test]
fn host_alias_never_resolved() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    set_lookup(&st, move |_| {
        c.fetch_add(1, Ordering::SeqCst);
        Ok(vec!["100.89.214.106".to_owned()])
    });
    st.set_config(cfg(false, vec![], vec![entry("macmini-office")]))
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(st.view().hosts.unwrap()[0].value, "macmini-office");
}

#[tokio::test]
async fn api_host_alias_view() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    quiet(srv.access.as_ref().unwrap());
    let body = r#"{"enabled":false,"entries":[{"id":"a","value":"10.0.0.1","enabled":true}],"hosts":[{"id":"h","value":"macmini-office","label":"tailnet","enabled":true}]}"#;
    let r = call(
        &srv,
        "PUT",
        "/api/access",
        &[("Content-Type", "application/json")],
        body,
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let g = call(
        &srv,
        "GET",
        "/api/access",
        &[("Host", "macmini-office:58146")],
        "",
        LOCAL,
    )
    .await;
    let v = g.json();
    assert_eq!(v["hosts"][0]["value"], "macmini-office");
    assert_eq!(v["host"], "macmini-office");
    assert_eq!(v["you"], "127.0.0.1");
}

#[tokio::test]
async fn api_hosts_omitted_replaces_with_empty() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let st = srv.access.as_ref().unwrap();
    quiet(st);
    st.set_config(cfg(false, vec![], vec![entry("macmini-office")]))
        .unwrap();
    let r = call(
        &srv,
        "PUT",
        "/api/access",
        &[("Content-Type", "application/json")],
        r#"{"enabled":false,"entries":[]}"#,
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200);
    assert!(st.config().hosts.is_none());
}

#[tokio::test]
async fn put_resolves_before_answering() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let st = srv.access.as_ref().unwrap();
    quiet(st);
    set_lookup(st, |_| Ok(vec!["10.0.0.9".to_owned()]));
    let r = call(
        &srv,
        "PUT",
        "/api/access",
        &[("Content-Type", "application/json")],
        r#"{"enabled":false,"entries":[{"id":"a","value":"office-box","enabled":true}]}"#,
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200);
    let v = st.view();
    assert_eq!(
        v.entries[0].resolved.as_deref(),
        Some(&["10.0.0.9".to_owned()][..])
    );
}

const CHECK_SELF: &str = "192.168.7.7";

fn check_store(dir: &std::path::Path) -> Arc<AccessStore> {
    let st = test_store(dir);
    set_ifaddrs(&st, &[CHECK_SELF]);
    set_lookup(&st, |h| match h {
        "box.lan" => Ok(vec!["fd00::5".to_owned()]),
        "far.lan" => Ok(vec!["10.9.9.9".to_owned()]),
        _ => Err(format!("no such host {h}")),
    });
    st.set_config(cfg(
        false,
        vec![entry("box.lan"), entry("far.lan"), entry("gone.lan")],
        vec![],
    ))
    .unwrap();
    st
}

#[test]
fn check_save_table() {
    let mut disabled = entry("10.0.0.0/8");
    disabled.enabled = false;
    let cases: Vec<(AccessConfig, &str, bool)> = vec![
        (cfg(false, vec![], vec![]), "10.0.0.5", true),
        (on(&["10.0.0.0/8"]), "10.0.0.5", true),
        (on(&["10.0.0.0/8"]), "172.16.0.5", false),
        (on(&["172.16.0.5"]), "172.16.0.5", true),
        (on(&["fd00::/8"]), "fd00::42", true),
        (on(&["fd00::/8"]), "2001:db8::1", false),
        (on(&["10.0.0.0/8"]), "fd00::42", false),
        (on(&["10.0.0.0/8"]), "::ffff:10.0.0.5", true),
        (on(&["10.0.0.0/8"]), "127.0.0.1", true),
        (on(&["10.0.0.0/8"]), CHECK_SELF, true),
        (on(&["box.lan"]), "fd00::5", true),
        (on(&["far.lan"]), "fd00::5", false),
        (on(&["gone.lan"]), "fd00::5", false),
        (on(&["new.lan"]), "fd00::5", true),
        (cfg(true, vec![disabled], vec![]), "10.0.0.5", false),
    ];
    for (c, you, ok) in cases {
        let d = tempfile::tempdir().unwrap();
        let st = check_store(d.path());
        let a = st.check_save(&c, &parse_addr(you).unwrap()).unwrap();
        assert_eq!(a.ok, ok, "{you} {c:?}");
        if !ok {
            let j = otter_gocompat::json::marshal(&a).unwrap();
            let want = format!(
                r#"{{"ok":false,"why":"locks_you_out","args":{{"you":"{}"}}}}"#,
                parse_addr(you).unwrap().unmap()
            );
            assert_eq!(String::from_utf8(j).unwrap(), want);
        }
    }
}

#[test]
fn check_does_not_save_and_validates_like_save() {
    let d = tempfile::tempdir().unwrap();
    let st = check_store(d.path());
    let before = st.config();
    st.check_save(&on(&["10.0.0.0/8"]), &parse_addr("10.0.0.5").unwrap())
        .unwrap();
    assert_eq!(st.config(), before);
    let bad = on(&["10.0.0.300"]);
    let check = st
        .check_save(&bad, &parse_addr("10.0.0.5").unwrap())
        .unwrap_err();
    let put = st.set_config(bad).unwrap_err();
    assert_eq!(SaveError::Invalid(check), put);
}

#[tokio::test]
async fn check_endpoint() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let st = srv.access.as_ref().unwrap();
    quiet(st);
    let h = [("Content-Type", "application/json")];
    let body = r#"{"enabled":true,"entries":[{"id":"a","value":"10.0.0.0/8","enabled":true}]}"#;
    let r = call(
        &srv,
        "POST",
        "/api/access/check",
        &h,
        body,
        "192.0.2.1:1234",
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        "{\"actions\":{\"access.save\":{\"ok\":false,\"why\":\"locks_you_out\",\"args\":{\"you\":\"192.0.2.1\"}}},\"you\":\"192.0.2.1\"}\n"
    );
    let r = call(
        &srv,
        "POST",
        "/api/access/check",
        &h,
        r#"{"enabled":true,"entries":[{"value":"nope!"}]}"#,
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 400);
}

#[test]
fn save_failure_is_reported_and_rolls_back() {
    let d = tempfile::tempdir().unwrap();
    let blocker = d.path().join("blocker");
    std::fs::write(&blocker, "x").unwrap();
    let st = Arc::new(AccessStore::new(blocker.join("access.json")));
    quiet(&st);
    let before = st.config();
    assert_eq!(st.set_config(on(&["10.0.0.1"])), Err(SaveError::Failed));
    assert_eq!(st.config(), before);
    assert_eq!(
        gate_status(&st, "203.0.113.9:5000", "/"),
        200,
        "판정 표도 되돌린다"
    );
}

#[test]
fn matcher_rebuilt_on_refresh() {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(on(&["peer.lan"])).unwrap();
    assert_eq!(gate_status(&st, "10.1.1.1:5000", "/"), 403);
    set_lookup(&st, |_| Ok(vec!["10.1.1.1".to_owned()]));
    st.refresh();
    assert_eq!(gate_status(&st, "10.1.1.1:5000", "/"), 200);
}

fn denied(remote: &str, h: &[(&str, &str)]) -> (u16, http::HeaderMap, String) {
    let d = tempfile::tempdir().unwrap();
    let st = test_store(d.path());
    st.set_config(on(&["10.0.0.1"])).unwrap();
    let mut r = Req::for_test(http::Method::GET, "/", "");
    r.remote_addr = remote.to_owned();
    for (k, v) in h {
        r.headers.insert(
            http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            v.parse().unwrap(),
        );
    }
    let res = access_gate(Some(&st), &r).unwrap();
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = futures_body(res);
    (status, headers, body)
}

fn futures_body(res: otter_shared_httpresp::Response) -> String {
    use http_body_util::BodyExt;
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let b = rt.block_on(res.into_body().collect()).unwrap().to_bytes();
    String::from_utf8_lossy(&b).into_owned()
}

#[test]
fn denied_document_gets_page() {
    let (st, h, body) = denied(
        "203.0.113.9:5000",
        &[("Accept", "text/html,application/xhtml+xml")],
    );
    assert_eq!(st, 403);
    assert!(body.contains("203.0.113.9") && body.contains("소유자"));
    for no in [
        "10.0.0.1", "<script", "src=", "href=", "@import", "boot-bar",
    ] {
        assert!(!body.contains(no), "{no}");
    }
    assert_eq!(h["content-type"], "text/html; charset=utf-8");
    assert_eq!(h["x-error-code"], "forbidden");
    assert_eq!(h["cache-control"], "no-store");
    assert_eq!(h["x-frame-options"], "DENY");
    assert_eq!(
        h["content-security-policy"],
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
}

#[test]
fn denied_page_matches_go_bytes() {
    let html = crate::access_denied::denied_page_html("1.2.3.4<&>");
    assert!(html.starts_with("<!DOCTYPE html>\n<meta charset=\"utf-8\">\n"));
    assert!(html.contains("<div class=\"ip\">1.2.3.4&lt;&amp;&gt;</div>"));
    assert!(html.ends_with("    OTTERMINAL\n  </div>\n</div>\n"));
    assert!(crate::access_denied::denied_page_html("  ").contains("(알 수 없음)"));
}

#[test]
fn denied_navigate_gets_page() {
    let (_, h, _) = denied("203.0.113.9:5000", &[("Sec-Fetch-Mode", "navigate")]);
    assert_eq!(h["content-type"], "text/html; charset=utf-8");
}

#[test]
fn denied_non_document_stays_plain() {
    for (accept, mode, upgrade) in [
        ("application/json", "cors", ""),
        ("", "", ""),
        ("text/html", "websocket", "websocket"),
    ] {
        let mut h = vec![];
        if !accept.is_empty() {
            h.push(("Accept", accept));
        }
        if !mode.is_empty() {
            h.push(("Sec-Fetch-Mode", mode));
        }
        if !upgrade.is_empty() {
            h.push(("Upgrade", upgrade));
        }
        let (st, hd, body) = denied("203.0.113.9:5000", &h);
        assert_eq!((st, body.as_str()), (403, "forbidden\n"));
        assert_eq!(hd["content-type"], "text/plain; charset=utf-8");
        assert_eq!(hd["x-error-code"], "forbidden");
    }
}

#[test]
fn denied_unparsable_addr_still_shows_something() {
    let (st, _, body) = denied("pipe", &[("Accept", "text/html")]);
    assert_eq!(st, 403);
    assert!(body.contains("pipe"));
}
