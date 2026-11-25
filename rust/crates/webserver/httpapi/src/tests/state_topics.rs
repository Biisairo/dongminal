//! delta 토픽과 stats (`perf/CHANNEL_PROTOCOL.md` §10.4 C3).

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use otter_shared_toolhub::BackgroundEntry;
use serde_json::Value;

use super::attnenv::tracked;
use super::fakes::FakeStats;
use super::golden_554::{RunEnv, run_env};
use super::support::*;
use crate::channel::{Out, Outbox};
use crate::{Deps, Server};

/// 계기를 합치는 창(100 ms)보다 넉넉히 기다린다.
const SETTLE: Duration = Duration::from_millis(400);

async fn sub(srv: &Arc<Server>, topic: &str) -> Arc<Outbox> {
    let out = Outbox::new();
    srv.topics
        .subscribe(1, &out, topic, None, None)
        .await
        .unwrap_or_else(|e| panic!("{topic} 구독 실패: {e:?}"));
    out
}

/// 쌓인 프레임 전부. `NeedFull` 은 지금 상태의 full 로 바꾼다.
fn drain(srv: &Server, out: &Outbox) -> Vec<Value> {
    let mut v = Vec::new();
    while let Some(o) = out.pop() {
        match o {
            Out::Text(t) => v.push(serde_json::from_str(&t).unwrap()),
            Out::NeedFull(topic) => {
                if let Some(it) = srv.topics.full_item(&topic) {
                    v.push(serde_json::from_str(&it.frame).unwrap());
                }
            }
            _ => {}
        }
    }
    v
}

fn deltas(frames: &[Value]) -> Vec<Value> {
    frames
        .iter()
        .filter(|f| f["t"] == "delta")
        .flat_map(|f| f["ops"].as_array().cloned().unwrap_or_default())
        .collect()
}

/// TC-CH3-1
#[tokio::test]
async fn activity_full_is_map_with_limits() {
    let env = tracked(&["p1"]);
    env.tr.set_activity("p1", "working", "Edit", "a.js");
    let out = sub(&env.srv, "activity").await;
    let f = drain(&env.srv, &out);
    assert_eq!(f[0]["t"], "full", "{f:?}");
    let d = &f[0]["data"];
    assert_eq!(d["p1"]["state"], "working", "{d}");
    assert!(d["_limits"].is_array(), "{d}");
}

/// TC-CH3-2
#[tokio::test]
async fn activity_report_puts_only_that_tool() {
    let env = tracked(&["p1", "p2"]);
    env.tr.set_activity("p1", "working", "Edit", "a.js");
    env.tr.set_activity("p2", "working", "Read", "b.js");
    let out = sub(&env.srv, "activity").await;
    drain(&env.srv, &out);
    let r = post_json(
        &env.srv,
        "/api/tools/activity/set",
        r#"{"toolId":"p1","state":"idle"}"#,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    tokio::time::sleep(SETTLE).await;
    let ops = deltas(&drain(&env.srv, &out));
    assert_eq!(ops.len(), 1, "{ops:?}");
    assert_eq!(ops[0]["id"], "p1");
    assert_eq!(ops[0]["v"]["state"], "idle");

    // 바뀐 것이 없는 계기는 아무것도 내지 않는다.
    env.srv.state_topics_dirty();
    tokio::time::sleep(SETTLE).await;
    assert!(deltas(&drain(&env.srv, &out)).is_empty());
}

/// TC-CH3-3
#[tokio::test]
async fn usage_report_puts_usage_without_broadcast() {
    let env = tracked(&["p1"]);
    env.tr.set_activity("p1", "working", "Edit", "a.js");
    let out = sub(&env.srv, "activity").await;
    drain(&env.srv, &out);
    let r = post_json(
        &env.srv,
        "/api/tools/usage",
        r#"{"toolId":"p1","usage":{"sessionId":"s1","model":{"id":"m","displayName":"M"},
            "contextWindow":{"windowTokens":1000,"usedPct":40,"remainingPct":60}}}"#,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    tokio::time::sleep(SETTLE).await;
    let ops = deltas(&drain(&env.srv, &out));
    assert!(
        ops.iter()
            .any(|o| o["id"] == "p1" && !o["v"]["usage"].is_null()),
        "{ops:?}"
    );
}

/// TC-CH3-4
#[tokio::test]
async fn attention_set_and_clear_put_and_del() {
    let env = tracked(&["p1"]);
    let out = sub(&env.srv, "attention").await;
    let f = drain(&env.srv, &out);
    assert_eq!(f[0]["t"], "full");
    let r = post_json(&env.srv, "/api/tools/attention/set", r#"{"toolId":"p1"}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    tokio::time::sleep(SETTLE).await;
    let ops = deltas(&drain(&env.srv, &out));
    assert_eq!(
        ops,
        vec![serde_json::json!({"op":"put","id":"p1","v":true})]
    );
    let r = post_json(&env.srv, "/api/tools/attention/clear", r#"{"toolId":"p1"}"#).await;
    assert_eq!(r.status, 200, "{}", r.body);
    tokio::time::sleep(SETTLE).await;
    let ops = deltas(&drain(&env.srv, &out));
    assert_eq!(ops, vec![serde_json::json!({"op":"del","id":"p1"})]);
}

/// TC-CH3-5
#[tokio::test]
async fn background_change_puts_changed_rows() {
    let env = run_env(false, |_| {});
    env.hub.bg.lock().unwrap().push(bg("t1", "/a"));
    let out = sub(&env.srv, "background").await;
    let f = drain(&env.srv, &out);
    assert_eq!(f[0]["data"]["t1"]["cwd"], "/a", "{f:?}");
    {
        let mut g = env.hub.bg.lock().unwrap();
        g[0].cwd = "/b".into();
        g.push(bg("t2", "/c"));
    }
    env.srv.broadcast_layout("tools_background_changed", None);
    tokio::time::sleep(SETTLE).await;
    let mut ops = deltas(&drain(&env.srv, &out));
    ops.sort_by_key(|o| o["id"].as_str().unwrap_or_default().to_owned());
    assert_eq!(ops.len(), 2, "{ops:?}");
    assert_eq!(ops[0]["v"]["cwd"], "/b");
    assert_eq!(ops[1]["id"], "t2");
}

fn bg(id: &str, cwd: &str) -> BackgroundEntry {
    BackgroundEntry {
        tool_id: id.into(),
        name: id.into(),
        cwd: cwd.into(),
        since: 1,
    }
}

async fn start_run(env: &RunEnv) -> String {
    let r = call(
        &env.srv,
        "POST",
        "/api/runs",
        &[("Content-Type", "application/json")],
        r#"{"objective":"o","projection":"dedicated-window","windowId":"win-1","toolId":"tool-a"}"#,
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    let v: Value = serde_json::from_str(&r.body).unwrap();
    v["id"].as_str().unwrap().to_owned()
}

/// 받은 프레임을 브라우저처럼 맵에 얹는다.
fn apply(model: &mut serde_json::Map<String, Value>, frames: &[Value]) {
    for f in frames {
        if f["t"] == "full" {
            *model = f["data"].as_object().cloned().unwrap_or_default();
        }
        for op in f["ops"].as_array().into_iter().flatten() {
            let id = op["id"].as_str().unwrap_or_default().to_owned();
            if op["op"] == "put" {
                model.insert(id, op["v"].clone());
            } else {
                model.remove(&id);
            }
        }
    }
}

/// TC-CH3-6
#[tokio::test]
async fn run_change_updates_runs_and_run_graph() {
    let env = run_env(true, |_| {});
    let id = start_run(&env).await;
    let runs = sub(&env.srv, "runs").await;
    let mut model = serde_json::Map::new();
    apply(&mut model, &drain(&env.srv, &runs));
    assert!(model.contains_key(&id), "{model:?}");
    let graph = sub(&env.srv, &format!("run:{id}")).await;
    let g = drain(&env.srv, &graph);
    assert_eq!(g[0]["t"], "full");
    assert_eq!(g[0]["data"]["runId"], id.as_str(), "{g:?}");

    let r = call(
        &env.srv,
        "POST",
        "/api/runs/close",
        &[("Content-Type", "application/json")],
        &format!(r#"{{"runId":"{id}"}}"#),
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    tokio::time::sleep(SETTLE).await;
    apply(&mut model, &drain(&env.srv, &runs));
    assert!(
        model.get(&id).is_none_or(|v| v["state"] != "open"),
        "닫힌 Run 이 열린 채로 남았다: {model:?}"
    );
    // 닫힌 Run 은 저장소에서 물러난다 — 그래프는 null(사라짐) 또는 닫힌 상태다.
    let g = drain(&env.srv, &graph);
    let last = g
        .iter()
        .rev()
        .find(|f| f["t"] == "full")
        .expect("그래프가 다시 오지 않았다");
    assert!(
        last["data"].is_null() || last["data"]["state"] != "open",
        "{last}"
    );

    let out = Outbox::new();
    assert!(
        env.srv
            .topics
            .subscribe(2, &out, "run:nope", None, None)
            .await
            .is_err()
    );
}

/// TC-CH3-7
#[tokio::test]
async fn stats_topic_measures_only_while_subscribed() {
    let env = tracked(&[]);
    let out = sub(&env.srv, "stats:10").await;
    let f = drain(&env.srv, &out);
    assert_eq!(f[0]["t"], "full", "{f:?}");
    assert!(f[0]["data"].is_object());
    // 하한 1초: 0.5초 안에는 다음 측정이 없다.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(drain(&env.srv, &out).is_empty(), "하한 1초를 지키지 않았다");
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(
        drain(&env.srv, &out).iter().any(|f| f["t"] == "full"),
        "구독 중인데 다시 재지 않았다"
    );

    env.srv.topics.unsubscribe(1, "stats:10");
    let seq = |s: &Server| {
        s.topics
            .full_item("stats:10")
            .map(|i| i.seq)
            .unwrap_or_default()
    };
    let before = seq(&env.srv);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(seq(&env.srv), before, "구독자가 없는데 계속 잰다");
}

fn stats_env(warm_cpu: Option<f64>) -> (tempfile::TempDir, Arc<Server>, Arc<FakeStats>) {
    let fs = Arc::new(FakeStats {
        warm_cpu,
        ..FakeStats::default()
    });
    let d = tempfile::tempdir().unwrap();
    let s = server(
        d.path(),
        Deps {
            stats: Some(fs.clone()),
            ..Deps::default()
        },
    );
    (d, s, fs)
}

/// PERF 4.10 (S2): 구독이 없으면 샘플러를 띄우지도 읽지도 않는다.
#[tokio::test(start_paused = true)]
async fn stats_no_subscription_no_sampling() {
    let (_d, s, fs) = stats_env(Some(12.5));
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert!(
        !fs.active.load(Ordering::SeqCst),
        "구독이 없는데 샘플러가 돈다"
    );
    assert_eq!(fs.cached.load(Ordering::SeqCst), 0);
    drop(s);
}

/// PERF 4.10 (S2): 첫 `stats:*` 구독이 샘플러를 띄우고 마지막 해지가 멈춘다.
#[tokio::test(start_paused = true)]
async fn stats_subscribe_starts_unsubscribe_stops() {
    let (_d, s, fs) = stats_env(None);
    let a = Outbox::new();
    s.topics
        .subscribe(1, &a, "stats:1000", None, None)
        .await
        .unwrap();
    assert!(
        fs.active.load(Ordering::SeqCst),
        "구독했는데 샘플러가 서 있다"
    );
    let b = Outbox::new();
    s.topics
        .subscribe(2, &b, "stats:3000", None, None)
        .await
        .unwrap();
    s.topics.unsubscribe(1, "stats:1000");
    assert!(
        fs.active.load(Ordering::SeqCst),
        "남은 구독이 있는데 멈췄다"
    );
    s.topics.unsubscribe(2, "stats:3000");
    assert!(
        !fs.active.load(Ordering::SeqCst),
        "구독이 다 없어졌는데 돈다"
    );
    let n = fs.cached.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert_eq!(
        fs.cached.load(Ordering::SeqCst),
        n,
        "구독이 없는데 발행한다"
    );
}

/// PERF 4.10 (S2): 첫 프레임이 예열을 기다려 CPU 를 싣는다. 다시 구독해도 낡은 값이 아니라 새로 잰다.
#[tokio::test(start_paused = true)]
async fn stats_first_frame_has_cpu() {
    let (_d, s, _fs) = stats_env(Some(12.5));
    for _ in 0..2 {
        let out = sub(&s, "stats:1000").await;
        let f = drain(&s, &out);
        assert_eq!(f[0]["t"], "full", "{f:?}");
        assert_eq!(f[0]["data"]["cpu"], 12.5, "{f:?}");
        s.topics.unsubscribe(1, "stats:1000");
    }
}

/// PERF 4.10 (Q6, FR-STAT-9 개정): GET 은 그 자리에서 재고 샘플러를 띄우지 않는다.
#[tokio::test(start_paused = true)]
async fn api_stats_measures_without_sampler() {
    let (_d, s, fs) = stats_env(Some(12.5));
    let v = get(&s, "/api/stats").await.json();
    assert!(v.get("cpu").is_none(), "{v}");
    assert_eq!(
        fs.calls.load(Ordering::SeqCst),
        1,
        "GET 이 measure 를 부르지 않았다"
    );
    assert_eq!(fs.cached.load(Ordering::SeqCst), 0);
    assert!(!fs.active.load(Ordering::SeqCst));
}
