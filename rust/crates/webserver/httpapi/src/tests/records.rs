//! 기록 거울·데몬 보고·migration 판정·snapshot·배경 (Go `agent_records_test.go`·
//! `report_apply_test.go`·`handlers_migration_advice_test.go`·`handlers_snapshot_test.go`·
//! `batch6_test.go` 의 배경 방송).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use dm_gocompat::json::RawMessage;
use dm_shared_toolhub::{ActivityState, AgentState};
use dm_shared_toolipc::{RecordsResult, ToolRecords};
use time::OffsetDateTime;

use super::attnenv::*;
use super::fakes::FakeSettings;
use super::support::*;
use crate::usage::{ToolUsage, lock, unix_milli};
use crate::{Deps, MigrationConf, RecordSink, parse_migration_conf};

#[derive(Default)]
struct FakeRecordSink {
    got: Mutex<HashMap<String, String>>,
}

impl RecordSink for FakeRecordSink {
    fn put(&self, kind: &str, tool: &str, v: Option<Vec<u8>>) {
        let raw = v.map_or("null".to_owned(), |b| String::from_utf8(b).unwrap());
        self.got
            .lock()
            .unwrap()
            .insert(format!("{kind}/{tool}"), raw);
    }
}

impl FakeRecordSink {
    fn value(&self, key: &str) -> Option<String> {
        self.got.lock().unwrap().get(key).cloned()
    }
}

fn sink_env() -> (Env, Arc<FakeRecordSink>) {
    let sink = Arc::new(FakeRecordSink::default());
    let s = sink.clone();
    let env = tracked_with(&["p1", "t1"], move |d| d.records = Some(s));
    (env, sink)
}

async fn activity_set(env: &Env, body: serde_json::Value) {
    post(&env.srv, "/api/tools/activity/set", &body.to_string()).await;
}

#[tokio::test]
async fn records_writes_go_to_daemon() {
    let (env, sink) = sink_env();
    env.tr.set_activity("p1", "working", "Edit", "app.js");
    post(
        &env.srv,
        "/api/tools/usage",
        r#"{"toolId":"p1","usage":{"effort":"high","rateLimits":{"five_hour":{"usedPct":34}}}}"#,
    )
    .await;
    post(
        &env.srv,
        "/api/tools/subagents",
        r#"{"toolId":"p1","tasks":[{"id":"a1","status":"running"}]}"#,
    )
    .await;
    activity_set(&env, serde_json::json!({"toolId":"p1","agentId":"a1","agentType":"Explore","state":"working","tool":"Read"})).await;
    for (key, want) in [
        ("usage/p1", r#""effort":"high""#),
        ("limits/", r#""five_hour""#),
        ("subagents/p1", r#""id":"a1""#),
        ("subagentActs/p1", r#""agentType":"Explore""#),
    ] {
        let v = sink.value(key).unwrap_or_default();
        assert!(v.contains(want), "{key}={v}, {want} 를 기대");
    }
    activity_set(&env, serde_json::json!({"toolId":"p1","state":"ended"})).await;
    assert_eq!(sink.value("subagentActs/p1").as_deref(), Some("null"));
}

// FR-ITM-13: 「모른다」 의 안내 표시도 데몬에 쓴다.
#[tokio::test]
async fn records_migration_told_goes_to_daemon() {
    let sink = Arc::new(FakeRecordSink::default());
    let s = sink.clone();
    let st = Arc::new(FakeSettings {
        blob: Mutex::new(br#"{"migrationHook":true}"#.to_vec()),
    });
    let env = tracked_with(&["p1"], move |d| {
        d.records = Some(s);
        d.settings = Some(st);
    });
    get(&env.srv, "/api/tools/migration-advice?id=p9").await;
    assert_eq!(sink.value("migrationTold/p9").as_deref(), Some("true"));
}

#[tokio::test]
async fn records_no_sink_still_mirrors() {
    let env = tracked(&["p1"]);
    post(
        &env.srv,
        "/api/tools/usage",
        r#"{"toolId":"p1","usage":{"effort":"high"}}"#,
    )
    .await;
    let u = env.srv.agents.usage.get("p1").unwrap();
    assert_eq!(u.usage.effort.as_deref(), Some("high"));
}

#[tokio::test]
async fn records_apply_snapshot_replaces_mirror() {
    let env = tracked_with(&[], |d| d.tools = None);
    let s = &env.srv;
    s.agents.usage.put("old", ToolUsage::default());
    s.agents
        .subagents
        .put("old", None, OffsetDateTime::now_utc());
    lock(&s.agents.migration_unknown_told).insert("old".into());
    env.tr.set_activity("old", "working", "", "");
    let before = env.cmds.published().len();

    let now = OffsetDateTime::now_utc();
    let ms = unix_milli(now);
    let sub_act = format!(
        r#"{{"a1":{{"agentType":"Explore","state":"working","updatedAt":{}}}}}"#,
        serde_json::to_string(&dm_gocompat::time::format_rfc3339_nano(now)).unwrap()
    );
    let raw = |s: &str| RawMessage(s.as_bytes().to_vec());
    let res = RecordsResult {
        global: BTreeMap::from([(
            "limits".to_owned(),
            raw(&format!(
                r#"{{"claude":{{"windows":{{"five_hour":{{"usedPct":12}}}},"observedAt":{ms}}}}}"#
            )),
        )]),
        tools: Some(vec![ToolRecords {
            tool: "t1".into(),
            agent: AgentState {
                activity: Some(ActivityState {
                    state: "waiting".into(),
                    ..ActivityState::default()
                }),
                agent_seen: true,
                attention: true,
                ..AgentState::default()
            },
            records: BTreeMap::from([
                (
                    "usage".to_owned(),
                    raw(r#"{"effort":"low","observedAt":5}"#),
                ),
                (
                    "subagents".to_owned(),
                    raw(&format!(r#"{{"tasks":[{{"id":"a1"}}],"observedAt":{ms}}}"#)),
                ),
                ("subagentActs".to_owned(), raw(&sub_act)),
                ("migrationTold".to_owned(), raw("true")),
            ]),
        }]),
    };
    s.apply_records(&res);

    assert!(s.agents.usage.get("old").is_none());
    let u = s.agents.usage.get("t1").unwrap();
    assert_eq!((u.usage.effort.as_deref(), u.observed_at), (Some("low"), 5));
    assert_eq!(s.agents.subagents.get("t1", now).unwrap().len(), 1);
    assert_eq!(
        s.agents.sub_acts.list("t1", now)["a1"].agent_type,
        "Explore"
    );
    let told = lock(&s.agents.migration_unknown_told).clone();
    assert!(!told.contains("old") && told.contains("t1"));
    let v = serde_json::to_value(s.agents.rate_limits.view(now)).unwrap();
    assert_eq!(v[0]["windows"][0]["name"], "five_hour");
    assert!(env.tr.attention("t1") && env.tr.activity("old").is_none());
    for p in &env.cmds.published()[before..] {
        assert!(
            !p.contains(r#""action":"tool_attention""#),
            "스냅샷 반영이 알람을 방송했다: {p}"
        );
    }
}

// ── 데몬 보고 (§3.2a) ──

#[tokio::test]
async fn apply_report_activity_done_raises_alarm() {
    let env = tracked(&["t1"]);
    let before = env.cmds.published().len();
    env.srv.apply_report(
        "report.activity",
        br#"{"toolId":"t1","agent":"claude","state":"working","tool":"Bash"}"#,
    );
    env.srv.apply_report(
        "report.activity",
        br#"{"toolId":"t1","agent":"claude","state":"done"}"#,
    );
    assert_eq!(env.tr.activity("t1").unwrap().state, "done");
    assert!(env.tr.attention("t1"));
    assert!(
        env.cmds.published()[before..]
            .iter()
            .any(|p| p.contains(r#""action":"tool_attention""#))
    );
}

#[tokio::test]
async fn apply_report_subagent_and_records() {
    let (env, sink) = sink_env();
    env.srv.apply_report(
        "report.activity",
        br#"{"toolId":"t1","agentId":"a1","agentType":"Explore","state":"working"}"#,
    );
    env.srv.apply_report(
        "report.usage",
        br#"{"toolId":"t1","usage":{"effort":"high"}}"#,
    );
    env.srv.apply_report(
        "report.subagents",
        br#"{"toolId":"t1","tasks":[{"id":"a1"}]}"#,
    );
    let now = OffsetDateTime::now_utc();
    assert_eq!(
        env.srv.agents.sub_acts.list("t1", now)["a1"].agent_type,
        "Explore"
    );
    let u = env.srv.agents.usage.get("t1").unwrap();
    assert!(u.usage.effort.as_deref() == Some("high") && u.observed_at != 0);
    assert_eq!(env.srv.agents.subagents.get("t1", now).unwrap().len(), 1);
    for key in ["usage/t1", "subagents/t1", "subagentActs/t1"] {
        assert!(sink.value(key).is_some(), "{key} 를 데몬에 되쓰지 않았다");
    }
}

#[tokio::test]
async fn apply_report_notify() {
    let env = tracked(&["t1"]);
    env.srv
        .apply_report("report.notify", br#"{"toolId":"t1","reason":"permission"}"#);
    assert!(env.tr.attention("t1"));
}

#[tokio::test]
async fn apply_report_ignores_bad() {
    let env = tracked(&["t1"]);
    env.srv.apply_report("write", br#"{"toolId":"t1"}"#);
    env.srv.apply_report("report.activity", b"[1]");
    env.srv
        .apply_report("report.activity", br#"{"toolId":"t1","state":"nap"}"#);
    env.srv
        .apply_report("report.usage", br#"{"usage":{"effort":"x"}}"#);
    assert!(env.tr.activity("t1").is_none());
    assert!(env.srv.agents.usage.get("").is_none());
}

// ── migration (ISSUE_TREE_OPS_SRS 묶음 M) ──

#[test]
fn migration_settings_defaults_and_clamp() {
    let c = |hook_on, hook_pct, tree_on, tree_pct| MigrationConf {
        hook_on,
        hook_pct,
        tree_on,
        tree_pct,
    };
    for (blob, want) in [
        ("", c(false, 50, true, 50)),
        (
            r#"{"migrationHook":true,"migrationHookCtxPct":70}"#,
            c(true, 70, true, 50),
        ),
        (
            r#"{"issueTreeMigration":false,"issueTreeCtxPct":30}"#,
            c(false, 50, false, 30),
        ),
        (
            r#"{"migrationHookCtxPct":0,"issueTreeCtxPct":101}"#,
            c(false, 50, true, 50),
        ),
        (
            r#"{"migrationHookCtxPct":"x","migrationHook":"y"}"#,
            c(false, 50, true, 50),
        ),
        ("not json", c(false, 50, true, 50)),
    ] {
        assert_eq!(parse_migration_conf(blob.as_bytes()), want, "{blob}");
    }
}

/// Go `TestMigrationAdvice_Verdicts` 중 Run 이 없는 부분 (트리 멤버의 skip 은 5.5.4 가 옮긴다).
#[tokio::test]
async fn migration_advice_verdicts() {
    let st = Arc::new(FakeSettings::default());
    let s2 = st.clone();
    let env = tracked_with(&["tool-b"], move |d| d.settings = Some(s2));
    let set = |b: &str| *st.blob.lock().unwrap() = b.as_bytes().to_vec();
    let report = |pct: i64| {
        let srv = env.srv.clone();
        async move {
            let body =
                format!(r#"{{"toolId":"tool-b","usage":{{"contextWindow":{{"usedPct":{pct}}}}}}}"#);
            assert_eq!(post(&srv, "/api/tools/usage", &body).await.status, 200);
        }
    };
    let ask = |id: &'static str| {
        let srv = env.srv.clone();
        async move {
            let r = get(&srv, &format!("/api/tools/migration-advice?id={id}")).await;
            assert_eq!(r.status, 200);
            r.json()
        }
    };
    report(57).await;
    assert_eq!(ask("tool-b").await["verdict"], "skip", "기본 끔");
    set(r#"{"migrationHook":true}"#);
    let out = ask("tool-b").await;
    assert_eq!(
        out,
        serde_json::json!({"capPct":85,"ctxPct":50,"judgePct":40,"usedPct":57,"verdict":"advise"})
    );
    set(r#"{"migrationHook":true,"migrationHookCtxPct":60}"#);
    let out = ask("tool-b").await;
    assert_eq!(
        (out["verdict"].clone(), out["judgePct"].clone()),
        ("advise".into(), 48.into())
    );
    set(r#"{"migrationHook":true,"migrationHookCtxPct":75}"#);
    assert_eq!(ask("tool-b").await["verdict"], "ok");
    set(r#"{"migrationHook":true}"#);
    report(40).await;
    assert_eq!(ask("tool-b").await["verdict"], "advise");
    report(39).await;
    assert_eq!(ask("tool-b").await["verdict"], "ok");
    report(85).await;
    assert_eq!(ask("tool-b").await["verdict"], "must");
    set(r#"{"migrationHook":true,"migrationHookCtxPct":95}"#);
    assert_eq!(ask("tool-b").await["verdict"], "must");
    report(57).await;
    set(r#"{"migrationHook":false}"#);
    assert_eq!(ask("tool-b").await["verdict"], "skip");
    set(r#"{"migrationHook":true}"#);
    assert_eq!(ask("tool-z").await["verdict"], "unknown");
    assert_eq!(
        ask("tool-z").await["verdict"],
        "ok",
        "두 번째 unknown 은 조용해야 한다"
    );
}

// ── snapshot (FR-OPT-4-5) ──

#[tokio::test]
async fn snapshot_parts_are_endpoint_bodies() {
    let env = tracked(&["p1"]);
    env.tr.set_activity("p1", "working", "Edit", "<a&b>");
    env.tr.signal_attention("p1", "bell");
    let r = get(
        &env.srv,
        "/api/snapshot?parts=attention,activity,background,focus,update,bogus,attention",
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("Content-Type"), "application/json");
    let got: BTreeMap<String, serde_json::Value> = serde_json::from_str(&r.body).unwrap();
    for (part, path) in [
        ("attention", "/api/tools/attention"),
        ("activity", "/api/tools/activity"),
        ("background", "/api/tools/background"),
        ("focus", "/api/focus"),
    ] {
        let b = get(&env.srv, path).await;
        assert_eq!(b.status, 200);
        assert_eq!(got[part], b.json(), "{part}");
        let compact =
            String::from_utf8(dm_gocompat::json::compact(b.body.as_bytes()).unwrap()).unwrap();
        assert!(
            r.body.contains(&compact),
            "{part}: {compact} 가 그대로 실리지 않았다"
        );
    }
    assert_eq!(got.len(), 4, "{}", r.body);
}

#[tokio::test]
async fn snapshot_no_parts_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let s = server(dir.path(), Deps::default());
    let r = get(&s, "/api/snapshot").await;
    assert_eq!((r.status, r.body.as_str()), (200, "{}\n"));
}

// ── 배경 (FR-BG·FR-BGP-2) ──

#[tokio::test]
async fn background_set_broadcasts_and_unknown_is_404() {
    let env = tracked(&["tool-a"]);
    for bg in [true, false] {
        let before = env.cmds.published().len();
        let body = format!(r#"{{"toolId":"tool-a","background":{bg}}}"#);
        let r = post(&env.srv, "/api/tools/background/set", &body).await;
        assert_eq!((r.status, r.body.as_str()), (200, "{\"ok\":true}\n"));
        assert_eq!(
            env.cmds.published()[before..],
            [r#"{"action":"tools_background_changed","args":null}"#]
        );
    }
    let r = post(
        &env.srv,
        "/api/tools/background/set",
        r#"{"toolId":"nope","background":true}"#,
    )
    .await;
    assert_eq!(
        (r.status, r.body.as_str()),
        (404, "toolId=nope 존재하지 않음\n")
    );
    let r = get(&env.srv, "/api/tools/background").await;
    assert_eq!(r.body, "{\"background\":[]}\n");
}
