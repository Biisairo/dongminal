//! 서브에이전트 활동과 계정 한도 (Go `handlers_subagent_activity_test.go`).

use std::collections::HashSet;
use std::time::Duration;

use otter_shared_agentrec::{SUBAGENT_DONE_KEEP, SUBAGENT_STALE_KEEP, SubagentActivity};
use otter_shared_statusline::SUBAGENT_MAX_TASKS;
use time::OffsetDateTime;

use super::attnenv::*;
use super::support::get;
use crate::subagents::SubagentActivityStore;

fn now() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

fn act(state: &str) -> SubagentActivity {
    SubagentActivity {
        state: state.into(),
        ..SubagentActivity::default()
    }
}

async fn activity_set(env: &Env, body: serde_json::Value) -> u16 {
    post(&env.srv, "/api/tools/activity/set", &body.to_string())
        .await
        .status
}

/// Go `replayHook`: claude 훅 하나를 해석해 main·서브에이전트 보고로 보낸다.
async fn replay_hook(env: &Env, tool_id: &str, payload: &str) {
    let a = otter_shared_agentadapter::get("claude").unwrap();
    let Some(rep) = (a.hook_parse)(payload.as_bytes()) else {
        return;
    };
    if !rep.state.is_empty() {
        let body = serde_json::json!({"toolId": tool_id, "agent": "claude", "state": rep.state,
            "tool": rep.tool, "detail": rep.detail});
        assert_eq!(activity_set(env, body).await, 200, "{payload}");
    }
    if let Some(sub) = rep.sub {
        let body = serde_json::json!({"toolId": tool_id, "agent": "claude", "agentId": sub.agent_id,
            "agentType": sub.agent_type, "state": sub.state, "tool": sub.tool, "detail": sub.detail});
        assert_eq!(activity_set(env, body).await, 200, "{payload}");
    }
}

fn p1() -> Env {
    tracked(&["p1"])
}

#[tokio::test]
async fn observed_sequence_ends_done() {
    let env = p1();
    let sub = r#""agent_id":"a922","agent_type":"Explore""#;
    let seq = [
        r#"{"hook_event_name":"UserPromptSubmit","prompt":"find parseClaudeHook"}"#.to_owned(),
        r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{}}"#.to_owned(),
        format!(r#"{{"hook_event_name":"SubagentStart",{sub}}}"#),
        r#"{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_input":{}}"#.to_owned(),
        r#"{"hook_event_name":"Stop","background_tasks":[{"id":"a922","status":"running"}]}"#.to_owned(),
        r#"{"hook_event_name":"SubagentStop","agent_id":"a5b4","agent_type":""}"#.to_owned(),
        format!(
            r#"{{"hook_event_name":"PreToolUse",{sub},"tool_name":"Bash","tool_input":{{"command":"grep -rn parse"}}}}"#
        ),
        format!(
            r#"{{"hook_event_name":"PostToolUse",{sub},"tool_name":"Bash","tool_input":{{"command":"grep -rn parse"}}}}"#
        ),
        r#"{"hook_event_name":"UserPromptSubmit","prompt":"<agent-message from=\"a922\">\nreport"}"#.to_owned(),
        format!(r#"{{"hook_event_name":"SubagentStop",{sub}}}"#),
        r#"{"hook_event_name":"Stop","background_tasks":[]}"#.to_owned(),
        r#"{"hook_event_name":"SubagentStop","agent_id":"aa98","agent_type":""}"#.to_owned(),
        r#"{"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"}"#.to_owned(),
    ];
    for p in &seq {
        replay_hook(&env, "p1", p).await;
    }
    assert_eq!(env.tr.activity("p1").unwrap().state, "done");
    let acts = env.srv.agents.sub_acts.list("p1", now());
    assert_eq!(
        (
            acts["a922"].state.as_str(),
            acts["a922"].agent_type.as_str()
        ),
        ("done", "Explore")
    );
    assert_eq!(
        acts.len(),
        1,
        "내부 에이전트가 서브에이전트 활동에 들어갔다"
    );
}

#[tokio::test]
async fn subagent_activity_does_not_touch_main() {
    let env = p1();
    env.tr.set_activity("p1", "done", "", "");
    let body = serde_json::json!({"toolId":"p1","agentId":"a1","agentType":"Plan","state":"working",
        "tool":"Read","detail":"/a\u{7}.go"});
    assert_eq!(activity_set(&env, body).await, 200);
    assert_eq!(env.tr.activity("p1").unwrap().state, "done");
    let got = &env.srv.agents.sub_acts.list("p1", now())["a1"];
    assert_eq!((got.detail.as_str(), got.tool.as_str()), ("/a.go", "Read"));
    for st in ["idle", "ended", "bogus"] {
        let body = serde_json::json!({"toolId":"p1","agentId":"a1","state":st});
        assert_eq!(activity_set(&env, body).await, 400, "{st}");
    }
}

#[test]
fn store_lifetime() {
    let st = SubagentActivityStore::default();
    let t0 = OffsetDateTime::from_unix_timestamp(1000).unwrap();
    for i in 0..=SUBAGENT_MAX_TASKS {
        st.put(
            "p1",
            &format!("a{i:02}"),
            act("working"),
            t0 + Duration::from_secs(i as u64),
        );
    }
    let got = st.list("p1", t0 + Duration::from_secs(60));
    assert_eq!(got.len(), SUBAGENT_MAX_TASKS);
    assert!(!got.contains_key("a00"));

    let st2 = SubagentActivityStore::default();
    st2.put("p1", "d", act("done"), t0);
    assert!(
        st2.list("p1", t0 + SUBAGENT_DONE_KEEP - Duration::from_secs(1))
            .contains_key("d")
    );
    assert!(
        !st2.list("p1", t0 + SUBAGENT_DONE_KEEP + Duration::from_secs(1))
            .contains_key("d")
    );
    st2.put("p1", "w", act("working"), t0);
    st2.drop_tool("p1");
    assert!(st2.list("p1", t0).is_empty());
    st2.put("live", "x", act("working"), t0);
    st2.put("dead", "x", act("working"), t0);
    assert_eq!(st2.prune(|id| id == "live"), 1);
}

#[tokio::test]
async fn main_ended_drops() {
    let env = p1();
    activity_set(
        &env,
        serde_json::json!({"toolId":"p1","agentId":"a1","state":"working"}),
    )
    .await;
    activity_set(&env, serde_json::json!({"toolId":"p1","state":"ended"})).await;
    assert!(env.srv.agents.sub_acts.list("p1", now()).is_empty());
}

#[tokio::test]
async fn subagent_activity_broadcasts() {
    let env = p1();
    let before = env.cmds.published().len();
    let body = serde_json::json!({"toolId":"p1","agentId":"a1","agentType":"Plan","state":"working",
        "tool":"Read","detail":"x"});
    activity_set(&env, body).await;
    let got = &env.cmds.published()[before..];
    assert_eq!(
        got,
        [
            r#"{"action":"tool_subagent_activity","args":{"agentId":"a1","agentType":"Plan","detail":"x","state":"working","tool":"Read","toolId":"p1"}}"#
        ]
    );
}

#[tokio::test]
async fn activity_merges_subagent_activity() {
    let env = p1();
    env.tr.set_activity("p1", "working", "Edit", "app.js");
    post(
        &env.srv,
        "/api/tools/subagents",
        r#"{"toolId":"p1","tasks":[
{"id":"run","agentType":"Explore","status":"running","startTime":1000,"description":"Find\u0007 the file"},
{"id":"fin","agentType":"Plan","status":"completed","startTime":2000},
{"id":"act","agentType":"Explore","status":"running","startTime":3000}]}"#,
    )
    .await;
    activity_set(&env, serde_json::json!({"toolId":"p1","agentId":"act","agentType":"Explore","state":"waiting","tool":"Bash","detail":"rm"})).await;
    activity_set(&env, serde_json::json!({"toolId":"p1","agentId":"hookonly","agentType":"general-purpose","state":"working","tool":"Read"})).await;
    let a = get(&env.srv, "/api/tools/activity").await.json();
    let got = a["activities"][0]["subagents"].as_array().unwrap().clone();
    let ids: Vec<_> = got.iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["run", "fin", "act", "hookonly"]);
    assert_eq!(
        (&got[0]["state"], &got[0]["description"]),
        (&"working".into(), &"Find the file".into())
    );
    assert_eq!(got[1]["state"], "done");
    assert_eq!(
        (&got[2]["state"], &got[2]["tool"], &got[2]["detail"]),
        (&"waiting".into(), &"Bash".into(), &"rm".into())
    );
    assert_eq!(
        (&got[3]["agentType"], &got[3]["state"]),
        (&"general-purpose".into(), &"working".into())
    );
}

#[tokio::test]
async fn rate_limits_view_and_survives_prune() {
    let env = p1();
    assert!(env.srv.agents.rate_limits.view(now()).is_empty());
    let r = post(
        &env.srv,
        "/api/tools/usage",
        r#"{"toolId":"p1","usage":{"rateLimits":{
"seven_day":{"usedPct":21,"resetsAt":1794659091},
"zeta":{"usedPct":90},
"five_hour":{"usedPct":70,"resetsAt":1794298291000},
"alpha":{"usedPct":69.9}}}}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    env.srv.agents.usage.prune(|_| false);
    let v = env
        .srv
        .agents
        .rate_limits
        .view(OffsetDateTime::from_unix_timestamp(1794291091).unwrap());
    let blob = serde_json::to_value(&v).unwrap();
    assert_eq!(v.len(), 1);
    assert_eq!(blob[0]["agent"], "claude");
    assert!(blob[0]["observedAt"].as_i64().unwrap() > 0);
    let w = &blob[0]["windows"];
    let names: Vec<_> = w
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["five_hour", "seven_day", "alpha", "zeta"]);
    assert_eq!(
        (w[0]["resetsAt"].as_f64(), w[0]["resetsInSec"].as_f64()),
        (Some(1794298291.0), Some(7200.0))
    );
    assert_eq!(w[1]["resetsInSec"].as_f64(), Some(368000.0));
    assert!(w[2].get("resetsInSec").is_none());
    let levels: Vec<_> = (0..4).map(|i| w[i]["level"].as_str().unwrap()).collect();
    assert_eq!(levels, ["warn", "", "", "critical"]);
    let late = env
        .srv
        .agents
        .rate_limits
        .view(OffsetDateTime::from_unix_timestamp(1794298291 + 60).unwrap());
    assert_eq!(
        serde_json::to_value(&late).unwrap()[0]["windows"][0]["resetsInSec"],
        0.0
    );
}

#[tokio::test]
async fn rate_limits_names_from_status_line_input() {
    let env = p1();
    let u = otter_shared_statusline::from_input(
        br#"{"rate_limits":{"seven_day_opus":{"used_percentage":5},
"seven_day":{"used_percentage":21},"five_hour":{"used_percentage":70}}}"#,
    );
    let usage = String::from_utf8(otter_gocompat::json::marshal(&u).unwrap()).unwrap();
    let body = format!(r#"{{"toolId":"p1","usage":{usage}}}"#);
    assert_eq!(post(&env.srv, "/api/tools/usage", &body).await.status, 200);
    let v = serde_json::to_value(env.srv.agents.rate_limits.view(now())).unwrap();
    let names: Vec<_> = v[0]["windows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["five_hour", "seven_day", "seven_day_opus"]);
}

#[test]
fn limit_level_boundaries() {
    for (pct, want) in [
        (69.0, ""),
        (70.0, "warn"),
        (89.0, "warn"),
        (90.0, "critical"),
        (100.0, "critical"),
    ] {
        assert_eq!(
            otter_webserver_domain_claudeacct::usage_level(pct),
            want,
            "{pct}"
        );
    }
}

#[tokio::test]
async fn api_responses_carry_limits() {
    let env = p1();
    env.tr.set_activity("p1", "working", "Edit", "app.js");
    assert!(
        get(&env.srv, "/api/tools/activity")
            .await
            .body
            .contains(r#""limits":[]"#)
    );
    post(
        &env.srv,
        "/api/tools/usage",
        r#"{"toolId":"p1","usage":{"rateLimits":{"five_hour":{"usedPct":34,"resetsAt":4102444800}}}}"#,
    )
    .await;
    let b = get(&env.srv, "/api/tools/activity").await.body;
    assert!(
        b.contains(r#""name":"five_hour""#) && b.contains(r#""resetsInSec":"#),
        "{b}"
    );
    let o = get(&env.srv, "/api/tools/activity/get?id=p1").await.json();
    assert_eq!(o["limits"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn handback_order_ends_done() {
    let sub = r#""agent_id":"a4d7","agent_type":"Explore""#;
    let head = [
        format!(r#"{{"hook_event_name":"SubagentStart",{sub}}}"#),
        format!(r#"{{"hook_event_name":"SubagentStop",{sub}}}"#),
        format!(
            r#"{{"hook_event_name":"PreToolUse",{sub},"tool_name":"SubagentHandback","tool_input":{{"message":"ONE"}}}}"#
        ),
    ];
    let post_ = format!(
        r#"{{"hook_event_name":"PostToolUse",{sub},"tool_name":"SubagentHandback","tool_input":{{"message":"ONE"}}}}"#
    );
    let stop = format!(r#"{{"hook_event_name":"SubagentStop",{sub}}}"#);
    for tail in [[post_.clone(), stop.clone()], [stop.clone(), post_.clone()]] {
        let env = p1();
        for p in head.iter().chain(tail.iter()) {
            replay_hook(&env, "p1", p).await;
        }
        assert_eq!(
            env.srv.agents.sub_acts.list("p1", now())["a4d7"].state,
            "done"
        );
    }
}

#[test]
fn store_drop_stale() {
    let t0 = OffsetDateTime::from_unix_timestamp(1000).unwrap();
    let late = t0 + SUBAGENT_STALE_KEEP + Duration::from_secs(1);
    let set = |ids: &[&str]| ids.iter().map(|s| (*s).to_owned()).collect::<HashSet<_>>();
    let cases = [
        ("working", late, false, set(&[]), true),
        ("waiting", late, false, set(&[]), true),
        (
            "working",
            t0 + SUBAGENT_STALE_KEEP - Duration::from_secs(1),
            false,
            set(&[]),
            false,
        ),
        ("working", late, true, set(&[]), false),
        ("working", late, false, set(&["a1"]), false),
        ("working", late, false, set(&["zz"]), true),
        (
            "done",
            t0 + SUBAGENT_DONE_KEEP - Duration::from_secs(1),
            false,
            set(&[]),
            false,
        ),
    ];
    for (i, (state, at, busy, running, gone)) in cases.into_iter().enumerate() {
        let st = SubagentActivityStore::default();
        st.put("p1", "a1", act(state), t0);
        st.drop_stale("p1", at, busy, &running);
        assert_eq!(st.list("p1", at).contains_key("a1"), !gone, "case {i}");
    }
}

#[tokio::test]
async fn activity_drops_stale_subagent() {
    for main in ["done", "working"] {
        let env = p1();
        env.tr.set_activity("p1", main, "", "");
        let old = SubagentActivity {
            agent_type: "web-fetch".into(),
            state: "working".into(),
            tool: "SubagentHandback".into(),
            ..SubagentActivity::default()
        };
        env.srv.agents.sub_acts.put(
            "p1",
            "old",
            old,
            now() - SUBAGENT_STALE_KEEP - Duration::from_secs(1),
        );
        let a = get(&env.srv, "/api/tools/activity").await.json();
        let subs = a["activities"][0].get("subagents").cloned();
        match main {
            "done" => assert!(subs.is_none(), "main 이 done 인데 남았다"),
            _ => assert_eq!(subs.unwrap().as_array().unwrap().len(), 1),
        }
    }
}
