//! 명령 허브 종단 (Go `commands_*_test.go`·`entity_name_test.go`·`openurl_test.go`·
//! `focus_test.go` 의 HTTP 부분).

use std::collections::HashMap;
use std::sync::Arc;

use otter_webserver_action as action;
use otter_webserver_apierr as apierr;
use otter_webserver_hub::{CmdPosition, CmdResult, CmdSub, CommandBroker, CommandHub, TabRef};
use serde_json::Value;

use super::fakes::*;
use super::support::*;
use crate::entity_name::{ENTITY_NAME_MAX, entity_name_answer};
use crate::{Deps, Server};

fn srv(deps: Deps) -> (tempfile::TempDir, Arc<Server>) {
    let dir = tempfile::tempdir().unwrap();
    let s = server(dir.path(), deps);
    (dir, s)
}

fn with_cmds(c: Arc<dyn CommandBroker>) -> Deps {
    Deps {
        commands: Some(c),
        ..Deps::default()
    }
}

fn hub_and_sub() -> (Arc<dyn CommandBroker>, Arc<CmdSub>) {
    let h: Arc<dyn CommandBroker> = CommandHub::new();
    let sub = h.add().unwrap();
    (h, sub)
}

async fn post_cmd(s: &Arc<Server>, body: &str) -> Resp {
    post_json(s, "/api/commands", body).await
}

fn next_payload(sub: &CmdSub) -> Option<Value> {
    sub.try_recv()
        .map(|b| serde_json::from_slice(&b).unwrap_or(Value::Null))
}

// ── POST /api/commands ──

#[tokio::test]
async fn command_post_basic() {
    let (h, _sub) = hub_and_sub();
    let (_d, s) = srv(with_cmds(h));
    let r = post_cmd(&s, r#"{"action":"focus","args":{"location":"1.1.1"}}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    assert_eq!(post_cmd(&s, r#"{"action":"hack"}"#).await.status, 400);
    assert_eq!(post_cmd(&s, "{bad").await.status, 400);
    assert_eq!(get(&s, "/api/commands").await.status, 405);
}

#[tokio::test]
async fn creating_returns_new_ids() {
    let fb = Arc::new(FakeBroker {
        await_delivered: 1,
        await_result: CmdResult {
            new_panes: Some(vec!["r10".into()]),
            new_tabs: Some(vec![TabRef {
                uuid: "t10".into(),
                tool_id: "410".into(),
            }]),
            ..CmdResult::default()
        },
        ..FakeBroker::default()
    });
    let (_d, s) = srv(with_cmds(fb));
    let v = post_cmd(&s, r#"{"action":"splitH"}"#).await.json();
    assert_eq!(
        (v["ok"].as_bool(), v["action"].as_str()),
        (Some(true), Some("splitH"))
    );
    assert_eq!(
        v["newTabs"],
        serde_json::json!([{"uuid":"t10","toolId":"410"}])
    );
    assert_eq!(v["newPanes"], serde_json::json!(["r10"]));
}

#[tokio::test]
async fn non_creating_unchanged() {
    let fb = Arc::new(FakeBroker::default());
    let (_d, s) = srv(with_cmds(fb.clone()));
    let v = post_cmd(&s, r#"{"action":"tabNext"}"#).await.json();
    assert!(
        v.get("newTabs").is_none() && v.get("timedOut").is_none(),
        "{v}"
    );
    assert!(v["ok"] == true && v.get("delivered").is_some());
    assert_eq!(fb.published().len(), 1);
}

#[tokio::test]
async fn move_returns_position_or_error_and_group_id() {
    let fb = Arc::new(FakeBroker {
        await_delivered: 1,
        await_result: CmdResult {
            position: Some(CmdPosition {
                container: "top".into(),
                index: 2,
                count: 3,
            }),
            ..CmdResult::default()
        },
        ..FakeBroker::default()
    });
    let (_d, s) = srv(with_cmds(fb));
    let v = post_cmd(&s, r#"{"action":"moveWindow","args":{"index":2}}"#)
        .await
        .json();
    assert_eq!(
        v["position"],
        serde_json::json!({"container":"top","index":2,"count":3})
    );
    assert!(v.get("error").is_none());

    let fb = Arc::new(FakeBroker {
        await_delivered: 1,
        await_result: CmdResult {
            error: "out_of_range".into(),
            ..CmdResult::default()
        },
        ..FakeBroker::default()
    });
    let (_d, s) = srv(with_cmds(fb));
    let v = post_cmd(&s, r#"{"action":"moveTab","args":{"index":9}}"#)
        .await
        .json();
    assert_eq!(v["error"], "out_of_range");

    let fb = Arc::new(FakeBroker {
        await_delivered: 1,
        await_result: CmdResult {
            new_groups: Some(vec!["g1".into()]),
            ..CmdResult::default()
        },
        ..FakeBroker::default()
    });
    let (_d, s) = srv(with_cmds(fb));
    let v = post_cmd(&s, r#"{"action":"newGroup","args":{"name":"G"}}"#)
        .await
        .json();
    assert_eq!(v["newGroups"], serde_json::json!(["g1"]));
}

// ── 위치 uuid ──

const UUID: &str = "550e8400-e29b-41d4-a716-446655440003";

fn work_with(map: &[(&str, &str)]) -> Arc<FakeWork> {
    Arc::new(FakeWork {
        coord_map: map
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        ..FakeWork::default()
    })
}

fn deps_cw(c: Arc<dyn CommandBroker>, w: Arc<FakeWork>) -> Deps {
    Deps {
        commands: Some(c),
        work: Some(w),
        ..Deps::default()
    }
}

#[tokio::test]
async fn translates_uuid_location_and_exposes_it() {
    let (h, sub) = hub_and_sub();
    let (_d, s) = srv(deps_cw(h, work_with(&[(UUID, "W2.P1.T1")])));
    let r = post_cmd(
        &s,
        &format!(r#"{{"action":"focus","args":{{"location":"{UUID}"}}}}"#),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let p = next_payload(&sub).expect("방송이 없다");
    assert_eq!(p["args"]["location"], "W2.P1.T1");
    let v = r.json();
    assert!(v["ok"] == true && v["delivered"].is_number() && v["action"] == "focus");
    assert_eq!(
        (v["location"].as_str(), v["requestedLocation"].as_str()),
        (Some("W2.P1.T1"), Some(UUID))
    );
}

#[tokio::test]
async fn coordinate_or_unknown_location_is_rejected() {
    let (h, sub) = hub_and_sub();
    let w = Arc::new(FakeWork {
        coord_err: HashMap::from([(
            "ffffffff-ffff-7fff-bfff-ffffffffffff".to_owned(),
            "unknown uuid".to_owned(),
        )]),
        ..FakeWork::default()
    });
    let (_d, s) = srv(deps_cw(h, w));
    for loc in [
        "W4.P1.T1",
        "4.1.1",
        "303",
        "ffffffff-ffff-7fff-bfff-ffffffffffff",
    ] {
        let r = post_cmd(
            &s,
            &format!(r#"{{"action":"focus","args":{{"location":"{loc}"}}}}"#),
        )
        .await;
        assert_eq!(r.status, 400, "{loc}: {}", r.body);
    }
    assert!(next_payload(&sub).is_none(), "거절한 입력을 방송했다");
}

#[tokio::test]
async fn no_location_is_empty_strings() {
    let (h, _sub) = hub_and_sub();
    let (_d, s) = srv(deps_cw(h, work_with(&[])));
    let v = post_cmd(&s, r#"{"action":"newWindow","args":{}}"#)
        .await
        .json();
    assert_eq!(
        (v["location"].as_str(), v["requestedLocation"].as_str()),
        (Some(""), Some(""))
    );
    assert_eq!(v["action"], "newWindow");
}

#[tokio::test]
async fn rename_keeps_uuid_in_broadcast() {
    let uuid = "550e8400-e29b-41d4-a716-4466554400d1";
    for act in ["renameTab", "renameWindow"] {
        let (h, sub) = hub_and_sub();
        let (_d, s) = srv(deps_cw(h, work_with(&[(uuid, "W16.P1.T6")])));
        let body =
            format!(r#"{{"action":"{act}","args":{{"location":"{uuid}","name":"ccr#32›91"}}}}"#);
        let r = post_cmd(&s, &body).await;
        assert_eq!(r.status, 200, "{act}");
        let v = r.json();
        assert_eq!(
            (v["location"].as_str(), v["requestedLocation"].as_str()),
            (Some("W16.P1.T6"), Some(uuid))
        );
        assert_eq!(next_payload(&sub).unwrap()["args"]["location"], uuid);
    }
    let (h, sub) = hub_and_sub();
    let (_d, s) = srv(deps_cw(h, work_with(&[])));
    let body = r#"{"action":"renameTab","args":{"location":"550e8400-e29b-41d4-a716-4466554400d2","name":"x"}}"#;
    assert_eq!(post_cmd(&s, body).await.status, 400);
    assert!(next_payload(&sub).is_none());
}

// ── 이름 길이 ──

#[test]
fn entity_name_answer_table() {
    let cases = [
        ("a".repeat(ENTITY_NAME_MAX), true),
        ("a".repeat(ENTITY_NAME_MAX + 1), false),
        ("가".repeat(ENTITY_NAME_MAX), true),
        ("😀".repeat(ENTITY_NAME_MAX / 2), true),
        ("😀".repeat(ENTITY_NAME_MAX / 2 + 1), false),
        (String::new(), true),
    ];
    for (name, ok) in cases {
        let a = entity_name_answer(&name);
        assert_eq!(a.ok, ok, "len={}", name.len());
        if !a.ok {
            assert_eq!(
                (a.why.as_str(), a.status),
                (apierr::CODE_NAME_TOO_LONG, 400)
            );
            assert_eq!(a.args.as_ref().unwrap()["max"], ENTITY_NAME_MAX);
            assert!(action::may_give(
                &action::catalog(),
                action::ENTITY_NAME,
                &a.why
            ));
        }
    }
}

#[tokio::test]
async fn command_post_rejects_long_name() {
    let (h, _sub) = hub_and_sub();
    let (_d, s) = srv(deps_cw(h, work_with(&[])));
    let long = "x".repeat(ENTITY_NAME_MAX + 1);
    for act in [
        "newWindow",
        "newTab",
        "renameTab",
        "renameWindow",
        "newGroup",
        "renameGroup",
        "openEditorTab",
    ] {
        let r = post_cmd(
            &s,
            &format!(r#"{{"action":"{act}","args":{{"name":"{long}"}}}}"#),
        )
        .await;
        assert_eq!(r.status, 400, "{act}");
        assert_eq!(
            r.header(otter_shared_httpresp::CODE_HEADER),
            apierr::CODE_NAME_TOO_LONG
        );
    }
    let ok = "x".repeat(ENTITY_NAME_MAX);
    let r = post_cmd(
        &s,
        &format!(r#"{{"action":"renameTab","args":{{"name":"{ok}"}}}}"#),
    )
    .await;
    assert_ne!(r.status, 400, "상한 길이의 이름이 거절됐다");
}

// ── 실행자 지명 ──

async fn exec_for(act: &str, attach: &[&str], claim: Option<&str>) -> Value {
    let fb = Arc::new(FakeBroker::default());
    let (_d, s) = srv(with_cmds(fb.clone()));
    for c in attach {
        s.focus.attach(c);
    }
    if let Some(c) = claim {
        s.focus.claim(c, "W1");
    }
    let r = post_cmd(
        &s,
        &format!(r#"{{"action":"{act}","args":{{"filePath":"/tmp/x","toolId":"1","name":"n"}}}}"#),
    )
    .await;
    assert_eq!(r.status, 200, "{act}: {}", r.body);
    serde_json::from_str(&fb.published().pop().unwrap()).unwrap()
}

#[tokio::test]
async fn names_executor_for_creating_and_view_moving_actions() {
    for act in [
        "newTab",
        "newWindow",
        "splitH",
        "splitV",
        "openEditorTab",
        "restoreTool",
    ] {
        assert_eq!(
            exec_for(act, &["cliA", "cliB"], Some("cliB")).await["execClientId"],
            "cliB",
            "{act}"
        );
    }
    for act in [
        "focus",
        "closeTab",
        "closeWindow",
        "detachTab",
        "windowNext",
        "windowPrev",
        "tabNext",
        "tabPrev",
        "paneUp",
        "paneDown",
        "paneLeft",
        "paneRight",
    ] {
        assert_eq!(
            exec_for(act, &["cliA"], Some("cliA")).await["execClientId"],
            "cliA",
            "{act}"
        );
    }
    for act in ["renameTab", "renameWindow"] {
        assert!(
            exec_for(act, &["cliA"], Some("cliA"))
                .await
                .get("execClientId")
                .is_none(),
            "{act}"
        );
    }
    assert!(
        exec_for("newTab", &[], None)
            .await
            .get("execClientId")
            .is_none()
    );
}

// ── openUrl ──

async fn open_url(attach: Option<&str>, url: &str) -> (u16, Value, Vec<String>) {
    let fb = Arc::new(FakeBroker::default());
    let (_d, s) = srv(with_cmds(fb.clone()));
    if let Some(addr) = attach {
        s.focus.attach_from("cliA", addr);
        s.focus.claim("cliA", "W1");
    }
    let body = serde_json::json!({"action":"openUrl","args":{"url":url}}).to_string();
    let r = post_cmd(&s, &body).await;
    (r.status, r.json(), fb.published())
}

#[tokio::test]
async fn open_url_where() {
    let (code, v, pubs) = open_url(Some("100.64.0.5:40000"), "https://example.com/x").await;
    assert_eq!((code, v["where"].as_str()), (200, Some("remote")));
    let p: Value = serde_json::from_str(&pubs[0]).unwrap();
    assert_eq!(
        (p["execClientId"].as_str(), p["args"]["url"].as_str()),
        (Some("cliA"), Some("https://example.com/x"))
    );

    let (_, v, pubs) = open_url(Some("127.0.0.1:40001"), "http://localhost:3000").await;
    assert_eq!(
        (v["where"].as_str(), v["delivered"].as_i64()),
        (Some("local"), Some(0))
    );
    assert!(pubs.is_empty(), "로컬 경로는 방송하지 않는다");
    assert_eq!(
        open_url(Some("[::1]:40002"), "https://x.dev").await.1["where"],
        "local"
    );
    assert_eq!(open_url(None, "https://x.dev").await.1["where"], "local");
    assert_eq!(
        open_url(Some(""), "https://x.dev").await.1["where"],
        "remote"
    );
}

#[tokio::test]
async fn open_url_rejects_non_http() {
    for u in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,<script>1</script>",
        "ftp://example.com",
        "not a url",
        "",
    ] {
        assert_eq!(open_url(Some("100.64.0.5:40003"), u).await.0, 400, "{u:?}");
    }
}

#[tokio::test]
async fn open_url_where_diagnostic() {
    let fb = Arc::new(FakeBroker::default());
    let (_d, s) = srv(with_cmds(fb.clone()));
    let v = get(&s, "/api/open-url/where").await.json();
    assert_eq!(
        (v["where"].as_str(), v["subscribers"].as_i64()),
        (Some("local"), Some(0))
    );
    s.focus.attach_from("cliA", "100.64.0.5:41000");
    s.focus.claim("cliA", "W1");
    let r = get(&s, "/api/open-url/where").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body.trim(),
        r#"{"forced":"","loopback":false,"subscribers":1,"viewer":"cliA","viewerAddr":"100.64.0.5:41000","where":"remote"}"#
    );
    assert!(fb.published().is_empty(), "진단이 방송을 냈다");
    assert_eq!(post_json(&s, "/api/open-url/where", "").await.status, 405);
}

// ── focus ──

#[tokio::test]
async fn focus_claim_rejects_bad_body() {
    let (_d, s) = srv(Deps::default());
    for body in ["{bad", "{}", r#"{"clientId":"a"}"#, r#"{"windowId":"W1"}"#] {
        assert_eq!(
            post_json(&s, "/api/focus/claim", body).await.status,
            400,
            "{body}"
        );
    }
}
