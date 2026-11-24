//! 주의·활동·배경·청구·데몬 판정 (Go `attention_endpoint_test.go`·`attention_codes_test.go`·
//! `attention_service_test.go`·`attention_claim_test.go`·`attention_daemon_test.go`·
//! `activity_api_test.go`·`activity_alarm_test.go`).

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use otter_shared_toolipc::{CODE_NOT_FOUND, RpcError};
use otter_webserver_apierr as apierr;

use super::attnenv::*;
use super::support::*;
use crate::attention::{ATTN_CLAIM_SELF_HOST, ATTN_CLAIM_TTL, AttnClaims};
use crate::{AttentionDaemon, DaemonCallError, Deps};

async fn attention_ids(env: &Env) -> Vec<String> {
    let r = get(&env.srv, "/api/tools/attention").await;
    let mut ids: Vec<String> =
        serde_json::from_value(r.json()["toolIds"].clone()).unwrap_or_default();
    ids.sort();
    ids
}

// TC-PAN-13: 주의가 선 도구들을 종단이 돌려준다.
#[tokio::test]
async fn attention_ids_endpoint() {
    let env = tracked(&["2", "5", "7"]);
    env.tr.signal_attention("2", "bell");
    env.tr.signal_attention("5", "bell");
    assert_eq!(attention_ids(&env).await, ["2", "5"]);
}

#[tokio::test]
async fn attention_clear() {
    let env = tracked(&["4"]);
    env.tr.signal_attention("4", "bell");
    let r = post(
        &env.srv,
        "/api/tools/attention/clear",
        r#"{"toolId":"999"}"#,
    )
    .await;
    assert_eq!(r.status, 200, "모르는 도구는 200 무동작");
    let r = post(&env.srv, "/api/tools/attention/clear", r#"{"toolId":"4"}"#).await;
    assert_eq!(r.status, 200);
    assert!(!env.tr.attention("4"));
    let ev = env.published("tool_attention_clear");
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["args"]["toolId"], "4");
    let r = post(&env.srv, "/api/tools/attention/clear", "{}").await;
    assert_eq!(r.status, 400);
}

// FR-PAN-18: otterctl notify → set 종단이 주의를 세운다. 이미 서 있어도 다시 알린다.
#[tokio::test]
async fn attention_set() {
    let env = tracked(&["9"]);
    env.tr.set_activity("9", "working", "Bash", "");
    let r = post(
        &env.srv,
        "/api/tools/attention/set",
        r#"{"toolId":"9","reason":"done"}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    assert!(env.tr.attention("9"));
    let got = env.published("tool_attention");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["args"]["reason"], "done");
    post(
        &env.srv,
        "/api/tools/attention/set",
        r#"{"toolId":"9","reason":"waiting"}"#,
    )
    .await;
    let got = env.published("tool_attention");
    assert_eq!(
        got.len(),
        2,
        "이미 주의 중이어도 두 번째 신호는 다시 울려야 한다"
    );
    assert_eq!(got[1]["args"]["reason"], "waiting");
    let r = post(&env.srv, "/api/tools/attention/set", "{}").await;
    assert_eq!(r.status, 400);
}

// FR-PAN-17: 일괄 해제.
#[tokio::test]
async fn clear_all_attention() {
    let env = tracked(&["1", "2", "3"]);
    env.tr.signal_attention("1", "bell");
    env.tr.signal_attention("2", "bell");
    let r = post(&env.srv, "/api/tools/attention/clear-all", "").await;
    assert_eq!(r.json()["cleared"], 2);
    assert!(env.tr.attention_ids().is_empty());
    assert_eq!(env.published("tool_attention_clear").len(), 2);
}

// V-ATL-6: 도구를 지우면 그 알람도 복원 목록에서 사라진다.
#[tokio::test]
async fn tool_delete_clears_attention() {
    let env = tracked(&["del", "keep"]);
    env.tr.signal_attention("del", "bell");
    env.tr.signal_attention("keep", "bell");
    let r = call(
        &env.srv,
        "DELETE",
        "/api/tools/del",
        &[("Content-Type", "application/json")],
        "",
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(attention_ids(&env).await, ["keep"]);
}

// V-ATF-8: 해제 종단의 `typed` 가 재무장 잠금을 푼다.
#[tokio::test]
async fn attention_clear_typed_unlocks_rearm() {
    for (body, refire) in [
        (r#"{"toolId":"a"}"#, false),
        (r#"{"toolId":"a","typed":true}"#, true),
    ] {
        let tr = real_tracker(1000);
        tr.set_busy_probe(Some(Arc::new(|ids: &[String]| {
            Some(ids.iter().map(|i| (i.clone(), true)).collect())
        })));
        tr.set_activity("a", "working", "Bash", "");
        let trc = tr.clone();
        let env = tracked_with(&["a"], move |d| d.attn_tracker = Some(trc));
        let r = post(&env.srv, "/api/tools/attention/clear", body).await;
        assert_eq!(r.status, 200);
        tr.feed_output("a", b"output");
        let later = SystemTime::now() + Duration::from_secs(3600);
        tr.sweep_idle_at(later.duration_since(UNIX_EPOCH).unwrap().as_nanos() as i64);
        assert_eq!(tr.attention("a"), refire, "{body}");
    }
}

// FR-OPT-1-9: 해석 실패와 필수 인자 누락을 다른 코드로 답한다. 본문은 바뀌지 않는다.
#[tokio::test]
async fn attention_family_bad_request_codes() {
    let env = tracked(&[]);
    for name in [
        "attention/set",
        "attention/clear",
        "activity/set",
        "background/set",
    ] {
        for (body, code) in [
            (r#"{"toolId":"#, apierr::CODE_INVALID_JSON),
            (r#"{"state":"working"}"#, apierr::CODE_MISSING_ARG),
        ] {
            let r = post(&env.srv, &format!("/api/tools/{name}"), body).await;
            assert_eq!(
                (r.status, r.header(otter_shared_httpresp::CODE_HEADER)),
                (400, code.to_owned()),
                "{name} {body}"
            );
        }
    }
    for (body, code) in [
        (r#"{"toolId":"1"}"#, apierr::CODE_MISSING_ARG),
        (
            r#"{"toolId":"1","state":"sleeping"}"#,
            apierr::CODE_BAD_REQUEST,
        ),
    ] {
        let r = post(&env.srv, "/api/tools/activity/set", body).await;
        assert_eq!(
            (r.status, r.header(otter_shared_httpresp::CODE_HEADER)),
            (400, code.to_owned())
        );
        assert_eq!(r.body, "bad request\n");
    }
}

// 추적기가 없으면 목록은 빈 배열, 신호·해제·보고는 무동작이다 (FR-DMR-12).
#[tokio::test]
async fn attention_service_without_tracker() {
    let dir = tempfile::tempdir().unwrap();
    let s = server(dir.path(), Deps::default());
    let a = s.attention();
    assert_eq!(a.attention_ids(), Some(Vec::new()));
    assert!(a.activity_snapshot().is_empty());
    a.signal_attention("x", "r");
    a.attend("x", true);
    a.report_activity("x", "done", "", "", true);
    a.forget("x");
    assert_eq!(a.clear_all_attention(), 0);
    assert!(a.activity("x").is_none());
    assert_eq!(a.last_output_at("x"), 0);
    assert_eq!(
        get(&s, "/api/tools/attention").await.body,
        "{\"toolIds\":[]}\n"
    );
}

// 데몬 모드의 신호는 모르는 도구에 무동작이다(존재를 먼저 본다).
#[tokio::test]
async fn tracker_signal_checks_existence() {
    let env = tracked(&[]);
    env.srv.attention().signal_attention("ghost", "done");
    assert!(!env.tr.attention("ghost"));
}

// ── 활동 ──

#[tokio::test]
async fn activity_set() {
    let env = tracked(&["9"]);
    let r = post(
        &env.srv,
        "/api/tools/activity/set",
        r#"{"toolId":"9","state":"working","tool":"Bash","detail":"npm test"}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    let got = env.tr.activity("9").unwrap();
    assert_eq!(
        (got.state.as_str(), got.tool.as_str(), got.detail.as_str()),
        ("working", "Bash", "npm test")
    );
    let ev = env.published("tool_activity");
    assert_eq!(ev.len(), 1);
    let a = &ev[0]["args"];
    assert_eq!(
        (&a["toolId"], &a["state"], &a["tool"], &a["detail"]),
        (
            &"9".into(),
            &"working".into(),
            &"Bash".into(),
            &"npm test".into()
        )
    );
    let r = post(
        &env.srv,
        "/api/tools/activity/set",
        r#"{"toolId":"999","state":"done"}"#,
    )
    .await;
    assert_eq!(r.status, 200, "모르는 도구는 200 무동작");
    let r = post(&env.srv, "/api/tools/activity/set", r#"{"state":"done"}"#).await;
    assert_eq!(r.status, 400);
    let r = post(
        &env.srv,
        "/api/tools/activity/set",
        r#"{"toolId":"9","state":"bogus"}"#,
    )
    .await;
    assert_eq!(r.status, 400);
}

#[tokio::test]
async fn activity_endpoint() {
    let env = tracked(&["1"]);
    env.tr.set_activity("1", "working", "Edit", "app.js");
    let r = get(&env.srv, "/api/tools/activity").await;
    let acts = r.json()["activities"].clone();
    assert_eq!(acts.as_array().unwrap().len(), 1);
    assert_eq!(acts[0]["toolId"], "1");
    assert_eq!(acts[0]["state"], "working");
    assert_eq!(acts[0]["tool"], "Edit");
    assert_eq!(r.json()["limits"], serde_json::json!([]));
}

#[tokio::test]
async fn activity_set_working_reaches_turn_mark() {
    let env = tracked(&["9"]);
    let r = post(
        &env.srv,
        "/api/tools/activity/set",
        r#"{"toolId":"9","state":"working","tool":"Bash"}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    assert!(
        env.tr.agent_state_of("9").turn.turn_ran,
        "working 이 턴 시작 표시에 닿지 않았다"
    );
    env.tr.signal_attention("9", "done");
    assert!(env.tr.attention("9"));
}

async fn activity(env: &Env, body: &str) {
    let r = post(&env.srv, "/api/tools/activity/set", body).await;
    assert_eq!(r.status, 200, "{body}");
}

// V-AEV-1: omp 가 턴을 시작했다가 끝내면 알람이 선다 (FR-AEV-10).
#[tokio::test]
async fn activity_alarm_omp_done_raises() {
    let env = tracked(&["1"]);
    activity(&env, r#"{"toolId":"1","agent":"omp","state":"working"}"#).await;
    assert!(!env.tr.attention("1"));
    activity(&env, r#"{"toolId":"1","agent":"omp","state":"done"}"#).await;
    assert!(env.tr.attention("1"));
}

#[tokio::test]
async fn activity_alarm_claude_done_raises_without_notify() {
    let env = tracked(&["1"]);
    activity(&env, r#"{"toolId":"1","agent":"claude","state":"working"}"#).await;
    activity(&env, r#"{"toolId":"1","agent":"claude","state":"done"}"#).await;
    assert!(env.tr.attention("1"));
}

#[tokio::test]
async fn activity_alarm_unknown_turn_origin_always_raises() {
    let env = tracked(&["1"]);
    activity(&env, r#"{"toolId":"1","agent":"codex","state":"done"}"#).await;
    assert!(env.tr.attention("1"), "FR-CBG-5");
}

#[tokio::test]
async fn activity_alarm_waiting_rules_unchanged() {
    let env = tracked(&["1"]);
    activity(&env, r#"{"toolId":"1","agent":"claude","state":"waiting"}"#).await;
    assert!(!env.tr.attention("1"), "FR-ATN-6");
    activity(&env, r#"{"toolId":"1","agent":"claude","state":"working"}"#).await;
    activity(&env, r#"{"toolId":"1","agent":"claude","state":"waiting"}"#).await;
    assert!(env.tr.attention("1"));
    env.tr.attend("1");
    activity(&env, r#"{"toolId":"1","agent":"claude","state":"waiting"}"#).await;
    assert!(!env.tr.attention("1"), "FR-ATN-15");
}

#[tokio::test]
async fn activity_alarm_notify_and_activity_raise_once() {
    let env = tracked(&["1"]);
    activity(&env, r#"{"toolId":"1","agent":"claude","state":"working"}"#).await;
    activity(&env, r#"{"toolId":"1","agent":"claude","state":"done"}"#).await;
    assert!(env.tr.attention("1"));
    env.tr.attend("1");
    env.tr.signal_attention("1", "done");
    assert!(!env.tr.attention("1"), "FR-AEV-13");
}

// ── 청구 (ATTENTION_FIRING_SRS 묶음 D) ──

fn kinds(k: &[&str]) -> Vec<String> {
    k.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn attn_claims_first_claim_per_seq_host_kind() {
    let c = AttnClaims::default();
    assert_eq!(
        c.claim(1, "self", &kinds(&["banner", "sound"])),
        ["banner", "sound"]
    );
    assert!(c.claim(1, "self", &kinds(&["banner", "sound"])).is_empty());
    assert_eq!(c.claim(1, "100.64.0.9", &kinds(&["banner"])), ["banner"]);
    assert_eq!(c.claim(2, "self", &kinds(&["sound"])), ["sound"]);
}

#[test]
fn attn_claims_kinds_are_independent() {
    let c = AttnClaims::default();
    assert_eq!(c.claim(7, "self", &kinds(&["sound"])), ["sound"]);
    assert_eq!(c.claim(7, "self", &kinds(&["banner", "sound"])), ["banner"]);
}

#[test]
fn attn_claims_unknown_kind_ignored() {
    let c = AttnClaims::default();
    assert_eq!(
        c.claim(1, "self", &kinds(&["vibrate", "banner"])),
        ["banner"]
    );
}

#[test]
fn attn_claims_expire_after_ttl() {
    let c = AttnClaims::default();
    let t0 = Instant::now();
    *c.now.lock().unwrap() = Some(t0);
    c.claim(1, "self", &kinds(&["banner"]));
    *c.now.lock().unwrap() = Some(t0 + ATTN_CLAIM_TTL + Duration::from_secs(1));
    c.claim(2, "self", &kinds(&["banner"]));
    assert!(
        !c.by_seq.lock().unwrap().contains_key(&1),
        "지난 기록이 치워지지 않았다"
    );
    assert_eq!(c.claim(1, "self", &kinds(&["banner"])), ["banner"]);
}

#[tokio::test]
async fn claim_host_self_addresses_are_one_computer() {
    let dir = tempfile::tempdir().unwrap();
    let s = server(dir.path(), Deps::default());
    let st = s.access.clone().unwrap();
    quiet(&st);
    let me: IpAddr = "100.64.0.1".parse().unwrap();
    *st.interface_addrs.write().unwrap() = Arc::new(move || Ok(vec![me]));
    st.refresh();
    for ra in [
        "127.0.0.1:5000",
        "[::1]:5001",
        "100.64.0.1:5002",
        "[::ffff:127.0.0.1]:5003",
    ] {
        assert_eq!(s.claim_host(ra), ATTN_CLAIM_SELF_HOST, "{ra}");
    }
    let (a, b) = (s.claim_host("100.64.0.9:1"), s.claim_host("100.64.0.9:2"));
    assert!(a == b && a != ATTN_CLAIM_SELF_HOST, "{a} {b}");
    assert_ne!(s.claim_host("100.64.0.9:1"), s.claim_host("100.64.0.10:1"));
}

async fn post_claim(s: &Arc<crate::Server>, remote: &str, body: &str) -> Resp {
    call(
        s,
        "POST",
        "/api/tools/attention/claim",
        &[("Content-Type", "application/json")],
        body,
        remote,
    )
    .await
}

#[tokio::test]
async fn attention_claim_grants_once_per_computer() {
    let env = tracked(&[]);
    let first = post_claim(
        &env.srv,
        "127.0.0.1:4000",
        r#"{"seq":5,"kinds":["banner","sound"]}"#,
    )
    .await;
    let second = post_claim(
        &env.srv,
        "[::1]:4001",
        r#"{"seq":5,"kinds":["banner","sound"]}"#,
    )
    .await;
    assert_eq!(first.body, "{\"granted\":[\"banner\",\"sound\"]}\n");
    assert_eq!(second.body, "{\"granted\":[]}\n");
}

#[tokio::test]
async fn attention_claim_rejects_missing_seq() {
    let env = tracked(&[]);
    for body in ["{}", r#"{"seq":0,"kinds":["banner"]}"#, "not json"] {
        assert_eq!(
            post_claim(&env.srv, "127.0.0.1:1", body).await.status,
            400,
            "{body}"
        );
    }
}

// ── 데몬 판정 (AGENT_RECORD_DAEMON_SRS §3.3a) ──

#[derive(Default)]
struct FakeAttnDaemon {
    judges: bool,
    err: Mutex<Option<DaemonCallError>>,
    reports: Mutex<Vec<String>>,
    attends: Mutex<Vec<String>>,
    all: Mutex<usize>,
}

impl FakeAttnDaemon {
    fn res(&self) -> Result<(), DaemonCallError> {
        self.err.lock().unwrap().clone().map_or(Ok(()), Err)
    }
}

impl AttentionDaemon for FakeAttnDaemon {
    fn judges(&self) -> bool {
        self.judges
    }
    fn report(&self, method: &str, body: &[u8]) -> Result<(), DaemonCallError> {
        let v: serde_json::Value = serde_json::from_slice(body).unwrap();
        let id = v["toolId"].as_str().unwrap_or_default();
        self.reports.lock().unwrap().push(format!("{method}/{id}"));
        self.res()
    }
    fn attend(&self, tool_id: &str, typed: bool) -> Result<(), DaemonCallError> {
        let id = if typed {
            format!("{tool_id}+typed")
        } else {
            tool_id.to_owned()
        };
        self.attends.lock().unwrap().push(id);
        self.res()
    }
    fn attend_all(&self) -> Result<i64, DaemonCallError> {
        *self.all.lock().unwrap() += 1;
        self.res().map(|()| 3)
    }
}

fn daemon_env(judges: bool) -> (Env, Arc<FakeAttnDaemon>) {
    let d = Arc::new(FakeAttnDaemon {
        judges,
        ..FakeAttnDaemon::default()
    });
    let dd = d.clone();
    let env = tracked_with(&["t1"], move |deps| deps.attn_daemon = Some(dd));
    (env, d)
}

#[tokio::test]
async fn attn_daemon_http_reports_forwarded() {
    let (env, d) = daemon_env(true);
    let before = env.cmds.published().len();
    let r = post(
        &env.srv,
        "/api/tools/activity/set",
        r#"{"toolId":"t1","state":"done"}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    let r = post(
        &env.srv,
        "/api/tools/attention/set",
        r#"{"toolId":"t1","reason":"waiting"}"#,
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        *d.reports.lock().unwrap(),
        ["report.activity/t1", "report.notify/t1"]
    );
    assert!(env.tr.activity("t1").is_none() && !env.tr.attention("t1"));
    assert_eq!(env.cmds.published().len(), before, "서버가 스스로 판정했다");
    let r = post(
        &env.srv,
        "/api/tools/activity/set",
        r#"{"toolId":"t1","state":"nap"}"#,
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(d.reports.lock().unwrap().len(), 2, "틀린 보고를 넘겼다");
}

#[tokio::test]
async fn attn_daemon_forward_errors() {
    let (env, d) = daemon_env(true);
    *d.err.lock().unwrap() = Some(DaemonCallError::Rpc(RpcError {
        code: CODE_NOT_FOUND,
        message: "nope".into(),
    }));
    let r = post(&env.srv, "/api/tools/attention/set", r#"{"toolId":"nope"}"#).await;
    assert_eq!(r.status, 200, "없는 도구는 종전의 무동작");
    *d.err.lock().unwrap() = Some(DaemonCallError::Other("연결 끊김".into()));
    let r = post(&env.srv, "/api/tools/attention/set", r#"{"toolId":"t1"}"#).await;
    assert_eq!(r.status, 503);
    assert_eq!(
        r.header(otter_shared_httpresp::CODE_HEADER),
        apierr::CODE_TOOLS_UNREADY
    );
    assert_eq!(r.body, "daemon unavailable\n");
}

#[tokio::test]
async fn attn_daemon_report_push_not_judged() {
    let (env, _d) = daemon_env(true);
    let before = env.cmds.published().len();
    env.srv.apply_report(
        "report.activity",
        br#"{"toolId":"t1","agent":"claude","state":"working"}"#,
    );
    env.srv.apply_report(
        "report.activity",
        br#"{"toolId":"t1","agent":"claude","state":"done"}"#,
    );
    env.srv.apply_report("report.notify", br#"{"toolId":"t1"}"#);
    assert!(env.tr.activity("t1").is_none() && !env.tr.attention("t1"));
    for p in &env.cmds.published()[before..] {
        assert!(
            !p.contains(r#""action":"tool_attention""#),
            "서버가 알람을 방송했다"
        );
    }
    env.srv.apply_report(
        "report.activity",
        br#"{"toolId":"t1","agentId":"a1","agentType":"Explore","state":"working"}"#,
    );
    let acts = env
        .srv
        .agents
        .sub_acts
        .list("t1", time::OffsetDateTime::now_utc());
    assert_eq!(acts["a1"].agent_type, "Explore");
}

#[tokio::test]
async fn attn_daemon_clear_goes_to_daemon() {
    let (env, d) = daemon_env(true);
    env.tr.signal_attention("t1", "signaled");
    post(
        &env.srv,
        "/api/tools/attention/clear",
        r#"{"toolId":"t1","typed":true}"#,
    )
    .await;
    let r = post(&env.srv, "/api/tools/attention/clear-all", "").await;
    assert_eq!(*d.attends.lock().unwrap(), ["t1+typed"]);
    assert_eq!(*d.all.lock().unwrap(), 1);
    assert!(r.body.contains(r#""cleared":3"#), "{}", r.body);
    assert!(env.tr.attention("t1"), "해제는 데몬의 attn push 로 온다");
}

#[tokio::test]
async fn attn_daemon_old_daemon_unchanged() {
    let (env, d) = daemon_env(false);
    post(&env.srv, "/api/tools/attention/set", r#"{"toolId":"t1"}"#).await;
    post(&env.srv, "/api/tools/attention/clear", r#"{"toolId":"t1"}"#).await;
    assert!(d.reports.lock().unwrap().is_empty() && d.attends.lock().unwrap().is_empty());
    assert!(!env.tr.attention("t1") && env.tr.agent_state_of("t1").rearm_locked);
}
