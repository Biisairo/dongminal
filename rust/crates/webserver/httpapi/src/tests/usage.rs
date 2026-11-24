//! 사용량·서브에이전트·활동 카드 요약 (Go `handlers_usage_test.go`·`handlers_subagents_test.go`·
//! `activity_usage_test.go`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use otter_shared_statusline::{Model, Subagent, Usage};
use otter_webserver_domain_run::{ContextPolicy, LEVEL_CRITICAL, LEVEL_OK, LEVEL_WARN};
use time::OffsetDateTime;

use super::attnenv::*;
use super::fakes::FakeSettings;
use super::support::*;
use crate::subagents::SUBAGENT_STALE;
use crate::usage::{ToolContext, ToolUsage, UsageStore, card_usage_of};

const USAGE_BODY: &str = r#"{"toolId":"p1","usage":{"sessionId":"s1","version":"2.1.318",
"model":{"id":"claude-opus-5-5","displayName":"Opus 5.5"},"effort":"medium",
"cost":{"totalCostUsd":0.5},
"contextWindow":{"windowTokens":1000000,"usedPct":6,"remainingPct":94,
"currentUsage":{"inputTokens":6,"outputTokens":8,"cacheCreationInputTokens":62146,"cacheReadInputTokens":0}},
"rateLimits":{"five_hour":{"usedPct":12.5,"resetsAt":1793860000}},
"transcriptPath":"/Users/x/secret.jsonl"}}"#;

const SUBAGENTS_BODY: &str = r#"{"toolId":"p1","tasks":[
{"id":"late","agentType":"Plan","status":"completed","model":"claude-opus-5-5","effortBudget":8000,
 "windowTokens":200000,"tokens":180000,"startTime":2000},
{"id":"nost","status":"running"},
{"id":"early","agentType":"Explore","status":"running","model":"claude-haiku-5-5","effort":"low",
 "windowTokens":1000000,"tokens":19250,"startTime":1000,"description":"Find it","label":"secret"}]}"#;

fn p1_env() -> Env {
    tracked(&["p1"])
}

fn p1_env_settings(blob: &str) -> Env {
    let st = Arc::new(FakeSettings {
        blob: Mutex::new(blob.as_bytes().to_vec()),
        ..FakeSettings::default()
    });
    tracked_with(&["p1"], move |d| d.settings = Some(st))
}

/// Go `activityUsageServer`: 활동을 보고한 도구 하나.
fn activity_env(env: Env) -> Env {
    env.tr.set_activity("p1", "working", "Edit", "app.js");
    env
}

async fn activities(env: &Env) -> serde_json::Value {
    let o = get(&env.srv, "/api/tools/activity").await.json();
    let acts = o["activities"].clone();
    assert_eq!(acts.as_array().unwrap().len(), 1, "{acts}");
    acts[0].clone()
}

#[tokio::test]
async fn usage_status_carries_usage_and_context() {
    let env = p1_env();
    assert_eq!(
        post(&env.srv, "/api/tools/usage", USAGE_BODY).await.status,
        200
    );
    let r = get(&env.srv, "/api/tools/activity/get?id=p1").await;
    let o = r.json();
    let c = &o["context"];
    assert_eq!(
        (
            &c["usedPct"],
            &c["windowTokens"],
            &c["tokens"],
            &c["source"]
        ),
        (
            &6.into(),
            &1000000.into(),
            &62152.into(),
            &"statusline".into()
        ),
        "{c}"
    );
    assert!(c["observedAt"].as_i64().unwrap() > 0);
    assert_eq!(o["usage"]["effort"], "medium");
    assert!(!o["usage"]["rateLimits"]["five_hour"].is_null());
    assert!(
        !r.body.contains("secret.jsonl") && !r.body.contains("transcriptPath"),
        "FR-SLP-2a"
    );
}

#[tokio::test]
async fn usage_no_observation_no_keys() {
    let env = p1_env();
    let o = get(&env.srv, "/api/tools/activity/get?id=p1").await.json();
    assert!(o.get("usage").is_none() && o.get("context").is_none());
}

#[tokio::test]
async fn usage_rejects_missing_tool() {
    let env = p1_env();
    let r = post(
        &env.srv,
        "/api/tools/usage",
        r#"{"usage":{"sessionId":"x"}}"#,
    )
    .await;
    assert_eq!((r.status, r.body.as_str()), (400, "toolId required\n"));
}

#[test]
fn usage_store_prune() {
    let u = UsageStore::default();
    u.put("live", ToolUsage::default());
    u.put("dead", ToolUsage::default());
    assert_eq!(u.prune(|id| id == "live"), 1);
    assert!(u.get("live").is_some() && u.get("dead").is_none());
    assert_eq!(UsageStore::default().prune(|_| false), 0);
}

// FR-ASV-20: 한도는 statusLine 을 보고하는 에이전트의 것으로 남고, 상태·활동 응답에 실린다.
#[tokio::test]
async fn usage_rate_limits_are_kept_per_agent() {
    let env = p1_env();
    post(&env.srv, "/api/tools/usage", USAGE_BODY).await;
    let o = get(&env.srv, "/api/tools/activity/get?id=p1").await.json();
    let l = &o["limits"][0];
    assert_eq!(l["agent"], "claude");
    assert_eq!(l["windows"][0]["name"], "five_hour");
    assert_eq!(l["windows"][0]["usedPct"], 12.5);
    assert_eq!(l["windows"][0]["resetsAt"], 1793860000);
    assert!(l["windows"][0]["level"].is_string());
    let act = get(&env.srv, "/api/tools/activity").await.json();
    assert_eq!(act["limits"][0]["agent"], "claude");
}

// ── 서브에이전트 ──

async fn activity_subagents(env: &Env) -> Option<Vec<serde_json::Value>> {
    activities(env)
        .await
        .get("subagents")
        .map(|v| v.as_array().unwrap().clone())
}

#[tokio::test]
async fn activity_carries_subagents() {
    let env = activity_env(p1_env());
    assert_eq!(
        post(&env.srv, "/api/tools/subagents", SUBAGENTS_BODY)
            .await
            .status,
        200
    );
    let got = activity_subagents(&env).await.unwrap();
    let ids: Vec<_> = got.iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["early", "late", "nost"]);
    let e = &got[0];
    assert_eq!(
        e,
        &serde_json::json!({"id":"early","agentType":"Explore","status":"running","model":"claude-haiku-5-5",
            "effort":"low","tokens":19250,"windowTokens":1000000,"ctxPct":1.925,"ctxLevel":LEVEL_OK,
            "startTime":1000,"state":"working","description":"Find it"})
    );
    let l = &got[1];
    assert_eq!(
        (&l["effort"], &l["ctxPct"], &l["ctxLevel"]),
        (&"8000".into(), &90.into(), &LEVEL_CRITICAL.into())
    );
    assert_eq!(l["state"], "done");
    let n = &got[2];
    assert!(n.get("ctxPct").is_none() && n.get("ctxLevel").is_none());
}

#[tokio::test]
async fn activity_subagents_expire() {
    let env = activity_env(p1_env());
    let task = || {
        Some(vec![Subagent {
            id: Some("x".into()),
            ..Subagent::default()
        }])
    };
    let stale = SUBAGENT_STALE + Duration::from_secs(1);
    env.srv
        .agents
        .subagents
        .put("p1", task(), OffsetDateTime::now_utc() - stale);
    assert!(activity_subagents(&env).await.is_none());
    let fresh = SUBAGENT_STALE - Duration::from_secs(1);
    env.srv
        .agents
        .subagents
        .put("p1", task(), OffsetDateTime::now_utc() - fresh);
    assert!(activity_subagents(&env).await.is_some());
}

#[tokio::test]
async fn activity_empty_subagents_no_key() {
    let env = activity_env(p1_env());
    assert!(activity_subagents(&env).await.is_none());
    post(&env.srv, "/api/tools/subagents", SUBAGENTS_BODY).await;
    assert_eq!(
        post(
            &env.srv,
            "/api/tools/subagents",
            r#"{"toolId":"p1","tasks":[]}"#
        )
        .await
        .status,
        200
    );
    assert!(activity_subagents(&env).await.is_none());
}

#[tokio::test]
async fn subagents_rejects_missing_tool() {
    let env = p1_env();
    assert_eq!(
        post(&env.srv, "/api/tools/subagents", r#"{"tasks":[]}"#)
            .await
            .status,
        400
    );
}

#[tokio::test]
async fn status_carries_subagents() {
    let env = p1_env();
    post(&env.srv, "/api/tools/subagents", SUBAGENTS_BODY).await;
    let r = get(&env.srv, "/api/tools/activity/get?id=p1").await;
    assert_eq!(r.json()["subagents"].as_array().unwrap().len(), 3);
    assert!(r.body.contains(r#""tokens":19250"#) && r.body.contains(r#""effortBudget":8000"#));
    assert!(!r.body.contains("secret"));
}

#[test]
fn subagent_store_prune() {
    let st = crate::subagents::SubagentStore::default();
    let now = OffsetDateTime::now_utc();
    st.put("live", None, now);
    st.put("dead", None, now);
    assert_eq!(st.prune(|id| id == "live"), 1);
    assert!(st.get("dead", now).is_none() && st.get("live", now).is_some());
}

// ── 활동 카드 요약 (ACTIVITY_CARD_USAGE_SRS) ──

#[tokio::test]
async fn activity_carries_usage_summary() {
    let env = activity_env(p1_env());
    assert_eq!(
        post(&env.srv, "/api/tools/usage", USAGE_BODY).await.status,
        200
    );
    let a = activities(&env).await;
    assert_eq!(
        a,
        serde_json::json!({"toolId":"p1","state":"working","tool":"Edit","detail":"app.js",
            "updatedAt":a["updatedAt"],"usage":{"ctxPct":6,"ctxLevel":LEVEL_OK,"model":"Opus 5.5","effort":"medium"}})
    );
}

#[tokio::test]
async fn activity_no_usage_no_key() {
    let env = activity_env(p1_env());
    let a = activities(&env).await;
    assert!(a.get("usage").is_none());
    assert_eq!(a["state"], "working");
}

#[test]
fn card_usage_of_level_boundaries() {
    let p = ContextPolicy::default_policy();
    for (pct, want) in [
        (69.9, LEVEL_OK),
        (70.0, LEVEL_WARN),
        (84.9, LEVEL_WARN),
        (85.0, LEVEL_CRITICAL),
        (100.0, LEVEL_CRITICAL),
    ] {
        let c = ToolContext {
            used_pct: Some(pct),
            ..ToolContext::default()
        };
        assert_eq!(
            card_usage_of(Some(&c), None, p).unwrap().ctx_level,
            want,
            "{pct}"
        );
    }
}

#[tokio::test]
async fn activity_level_follows_settings() {
    let env = activity_env(p1_env_settings(
        r#"{"orchestration":{"contextWarnRatio":0.5,"contextCriticalRatio":0.6}}"#,
    ));
    for (body, want) in [
        (
            r#"{"toolId":"p1","usage":{"contextWindow":{"usedPct":55}}}"#,
            LEVEL_WARN,
        ),
        (
            r#"{"toolId":"p1","usage":{"contextWindow":{"usedPct":60}}}"#,
            LEVEL_CRITICAL,
        ),
    ] {
        assert_eq!(post(&env.srv, "/api/tools/usage", body).await.status, 200);
        assert_eq!(activities(&env).await["usage"]["ctxLevel"], want, "{body}");
    }
}

#[test]
fn card_usage_of_fallbacks() {
    let p = ContextPolicy::default_policy();
    let id = "claude-opus-5-5";
    let u = ToolUsage {
        usage: Usage {
            model: Some(Model {
                id: Some(id.into()),
                display_name: None,
            }),
            ..Usage::default()
        },
        observed_at: 0,
    };
    let got = card_usage_of(None, Some(&u), p).unwrap();
    assert_eq!(
        (
            got.model.as_str(),
            got.ctx_pct,
            got.ctx_level.as_str(),
            got.effort.as_str()
        ),
        (id, None, "", "")
    );
    let c = ToolContext {
        used_pct: Some(42.0),
        source: "transcript".into(),
        ..ToolContext::default()
    };
    let got = card_usage_of(Some(&c), None, p).unwrap();
    assert_eq!(
        (got.ctx_pct, got.ctx_level.as_str(), got.model.as_str()),
        (Some(42.0), LEVEL_OK, "")
    );
    assert!(card_usage_of(None, Some(&ToolUsage::default()), p).is_none());
    assert!(card_usage_of(None, None, p).is_none());
}
