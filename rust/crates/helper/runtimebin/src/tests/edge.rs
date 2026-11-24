//! `otterctl edges`·`otterctl edge` (Go otterctl_edge_test.go 의 관측 기대값).

use serde_json::Value;

use super::*;
use crate::otterctl::edge::parse_sub_args;

const EDGES_FAKE_JSON: &str = r#"{
 "node":{"enabled":true,"port":58147,"bind":"0.0.0.0","name":"office","tag":"4321","advertise":"",
  "fingerprint":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","listening":false,"error":"bind: address already in use"},
 "edges":[{"name":"home","tag":"1234","addr":"10.0.0.2","port":58147,"fp":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
          {"name":"home","tag":"5678","addr":"","port":0,"fp":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
          {"name":"laptop","addr":"10.0.0.4","port":58147,"fp":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],
 "invite":null}"#;

fn run(status: u16, body: &str, args: &[&str]) -> ((i32, String, String), Vec<Req>) {
    let srv = TestServer::fixed(status, body);
    let home = tempfile::tempdir().unwrap();
    let got = ctl(&srv.env(home.path()), args);
    (got, srv.requests())
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|a| (*a).to_owned()).collect()
}

#[test]
fn edges_text() {
    let ((rc, out, err), reqs) = run(200, EDGES_FAKE_JSON, &["edges"]);
    assert_eq!(rc, 0, "{err}");
    assert_eq!(
        (reqs[0].method.as_str(), reqs[0].path()),
        ("GET", "/api/edges")
    );
    for want in [
        "name=office#4321",
        "port=58147",
        "listening=no",
        "fp=0123456789abcdef",
        "address already in use",
        "edge     fp=aaaaaaaaaaaaaaaa  name=home#1234  addr=10.0.0.2:58147",
        "edge     fp=bbbbbbbbbbbbbbbb  name=home#5678  addr=-",
        "name=laptop  ",
    ] {
        assert!(out.contains(want), "{want:?} 없음:\n{out}");
    }
    assert!(!out.contains("state=") && !out.contains("pending"), "{out}");
    assert!(!out.contains(&"a".repeat(17)), "지문 전체가 보인다:\n{out}");
}

#[test]
fn edges_json() {
    let ((rc, out, _), _) = run(200, EDGES_FAKE_JSON, &["edges", "--json"]);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(rc, 0);
    assert!(!v["node"].is_null());
    assert_eq!(out.lines().count(), 1);
}

#[test]
fn edge_invite() {
    let ((rc, out, err), reqs) = run(
        200,
        r#"{"code":"dmedge1:abc","expires":"2026-11-10T09:10:00Z"}"#,
        &["edge", "invite", "--addr", "192.168.0.5"],
    );
    assert_eq!(rc, 0, "{err}");
    let r = &reqs[0];
    assert_eq!((r.method.as_str(), r.path()), ("POST", "/api/edges/invite"));
    assert_eq!(r.json()["addr"], "192.168.0.5");
    assert_eq!(out.trim(), "dmedge1:abc");
}

/// FR-EPR-51: add 는 코드만 보내고, 맺은 상대의 이름과 지문 앞자리를 낸다.
#[test]
fn edge_add() {
    let ((rc, out, err), reqs) = run(
        200,
        r#"{"fp":"0123456789abcdef0011","name":"home"}"#,
        &["edge", "add", "dmedge1:abc"],
    );
    assert_eq!(rc, 0, "{err}");
    let body = reqs[0].json();
    assert_eq!(reqs[0].path(), "/api/edges/add");
    assert_eq!(body["code"], "dmedge1:abc");
    assert_eq!(body.as_object().unwrap().len(), 1);
    assert!(out.contains("home") && out.contains("0123456789abcdef") && !out.contains("0011"));
}

/// FR-PNW-74: 닿지 않으면 사유 코드를 내고 1 로 끝난다.
#[test]
fn edge_add_unreachable() {
    let ((rc, _, err), _) = run(
        502,
        r#"{"code":"edge_unreachable","message":"dial tcp: refused"}"#,
        &["edge", "add", "dmedge1:abc"],
    );
    assert_eq!(rc, 1);
    assert!(err.contains("edge_unreachable"), "{err}");
}

/// FR-EPR-52·60: remove 는 지문 앞자리를 보내고, 상대에게 알리지 못했으면 stderr 에 알린다.
#[test]
fn edge_remove() {
    let ((rc, out, err), reqs) = run(
        200,
        r#"{"fp":"0123456789abcdef0011","name":"home","notified":false}"#,
        &["edge", "remove", "01234567"],
    );
    assert_eq!(rc, 0, "{err}");
    assert_eq!(reqs[0].path(), "/api/edges/remove");
    assert_eq!(reqs[0].json()["fp"], "01234567");
    assert!(out.contains("home") && err.contains("알리지 못했습니다"));
}

/// 인자가 틀리거나 없어진 하위 명령이면 서버에 보내지 않고 2 다. 옛 명령 이름은 실패다.
#[test]
fn edge_usage_never_posts() {
    let srv = TestServer::fixed(200, "{}");
    let home = tempfile::tempdir().unwrap();
    let env = srv.env(home.path());
    for args in [
        &["edge"][..],
        &["edge", "bogus"],
        &["edge", "add"],
        &["edge", "remove"],
        &["edge", "invite", "--addr"],
        &["edge", "add", "c", "--nope"],
        // FR-EPR-60
        &["edge", "approve", "p1"],
        &["edge", "reject", "p1"],
        &["edge", "add", "c", "--name", "x"],
        // FR-PDM-62
        &["edge", "info", "home"],
        &["edge", "tools", "home"],
        &[
            "edge", "spawn", "home", "hi", "--agent", "claude", "--cwd", "/w",
        ],
        &["edge", "status", "home/u-1"],
        &["edge", "close", "home/u-1"],
        &["edge", "notify"],
    ] {
        assert_eq!(ctl(&env, args).0, 2, "{args:?}");
    }
    for args in [
        &["edge", "--help"][..],
        &["edge", "add", "--help"],
        &["edges", "--help"],
    ] {
        let (rc, out, _) = ctl(&env, args);
        assert!(rc == 0 && !out.is_empty(), "{args:?}");
    }
    // FR-PDM-70
    for args in [
        &["peers"][..],
        &["peer", "invite"],
        &["peer", "remove", "home"],
    ] {
        assert_ne!(ctl(&env, args).0, 0, "{args:?}");
    }
    assert!(srv.requests().is_empty());
}

#[test]
fn edge_usage_texts() {
    let home = tempfile::tempdir().unwrap();
    let env = env_at(home.path(), closed_port());
    let (_, _, err) = ctl(&env, &["edge", "bogus"]);
    assert!(
        err.starts_with("otterctl edge: 모르는 하위 명령 \"bogus\"\notterctl edge — "),
        "{err}"
    );
    let (_, _, err) = ctl(&env, &["edge", "add"]);
    assert_eq!(err, "otterctl edge add: 인자가 1 개여야 합니다\n");
    let (_, _, err) = ctl(&env, &["edge", "invite", "--addr"]);
    assert_eq!(err, "otterctl edge invite: --addr 에 값이 없습니다\n");
    let (_, _, err) = ctl(&env, &["edge", "add", "--bogus"]);
    assert_eq!(err, "otterctl edge add: unknown argument: --bogus\n");
    let (_, _, err) = ctl(&env, &["edges", "--bogus"]);
    assert_eq!(err, "otterctl edges: unknown argument: --bogus\n");
}

/// 상대가 보낸 주소·이름, 거절 본문도 찍기 전에 제어 문자를 지운다.
#[test]
fn edge_cleans_remote_text() {
    let body = EDGES_FAKE_JSON.replacen(
        r#""name":"laptop","addr":"10.0.0.4""#,
        r#""name":"lap\u001b[2Jtop","addr":"10.0.0.4\u001b]0;x\u0007""#,
        1,
    );
    let ((_, out, _), _) = run(200, &body, &["edges"]);
    assert!(!out.contains(['\x1b', '\x07']), "{out:?}");
    for refusal in [
        r#"{"code":"edge_unreachable","message":"x\u001b]52;c;AA==\u0007"}"#,
        "\x1b]0;title\x07 not json",
    ] {
        let ((_, _, err), _) = run(502, refusal, &["edge", "remove", "01234567"]);
        assert!(!err.contains(['\x1b', '\x07']), "{err:?}");
    }
    let ((_, out, err), _) = run(
        200,
        r#"{"name":"la\u001b[2Jp","fp":"f\u001b]52;c;AA==\u0007"}"#,
        &["edge", "add", "dmedge1:abc"],
    );
    assert!(!(out + &err).contains(['\x1b', '\x07']));
}

/// L-14: --name=x 형식, -- 종료자, 값 자리에 온 플래그.
#[test]
fn parse_sub_args_forms() {
    let (pa, err) = parse_sub_args(
        &s(&["--name=lap", "code", "--", "--json"]),
        &["name"],
        &["json"],
    );
    assert!(err.is_none());
    assert_eq!(pa.flag("name"), "lap");
    assert_eq!(pa.pos, s(&["code", "--json"]));
    assert!(!pa.has("json"));
    assert!(
        parse_sub_args(&s(&["--name", "--json"]), &["name"], &["json"])
            .1
            .is_some()
    );
    assert!(
        parse_sub_args(&s(&["--json=1"]), &[], &["json"])
            .1
            .is_some()
    );
}

/// FR-PDM-66·67: otterctl edges 는 lastSeen 을 보이지 않는다.
#[test]
fn edges_hide_last_seen() {
    let body = EDGES_FAKE_JSON.replacen(
        r#""port":58147,"fp":"aaaa"#,
        r#""lastSeen":"2026-11-10T09:01:02Z","port":58147,"fp":"aaaa"#,
        1,
    );
    let ((_, out, _), _) = run(200, &body, &["edges"]);
    assert!(!out.contains("lastSeen"), "{out}");
}

/// EDGE_MESH_SRS FR-EGM-62: notify 는 /api/edges/notify 를 부르고 알린 상대를 찍는다.
#[test]
fn edge_notify() {
    let ((rc, out, err), reqs) = run(
        200,
        r#"{"fp":"aaaaaaaaaaaaaaaaaaaaaaaa","name":"home","tag":"1234","notified":true}"#,
        &["edge", "notify", "home#1234"],
    );
    assert_eq!(rc, 0, "{err}");
    assert_eq!(
        (reqs[0].method.as_str(), reqs[0].path()),
        ("POST", "/api/edges/notify")
    );
    assert_eq!(reqs[0].json()["fp"], "home#1234");
    assert_eq!(out, "알렸습니다: home#1234\n");
    let ((rc, _, err), _) = run(
        409,
        r#"{"code":"edge_addr_unknown","message":"상대 주소를 모른다"}"#,
        &["edge", "notify", "home#1234"],
    );
    assert_eq!(rc, 1);
    assert!(err.contains("edge_addr_unknown"), "{err}");
}

/// FR-EGM-63: 간선 줄 끝에 알림 대기·옛 판을 적는다.
#[test]
fn edges_show_mesh_marks() {
    let ((_, out, _), _) = run(
        200,
        r#"{"node":{"name":"office","tag":"4321"},
 "edges":[{"name":"home","tag":"1234","addr":"10.0.0.2","port":1,"fp":"aaaaaaaaaaaaaaaaaaaaaaaa","pending":true},
          {"name":"old","tag":"5678","addr":"10.0.0.3","port":1,"fp":"bbbbbbbbbbbbbbbbbbbbbbbb","outdated":true},
          {"name":"ok","tag":"9999","addr":"10.0.0.4","port":1,"fp":"cccccccccccccccccccccccc"}]}"#,
        &["edges"],
    );
    let lines: Vec<&str> = out.trim().split('\n').collect();
    assert_eq!(lines.len(), 4, "{out}");
    assert!(lines[1].ends_with("  알림 대기"));
    assert!(lines[2].ends_with("  옛 판"));
    assert!(!lines[3].contains("대기") && !lines[3].contains("옛 판"));
}

#[test]
fn edges_full_text_and_ipv6() {
    let ((_, out, _), _) = run(
        200,
        r#"{"node":{"enabled":true,"port":5,"bind":"::","name":"n","advertise":"a.b","fingerprint":"ff"},
 "edges":[{"name":"x","addr":"fe80::1","port":7,"fp":"ab"}],"invite":{"expires":"T"}}"#,
        &["edges"],
    );
    assert_eq!(
        out,
        "node     name=n  enabled=yes  bind=::  port=5  listening=no  fp=ff  advertise=a.b\n\
         edge     fp=ab  name=x  addr=[fe80::1]:7\n\
         invite   expires=T\n"
    );
}
