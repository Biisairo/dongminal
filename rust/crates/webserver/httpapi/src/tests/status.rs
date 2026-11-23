//! 상태·대기 계약 (Go `handlers_status_test.go`·`handlers_status_ladder_test.go`·
//! `handlers_status_concurrency_test.go`·`handlers_status_wait_test.go`·`liveness_test.go` 중 Run 이
//! 없는 부분).

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::attnenv::*;
use super::fakes::FakeHub;
use super::support::*;
use crate::Deps;
use crate::status::{Liveness, ToolStatus, WAIT_MAX_CONCURRENT, evaluate_wait};

const READY_QUIET_MS: i64 = 3000;

fn status_env() -> Env {
    tracked_with(&["p1"], |d| {
        let mut idx = IdIndex::default();
        for k in ["p1", "W1.P1.T1", "aaaaaaaa-1111-2222-3333-444444444444"] {
            idx.resolve.insert(k.to_owned(), "p1".to_owned());
        }
        d.work_index = Some(Arc::new(idx));
    })
}

fn unknown_env() -> Env {
    tracked_with(&["p1"], |d| {
        d.tools = Some(Arc::new(FakeHub {
            unknown: true,
            ..FakeHub::default()
        }));
    })
}

fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64
}

/// Go `outputClock.Store`: 마지막 출력 시각을 ns 로 세운다.
fn store_output(env: &Env, ns: i64) {
    env.tr.set_clock_for_testing(Some(Arc::new(move || ns)));
    env.tr.feed_output("p1", b"");
    env.tr.set_clock_for_testing(None);
}

async fn status(env: &Env, q: &str) -> Resp {
    get(&env.srv, &format!("/api/tools/activity/get?{q}")).await
}

async fn wait(env: &Env, q: &str) -> Resp {
    get(&env.srv, &format!("/api/tools/activity/wait?{q}")).await
}

#[tokio::test]
async fn status_reported_activity() {
    let env = status_env();
    env.tr
        .set_activity("p1", "working", "Bash", "go test ./...");
    let r = status(&env, "id=p1").await;
    assert_eq!(r.status, 200);
    let o = r.json();
    assert_eq!(
        (&o["state"], &o["tool"], &o["detail"]),
        (&"working".into(), &"Bash".into(), &"go test ./...".into())
    );
    assert_eq!(o["live"], true);
    assert_eq!(o["toolId"], "p1");
    assert_eq!(
        o["limits"],
        serde_json::Value::Null,
        "빈 한도는 싣지 않는다"
    );
}

#[tokio::test]
async fn status_resolves_every_identifier_form() {
    let env = status_env();
    env.tr.set_activity("p1", "idle", "", "startup");
    for id in ["p1", "W1.P1.T1", "aaaaaaaa-1111-2222-3333-444444444444"] {
        let r = status(&env, &format!("id={id}")).await;
        assert_eq!(
            (r.status, r.json()["state"].clone()),
            (200, "idle".into()),
            "{id}"
        );
    }
    assert_eq!(status(&env, "id=nope").await.status, 404);
    assert_eq!(status(&env, "").await.status, 400);
}

#[tokio::test]
async fn status_unknown_when_never_reported() {
    let env = status_env();
    let r = status(&env, "id=p1").await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["state"], "unknown");
    assert_eq!(r.json()["quietMs"], -1);
}

#[tokio::test]
async fn wait_ready_on_transition() {
    let env = status_env();
    env.tr.set_activity("p1", "working", "", "");
    let tr = env.tr.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        tr.set_activity("p1", "idle", "", "");
    });
    let start = Instant::now();
    let r = wait(&env, "id=p1&for=ready&timeoutMs=5000").await;
    assert_eq!(
        (r.status, r.json()["status"].clone()),
        (200, "ready".into())
    );
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn wait_waiting_is_blocked_immediately() {
    let env = status_env();
    env.tr.set_activity("p1", "waiting", "", "");
    let start = Instant::now();
    let r = wait(&env, "id=p1&for=ready&timeoutMs=60000").await;
    assert_eq!(
        (r.status, r.json()["status"].clone()),
        (200, "blocked".into())
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(r.json()["state"], "waiting");
    assert_eq!(r.json()["reason"], "waiting");
    let r = wait(&env, "id=p1&for=done&timeoutMs=60000").await;
    assert_eq!(r.json()["status"], "blocked");
}

#[tokio::test]
async fn wait_timeout_reports_last_observation() {
    let env = status_env();
    env.tr.set_activity("p1", "working", "Bash", "sleep 600");
    store_output(&env, now_ns());
    let r = wait(&env, "id=p1&for=ready&timeoutMs=150").await;
    let o = r.json();
    assert_eq!((r.status, o["status"].clone()), (200, "timeout".into()));
    assert_eq!(o["state"], "working");
    assert!(o["lastOutputAt"].as_i64().unwrap() > 0);
    assert!(o.get("waitedMs").is_some() && o.get("reason").is_none());
    assert_eq!(o["timeoutMs"], 150);
}

#[tokio::test]
async fn wait_quiescence_ready() {
    let env = status_env();
    store_output(&env, now_ns() - 4_000_000_000);
    let r = wait(&env, "id=p1&for=ready&timeoutMs=500").await;
    assert_eq!(
        (r.status, r.json()["status"].clone()),
        (200, "ready".into())
    );
    assert_eq!(r.json()["reason"], "quiescence");
}

#[tokio::test]
async fn wait_not_quiet_yet_is_not_ready() {
    let env = status_env();
    store_output(&env, now_ns());
    assert_eq!(
        wait(&env, "id=p1&for=ready&timeoutMs=150").await.json()["status"],
        "timeout"
    );
}

#[tokio::test]
async fn wait_quiescence_never_implies_done() {
    let env = status_env();
    store_output(&env, now_ns() - 10_000_000_000);
    assert_eq!(
        wait(&env, "id=p1&for=done&timeoutMs=150").await.json()["status"],
        "timeout"
    );
}

#[tokio::test]
async fn wait_done_condition() {
    let env = status_env();
    env.tr.set_activity("p1", "idle", "", "");
    assert_eq!(
        wait(&env, "id=p1&for=done&timeoutMs=150").await.json()["status"],
        "timeout"
    );
    env.tr.set_activity("p1", "done", "", "");
    assert_eq!(
        wait(&env, "id=p1&for=done&timeoutMs=5000").await.json()["status"],
        "done"
    );
}

#[tokio::test]
async fn wait_tool_disappears() {
    let env = status_env();
    env.tr.set_activity("p1", "working", "", "");
    let io = env.io.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(120)).await;
        io.set_has("p1", false);
    });
    let r = wait(&env, "id=p1&for=ready&timeoutMs=5000").await;
    assert_eq!((r.status, r.json()["status"].clone()), (200, "gone".into()));
    assert_eq!(r.json()["reason"], "tool 이 사라졌다");
}

#[tokio::test]
async fn wait_argument_validation() {
    let env = status_env();
    assert_eq!(wait(&env, "id=p1&timeoutMs=100").await.status, 400);
    let r = wait(&env, "id=p1&for=bogus").await;
    assert_eq!(r.status, 400);
    assert_eq!(
        r.body,
        "{\"error\":\"for 는 ready 또는 done 이어야 한다: bogus\"}\n"
    );
    let r = wait(&env, "id=p1&for=ready&timeoutMs=abc").await;
    assert_eq!(r.body, "{\"error\":\"timeoutMs 는 정수여야 한다: abc\"}\n");
    assert_eq!(
        wait(&env, "id=p1&for=done&timeoutMs=1").await.json()["timeoutMs"],
        100
    );
    assert_eq!(env.srv.waits.in_flight.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn status_missing_deps_is_503() {
    let dir = tempfile::tempdir().unwrap();
    let s = server(dir.path(), Deps::default());
    assert_eq!(get(&s, "/api/tools/activity/get?id=p1").await.status, 503);
    assert_eq!(
        get(&s, "/api/tools/activity/wait?id=p1&for=ready")
            .await
            .status,
        503
    );
}

// ── 사다리 (FR-STA-4) ──

fn quiet_status(state: &str) -> ToolStatus {
    ToolStatus {
        tool_id: "t1".into(),
        live: true,
        state: state.into(),
        quiet_ms: READY_QUIET_MS + 5000,
        ..ToolStatus::default()
    }
}

#[test]
fn evaluate_wait_quiescence_not_used_for_hook_based_agents() {
    let st = quiet_status("unknown");
    assert_eq!(evaluate_wait("ready", &st, false), None);
    assert_eq!(
        evaluate_wait("ready", &st, true),
        Some(("ready", "quiescence"))
    );
}

#[test]
fn evaluate_wait_hook_still_wins_with_fallback_off() {
    for (state, cond, want) in [
        ("idle", "ready", "ready"),
        ("done", "ready", "ready"),
        ("done", "done", "done"),
        ("waiting", "ready", "blocked"),
        ("waiting", "done", "blocked"),
    ] {
        assert_eq!(
            evaluate_wait(cond, &quiet_status(state), false).map(|v| v.0),
            Some(want)
        );
    }
}

#[test]
fn evaluate_wait_quiescence_never_settles_done() {
    assert_eq!(evaluate_wait("done", &quiet_status("unknown"), true), None);
}

#[test]
fn evaluate_wait_gone_settles_regardless() {
    let mut st = quiet_status("unknown");
    st.live = false;
    for allow in [true, false] {
        assert_eq!(
            evaluate_wait("ready", &st, allow).map(|v| v.0),
            Some("gone")
        );
    }
}

#[test]
fn quiescence_allowed_without_runs() {
    let env = status_env();
    assert!(env.srv.quiescence_allowed("anything"));
}

// ── 동시 대기 상한 (FR-STA-9) ──

#[tokio::test]
async fn wait_over_concurrency_is_429() {
    let env = status_env();
    env.srv
        .waits
        .in_flight
        .store(WAIT_MAX_CONCURRENT, Ordering::SeqCst);
    let r = wait(&env, "id=p1&for=ready&timeout-ms=100").await;
    assert_eq!(r.status, 429);
    assert_eq!(
        env.srv.waits.in_flight.load(Ordering::SeqCst),
        WAIT_MAX_CONCURRENT
    );
}

#[tokio::test]
async fn wait_slots_are_per_server() {
    let full = status_env();
    full.srv
        .waits
        .in_flight
        .store(WAIT_MAX_CONCURRENT, Ordering::SeqCst);
    let env = status_env();
    env.tr.set_activity("p1", "idle", "", "");
    assert_eq!(
        wait(&env, "id=p1&for=ready&timeout-ms=100").await.status,
        200
    );
}

#[tokio::test]
async fn wait_releases_slot() {
    let env = status_env();
    env.tr.set_activity("p1", "idle", "", "");
    assert_eq!(
        wait(&env, "id=p1&for=ready&timeout-ms=100").await.status,
        200
    );
    assert_eq!(env.srv.waits.in_flight.load(Ordering::SeqCst), 0);
}

#[test]
fn wait_max_concurrent_default() {
    assert_eq!(WAIT_MAX_CONCURRENT, 32);
}

// ── 재평가 시각 (FR-OPT-16-3) ──

#[tokio::test]
async fn wait_evaluates_only_at_deadlines() {
    let env = status_env();
    env.tr.set_activity("p1", "working", "", "");
    let r = wait(&env, "id=p1&for=ready&timeoutMs=1500").await;
    assert_eq!(r.json()["status"], "timeout");
    let n = env.srv.waits.evals.load(Ordering::SeqCst);
    assert!(n <= 4, "알림 없는 1.5 s 대기가 {n} 번 재평가했다");
}

#[tokio::test]
async fn wait_activity_report_wakes_wait() {
    let env = status_env();
    env.tr.set_activity("p1", "working", "", "");
    let srv = env.srv.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        srv.report_activity("p1", "idle", "", "", false);
    });
    let start = Instant::now();
    let r = wait(&env, "id=p1&for=ready&timeoutMs=5000").await;
    assert_eq!(
        (r.json()["status"].clone(), r.json()["reason"].clone()),
        ("ready".into(), "hook".into())
    );
    assert!(
        start.elapsed() < Duration::from_millis(700),
        "{:?}",
        start.elapsed()
    );
    assert!(env.srv.waits.evals.load(Ordering::SeqCst) <= 3);
}

#[tokio::test]
async fn wait_quiescence_wakes_at_quiet_deadline() {
    let env = status_env();
    store_output(&env, now_ns() - 2_600_000_000);
    let start = Instant::now();
    let r = wait(&env, "id=p1&for=ready&timeoutMs=5000").await;
    assert_eq!(
        (r.json()["status"].clone(), r.json()["reason"].clone()),
        ("ready".into(), "quiescence".into())
    );
    let el = start.elapsed();
    assert!(
        el >= Duration::from_millis(300) && el <= Duration::from_millis(900),
        "{el:?}"
    );
    assert!(r.json()["quietMs"].as_i64().unwrap() >= READY_QUIET_MS);
    assert!(env.srv.waits.evals.load(Ordering::SeqCst) <= 2);
}

// ── 생존 세 값 (FR-ARD-1·2) ──

#[test]
fn tool_liveness_three_values() {
    let env = status_env();
    assert_eq!(env.srv.tool_liveness("p1"), Liveness::Alive);
    assert_eq!(env.srv.tool_liveness("tool-gone"), Liveness::Dead);
    assert!(env.srv.tool_dead("tool-gone") && env.srv.tool_not_dead("p1"));
    let env = unknown_env();
    for id in ["p1", "tool-gone"] {
        assert_eq!(env.srv.tool_liveness(id), Liveness::Unknown);
        assert!(env.srv.tool_not_dead(id));
    }
}

#[tokio::test]
async fn tool_status_live_unknown() {
    let env = status_env();
    let o = status(&env, "id=p1").await.json();
    assert_eq!(o["live"], true);
    assert!(o.get("liveUnknown").is_none());
    let env = unknown_env();
    let o = status(&env, "id=p1").await.json();
    assert_eq!(
        (o["live"].clone(), o["liveUnknown"].clone()),
        (false.into(), true.into())
    );
}

#[tokio::test]
async fn tool_status_wait_does_not_end_on_unknown() {
    let env = unknown_env();
    let o = wait(&env, "id=p1&for=done&timeoutMs=1500").await.json();
    assert_eq!(o["status"], "timeout");
    assert_eq!(o["liveUnknown"], true);
}
