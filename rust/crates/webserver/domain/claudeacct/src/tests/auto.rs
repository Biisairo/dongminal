//! autoswitch_test·autoswitch_ranges_test·autoswitch_trigger_test·alerts_test·alert_text_test, 그리고
//! engine_round_test·statusline_merge_test·profile_test 의 Auto 시험.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::engine::{FakeUsageApi, NOW_UNIX, future_cred, three_accounts};
use super::service::{Env, clock_fn, write_session};
use crate::auto::{AcctView, CSWAP_PROBE_TTL, auto_trigger, in_cooldown};
use crate::error::Sentinel;
use crate::usage::{Binding, binding_of, line_headroom};
use crate::view::display_name;
use crate::*;

type SlMap = Arc<Mutex<HashMap<String, (Usage, i64)>>>;

struct AutoEnv {
    e: Env,
    eng: Arc<Engine>,
    api: Arc<FakeUsageApi>,
    auto: Auto,
    alerts: Arc<Mutex<Vec<Alert>>>,
    procs: Arc<Mutex<Vec<String>>>,
    probes: Arc<Mutex<usize>>,
    sl: SlMap,
}

async fn new_auto_env() -> AutoEnv {
    let (e, mut eng, api) = three_accounts().await;
    let sl: SlMap = Arc::default();
    let sl2 = sl.clone();
    eng.status_line = Some(Arc::new(move |a: &Account| {
        sl2.lock().unwrap().get(&a.email).cloned()
    }));
    let eng = Arc::new(eng);
    let mut x = AutoEnv {
        auto: Auto::new(eng.clone(), clock_fn(&e.clock)),
        e,
        eng,
        api,
        alerts: Arc::default(),
        procs: Arc::default(),
        probes: Arc::default(),
        sl,
    };
    x.auto = x.new_auto();
    x.auto.load().unwrap();
    x
}

impl AutoEnv {
    fn new_auto(&self) -> Auto {
        let mut a = Auto::new(self.eng.clone(), clock_fn(&self.e.clock));
        a.jitter = Some(Arc::new(|| 0.0));
        let (p, n) = (self.procs.clone(), self.probes.clone());
        a.procs = Some(Arc::new(move || {
            *n.lock().unwrap() += 1;
            Ok(p.lock().unwrap().clone())
        }));
        let al = self.alerts.clone();
        a.notify = Some(Arc::new(move |x: &Alert| {
            al.lock().unwrap().push(x.clone())
        }));
        a
    }

    fn put(&self, body: &str) -> AutoView {
        self.auto
            .put(body.as_bytes())
            .unwrap_or_else(|e| panic!("put {body}: {e}"))
    }

    async fn usage(&self, id: &str, token: &str, body: &str) {
        self.api.set_usage(token, body);
        let mut r = self.eng.rows().get(id).cloned().unwrap_or_default();
        r.last_attempt_at = 0;
        r.backoff_until = 0;
        self.eng.set_row(id, r);
        self.eng.fetch_now(id).await.unwrap();
    }

    fn active(&self) -> String {
        self.e.svc.store.load().unwrap().active_id
    }

    async fn tick(&self) -> Duration {
        self.auto.tick(&CancellationToken::new()).await
    }

    fn kinds(&self) -> Vec<String> {
        self.alerts
            .lock()
            .unwrap()
            .iter()
            .map(|a| a.kind.clone())
            .collect()
    }

    fn now(&self) -> i64 {
        self.eng.now_unix()
    }

    fn last_trigger(&self) -> String {
        self.auto.view().state.last_switch.unwrap().trigger
    }
}

fn rfc3339(unix: i64) -> String {
    dm_gocompat::time::format_rfc3339(time::OffsetDateTime::from_unix_timestamp(unix).unwrap())
}

#[tokio::test]
async fn auto_settings_defaults_put_and_persist() {
    let x = new_auto_env().await;
    let v = x.auto.view();
    assert_eq!(v.settings, AutoSettings::default());
    let s = &v.settings;
    assert!(
        !s.enabled
            && s.threshold == 90.0
            && s.weekly_threshold.is_none()
            && s.interval_seconds == 60
    );
    assert!(
        s.cooldown_seconds == 300
            && s.hysteresis_pct == 10.0
            && s.strategy == AUTO_STRATEGY_BEST
            && s.unhealthy_ticks == 3
            && s.models.is_none()
    );
    assert_eq!(v.state.status, AUTO_OFF);
    let v = x.put(
        r#"{"threshold":85,"weeklyThreshold":97,"models":["Fable"],"strategy":"consume-first"}"#,
    );
    assert!(v.settings.threshold == 85.0 && v.settings.weekly_threshold == Some(97.0));
    assert!(
        v.settings.models == Some(vec!["Fable".into()])
            && v.settings.strategy == AUTO_STRATEGY_CONSUME_FIRST
    );
    let y = x.new_auto();
    y.load().unwrap();
    assert_eq!(y.view().settings.threshold, 85.0, "persisted");
    let v = x.put(r#"{"weeklyThreshold":null,"models":"all"}"#);
    assert!(
        v.settings.weekly_threshold.is_none()
            && v.settings.models == Some(vec![MODELS_ALL.into()])
            && v.settings.threshold == 85.0
    );
    let v = x.put(r#"{"models":null}"#);
    assert!(v.settings.models.is_none());
    let p = x.e.data.join("autoswitch.json");
    assert!(super::perm_is(&p, 0o600));
    // 관측 바이트: autoswitch.json (MarshalIndent).
    assert_eq!(
        std::fs::read_to_string(&p).unwrap(),
        "{\n  \"schemaVersion\": 1,\n  \"settings\": {\n    \"enabled\": false,\n    \"threshold\": 85,\n    \"weeklyThreshold\": null,\n    \"intervalSeconds\": 60,\n    \"cooldownSeconds\": 300,\n    \"hysteresisPct\": 10,\n    \"strategy\": \"consume-first\",\n    \"unhealthyTicks\": 3,\n    \"models\": null\n  },\n  \"state\": {}\n}"
    );
}

#[tokio::test]
async fn auto_settings_rejects() {
    let x = new_auto_env().await;
    for b in [
        r#"{"threshold":49.9}"#,
        r#"{"threshold":100.1}"#,
        r#"{"weeklyThreshold":40}"#,
        r#"{"intervalSeconds":14}"#,
        r#"{"intervalSeconds":3601}"#,
        r#"{"cooldownSeconds":-1}"#,
        r#"{"cooldownSeconds":86401}"#,
        r#"{"hysteresisPct":51}"#,
        r#"{"strategy":"random"}"#,
        r#"{"unhealthyTicks":0}"#,
        r#"{"unhealthyTicks":101}"#,
        r#"{"models":"some"}"#,
        r#"{"models":[""]}"#,
        r#"{"foo":1}"#,
        r#"{"enabled":"yes"}"#,
        "not json",
        r#"{"intervalSeconds":1.5}"#,
    ] {
        assert!(
            x.auto.put(b.as_bytes()).unwrap_err().is(Sentinel::Invalid),
            "{b}"
        );
    }
    assert_eq!(
        x.auto.put(br#"{"foo":1}"#).unwrap_err().to_string(),
        "값이 범위를 벗어났습니다: 모르는 키 \"foo\""
    );
    assert_eq!(
        x.auto.put(br#"{"threshold":1}"#).unwrap_err().to_string(),
        "값이 범위를 벗어났습니다"
    );
    assert_eq!(
        x.auto.view().settings.threshold,
        90.0,
        "rejected put changes nothing"
    );
}

#[test]
fn line_headroom_table() {
    for (pct, line, scale, want) in [
        (80.0, 90.0, 90.0, 20.0),
        (0.0, 97.0, 90.0, 100.0),
        (97.0, 97.0, 90.0, 10.0),
        (100.0, 97.0, 90.0, 0.0),
        (48.5, 97.0, 90.0, 55.0),
        (98.5, 97.0, 90.0, 5.0),
    ] {
        assert!(
            (line_headroom(pct, line, scale) - want).abs() < 1e-9,
            "{pct} {line}"
        );
    }
}

#[test]
fn binding_window_over_first() {
    let mut u = Usage {
        five_hour: Some(Window {
            pct: 85.0,
            resets_at: 0,
        }),
        seven_day: Some(Window {
            pct: 93.0,
            resets_at: 5,
        }),
        ..Usage::default()
    };
    let none = Some(HashSet::new());
    let b = binding_of(&u, &none, 90.0, Some(97.0), 90.0).unwrap();
    assert!(
        !b.over && b.line == 97.0 && b.resets_at == 5,
        "7d binds by line headroom"
    );
    u.five_hour.as_mut().unwrap().pct = 91.0;
    let b = binding_of(&u, &none, 90.0, Some(97.0), 90.0).unwrap();
    assert!(b.over && b.line == 90.0, "over-line window first");
}

#[test]
fn cswap_auto_running_cases() {
    let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    for (args, want) in [
        (v(&["/Users/u/.local/bin/cswap auto"]), true),
        (
            v(&["/opt/py/bin/python3 /Users/u/.local/bin/claude-swap auto --interval 60"]),
            true,
        ),
        (v(&["python3 -m claude_swap auto --once"]), true),
        (v(&["cswap auto --dry-run"]), false),
        (v(&["cswap list"]), false),
        (v(&["cswap menubar"]), false),
        (v(&["vim auto cswap"]), false),
        (v(&["/bin/zsh", "grep cswap auto"]), false),
        (vec![], false),
    ] {
        assert_eq!(cswap_auto_running(&args), want, "{args:?}");
    }
}

#[tokio::test]
async fn auto_enable_blocked_by_cswap_and_stops_when_found() {
    let x = new_auto_env().await;
    *x.procs.lock().unwrap() = vec!["/Users/u/.local/bin/cswap auto".into()];
    let err = x.auto.put(br#"{"enabled":true}"#).unwrap_err();
    assert!(err.is(Sentinel::CswapRunning));
    assert_eq!(
        err.to_string(),
        "cswap 자동 전환이 돌고 있습니다. 먼저 cswap auto 를 멈추세요"
    );
    assert!(!x.auto.view().settings.enabled);
    x.procs.lock().unwrap().clear();
    x.put(r#"{"enabled":true}"#);
    *x.procs.lock().unwrap() = vec!["/Users/u/.local/bin/cswap auto".into()];
    x.tick().await;
    assert!(
        !x.auto.view().settings.enabled && x.auto.view().state.status == AUTO_OFF,
        "stopped"
    );
    assert_eq!(x.kinds(), [ALERT_AUTOSWITCH_STOPPED]);
    let y = x.new_auto();
    y.load().unwrap();
    assert!(!y.view().settings.enabled, "off is persisted");
}

#[tokio::test]
async fn auto_below_line_best_does_nothing() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true}"#);
    let d = x.tick().await;
    assert!(x.active() == "id3" && x.auto.view().state.status == AUTO_ON);
    assert_eq!(d, Duration::from_secs(60));
    assert_eq!(x.auto.view().state.next_tick_at, NOW_UNIX + 60);
}

#[tokio::test]
async fn auto_disabled_does_not_switch() {
    let x = new_auto_env().await;
    x.put(r#"{"threshold":75}"#);
    assert!(x.tick().await >= Duration::from_secs(300), "idle delay");
    assert_eq!(x.active(), "id3");
}

#[tokio::test]
async fn auto_proactive_switches_and_records() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"threshold":75}"#);
    x.tick().await;
    assert_eq!(x.active(), "id1");
    let ls = x.auto.view().state.last_switch.unwrap();
    assert!(
        ls.from == "id3"
            && ls.to == "id1"
            && ls.trigger == TRIGGER_PROACTIVE
            && ls.left_headroom == Some(20.0)
            && ls.at == NOW_UNIX
    );
    let h = &read_history(&x.e.data, 1).unwrap()[0];
    assert!(h.by == BY_AUTO && h.trigger == TRIGGER_PROACTIVE);
    let al = x.alerts.lock().unwrap().clone();
    assert!(al.len() == 1 && al[0].kind == ALERT_AUTOSWITCH && al[0].trigger == TRIGGER_PROACTIVE);
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal(&al[0]).unwrap()).unwrap(),
        r#"{"kind":"autoswitch","from":"c***@","to":"a***@","trigger":"proactive"}"#
    );
    let v = String::from_utf8(dm_gocompat::json::marshal(&x.auto.view().state).unwrap()).unwrap();
    assert_eq!(
        v,
        format!(
            r#"{{"status":"on","lastSwitch":{{"at":{NOW_UNIX},"from":"id3","to":"id1","trigger":"proactive","leftHeadroom":20}},"quarantined":[],"nextTickAt":{}}}"#,
            NOW_UNIX + 60
        )
    );
}

#[tokio::test]
async fn auto_hysteresis_blocks() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"threshold":75,"hysteresisPct":50}"#);
    x.usage("id1", "at-a", r#"{"five_hour":{"utilization":31}}"#)
        .await;
    x.tick().await;
    assert_eq!(x.active(), "id3", "69-20 < 50");
}

#[tokio::test]
async fn auto_cooldown_blocks_proactive_not_at_limit() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"threshold":75}"#);
    x.tick().await;
    x.e.advance(70);
    x.usage("id1", "at-a", r#"{"five_hour":{"utilization":80}}"#)
        .await;
    x.usage("id2", "at-b", r#"{"five_hour":{"utilization":10}}"#)
        .await;
    x.tick().await;
    assert_eq!(x.active(), "id1", "cooldown blocks proactive");
    x.usage("id1", "at-a", r#"{"five_hour":{"utilization":100}}"#)
        .await;
    x.tick().await;
    assert_eq!(x.active(), "id2", "at-limit ignores cooldown");
    assert_eq!(x.last_trigger(), TRIGGER_AT_LIMIT);
}

#[tokio::test]
async fn auto_failover_after_unhealthy_ticks() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"unhealthyTicks":2}"#);
    x.api.status.lock().unwrap().insert("at-c".into(), 500);
    x.e.advance(600);
    x.tick().await;
    assert_eq!(x.active(), "id3", "first unknown tick waits");
    x.e.advance(61);
    x.tick().await;
    assert_eq!(x.active(), "id1");
    assert_eq!(x.last_trigger(), TRIGGER_FAILOVER);
}

#[tokio::test]
async fn auto_unmanaged() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"threshold":75}"#);
    x.e.login_cred("z@x.com", "org-z", "acc-z", &future_cred("at-z", "rt-z"));
    x.tick().await;
    assert_eq!(x.auto.view().state.status, AUTO_UNMANAGED);
    assert_eq!(x.active(), "id3");
}

#[tokio::test]
async fn auto_all_exhausted_sleeps() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true}"#);
    let soon = rfc3339(NOW_UNIX + 120);
    for (id, tok) in [("id1", "at-a"), ("id2", "at-b"), ("id3", "at-c")] {
        x.usage(
            id,
            tok,
            &format!(r#"{{"five_hour":{{"utilization":100,"resets_at":"{soon}"}}}}"#),
        )
        .await;
    }
    let d = x.tick().await;
    assert!(x.auto.view().state.status == AUTO_EXHAUSTED && x.active() == "id3");
    assert_eq!(d, Duration::from_secs(180), "earliest reset + 60");
}

#[tokio::test]
async fn auto_quarantine_on_permanent_refresh_failure() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"threshold":75}"#);
    let soon = format!(
        r#"{{"claudeAiOauth":{{"accessToken":"at-a","refreshToken":"rt-a","expiresAt":{}}}}}"#,
        (NOW_UNIX + 300) * 1000
    );
    x.e.svc
        .backup
        .write("id1", &Credential::parse(soon.as_bytes()).unwrap())
        .unwrap();
    x.api
        .refresh_err
        .lock()
        .unwrap()
        .insert("rt-a".into(), Sentinel::ReloginRequired);
    x.tick().await;
    assert_eq!(x.active(), "id2", "next candidate");
    assert_eq!(x.auto.view().state.quarantined, ["id1"]);
    x.e.svc
        .backup
        .write(
            "id1",
            &Credential::parse(future_cred("at-a2", "rt-a2").as_bytes()).unwrap(),
        )
        .unwrap();
    x.tick().await;
    assert!(x.auto.view().state.quarantined.is_empty(), "released");
}

#[tokio::test]
async fn auto_consume_first() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"strategy":"consume-first"}"#);
    let body = |days: i64| {
        format!(
            r#"{{"five_hour":{{"utilization":20}},"seven_day":{{"utilization":10,"resets_at":"{}"}}}}"#,
            rfc3339(NOW_UNIX + days * 86400)
        )
    };
    x.usage("id3", "at-c", &body(5)).await;
    x.usage("id1", "at-a", &body(6)).await;
    x.usage("id2", "at-b", &body(2)).await;
    x.tick().await;
    assert!(
        x.active() == "id2" && x.last_trigger() == TRIGGER_CONSUME_FIRST,
        "soonest weekly reset"
    );
}

#[tokio::test]
async fn auto_priority_consume_first() {
    let x = new_auto_env().await;
    x.e.svc
        .update(
            "id1",
            &Patch {
                priority: Some(5),
                ..Default::default()
            },
        )
        .unwrap();
    x.put(r#"{"enabled":true,"strategy":"priority-consume-first"}"#);
    x.tick().await;
    assert!(
        x.active() == "id1" && x.last_trigger() == TRIGGER_PRIORITY,
        "higher priority"
    );
    x.e.advance(3600);
    x.usage("id1", "at-a", r#"{"five_hour":{"utilization":30}}"#)
        .await;
    x.tick().await;
    assert_eq!(x.active(), "id1", "already on the highest priority");
}

#[tokio::test]
async fn auto_no_return_bar() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"threshold":75,"cooldownSeconds":0}"#);
    x.tick().await;
    x.e.svc
        .update(
            "id2",
            &Patch {
                disabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
    x.e.advance(70);
    x.usage("id1", "at-a", r#"{"five_hour":{"utilization":95}}"#)
        .await;
    x.usage("id3", "at-c", r#"{"five_hour":{"utilization":79}}"#)
        .await;
    x.tick().await;
    assert_eq!(
        x.active(),
        "id1",
        "id3 has not recovered (21 < 20+3) — barred"
    );
    x.e.advance(70);
    x.usage("id3", "at-c", r#"{"five_hour":{"utilization":60}}"#)
        .await;
    x.tick().await;
    assert_eq!(x.active(), "id3", "recovered → allowed back");
}

#[tokio::test]
async fn auto_ranges_source_of_validate() {
    let x = new_auto_env().await;
    let keys: Vec<&str> = AUTO_RANGES.keys().copied().collect();
    assert_eq!(
        keys,
        [
            "cooldownSeconds",
            "hysteresisPct",
            "intervalSeconds",
            "threshold",
            "unhealthyTicks",
            "weeklyThreshold"
        ]
    );
    for k in keys {
        let r = AUTO_RANGES[k];
        for v in [r.min, r.max] {
            assert!(
                x.auto.put(format!(r#"{{"{k}":{v}}}"#).as_bytes()).is_ok(),
                "{k}={v}"
            );
        }
        for v in [r.min - 1.0, r.max + 1.0] {
            assert!(
                x.auto
                    .put(format!(r#"{{"{k}":{v}}}"#).as_bytes())
                    .unwrap_err()
                    .is(Sentinel::Invalid),
                "{k}={v}"
            );
        }
    }
    let out = String::from_utf8(dm_gocompat::json::marshal(&x.auto.view()).unwrap()).unwrap();
    assert!(out.contains(r#""ranges":{"cooldownSeconds":{"min":0,"max":86400},"hysteresisPct":{"min":0,"max":50},"intervalSeconds":{"min":15,"max":3600},"threshold":{"min":50,"max":100},"unhealthyTicks":{"min":1,"max":100},"weeklyThreshold":{"min":50,"max":100}}"#), "{out}");
}

fn view(known: bool, h: f64, over: Option<bool>) -> AcctView {
    AcctView {
        known,
        h,
        has_b: over.is_some(),
        b: Binding {
            over: over.unwrap_or_default(),
            ..Binding::default()
        },
        ..AcctView::default()
    }
}

#[test]
fn auto_trigger_table() {
    let (over, at_limit, under, unknown) = (
        view(true, 5.0, Some(true)),
        view(true, 0.0, Some(true)),
        view(true, 40.0, Some(false)),
        view(false, 0.0, None),
    );
    let s = |st: &str| AutoSettings {
        strategy: st.into(),
        unhealthy_ticks: 3,
        ..AutoSettings::default()
    };
    let (best, consume, prio) = (
        s(AUTO_STRATEGY_BEST),
        s(AUTO_STRATEGY_CONSUME_FIRST),
        s(AUTO_STRATEGY_PRIORITY_CONSUME_FIRST),
    );
    for (name, a, st, u, want) in [
        ("소진", &at_limit, &best, 0, TRIGGER_AT_LIMIT),
        ("라인 넘음", &over, &best, 0, TRIGGER_PROACTIVE),
        (
            "라인 넘음이 전략보다 앞선다",
            &over,
            &consume,
            0,
            TRIGGER_PROACTIVE,
        ),
        ("best 는 라인 아래면 그대로", &under, &best, 0, ""),
        ("consume-first", &under, &consume, 0, TRIGGER_CONSUME_FIRST),
        ("priority-consume-first", &under, &prio, 0, TRIGGER_PRIORITY),
        ("모름 — 문턱 전", &unknown, &best, 2, ""),
        ("모름 — 문턱", &unknown, &best, 3, TRIGGER_FAILOVER),
    ] {
        assert_eq!(auto_trigger(a, st, u), want, "{name}");
    }
}

#[test]
fn auto_in_cooldown_table() {
    let last = LastSwitch {
        at: 1000,
        ..Default::default()
    };
    for (name, trig, l, now, want) in [
        ("쿨다운 안", TRIGGER_PROACTIVE, Some(&last), 1100, true),
        ("쿨다운 끝", TRIGGER_PROACTIVE, Some(&last), 1300, false),
        ("at-limit", TRIGGER_AT_LIMIT, Some(&last), 1100, false),
        ("failover", TRIGGER_FAILOVER, Some(&last), 1100, false),
        ("기록 없음", TRIGGER_CONSUME_FIRST, None, 1100, false),
    ] {
        assert_eq!(in_cooldown(trig, l, now, 300), want, "{name}");
    }
}

// --- engine_round_test (GD-8·23) ---

#[tokio::test]
async fn auto_tick_reads_accounts_once() {
    let x = new_auto_env().await;
    let before = x.e.svc.store.reads();
    x.tick().await;
    assert_eq!(
        x.e.svc.store.reads() - before,
        1,
        "자동 전환 회차(꺼짐)의 accounts.json 읽기 (GD-23)"
    );
}

#[tokio::test]
async fn auto_tick_caches_cswap_probe() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true}"#);
    for _ in 0..5 {
        x.tick().await;
        x.e.advance(CSWAP_PROBE_TTL.whole_seconds() / 10);
    }
    assert_eq!(
        *x.probes.lock().unwrap(),
        2,
        "켜기 + 켜진 회차 5번의 ps (GD-8)"
    );
    x.e.advance(CSWAP_PROBE_TTL.whole_seconds());
    x.tick().await;
    assert_eq!(*x.probes.lock().unwrap(), 3, "TTL 뒤");
}

#[tokio::test]
async fn auto_put_probes_fresh() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true}"#);
    x.tick().await;
    x.put(r#"{"enabled":false}"#);
    *x.procs.lock().unwrap() = vec!["/usr/bin/cswap auto".into()];
    assert!(
        x.auto
            .put(br#"{"enabled":true}"#)
            .unwrap_err()
            .is(Sentinel::CswapRunning)
    );
}

// --- statusline_merge_test 의 Auto ---

#[tokio::test]
async fn auto_switches_on_status_line_at_threshold_100() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"threshold":100}"#);
    let five = |p| Usage {
        five_hour: Some(Window {
            pct: p,
            resets_at: 0,
        }),
        ..Usage::default()
    };
    x.sl.lock()
        .unwrap()
        .insert("c@x.com".into(), (five(99.0), x.now()));
    x.tick().await;
    assert_eq!(x.active(), "id3", "99% under line 100 — stay");
    x.sl.lock()
        .unwrap()
        .insert("c@x.com".into(), (five(100.0), x.now()));
    x.tick().await;
    assert!(x.active() == "id1" && x.last_trigger() == TRIGGER_AT_LIMIT);
}

#[tokio::test]
async fn auto_proactive_from_status_line() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true}"#);
    x.sl.lock().unwrap().insert(
        "c@x.com".into(),
        (
            Usage {
                five_hour: Some(Window {
                    pct: 92.0,
                    resets_at: 0,
                }),
                ..Usage::default()
            },
            x.now(),
        ),
    );
    x.tick().await;
    assert!(
        x.active() == "id1" && x.last_trigger() == TRIGGER_PROACTIVE,
        "oauth 80 but statusLine 92 ≥ 90"
    );
}

#[tokio::test]
async fn threshold_range_up_to_100() {
    let x = new_auto_env().await;
    x.put(r#"{"threshold":100,"weeklyThreshold":100}"#);
    assert!(
        x.auto
            .put(br#"{"threshold":100.1}"#)
            .unwrap_err()
            .is(Sentinel::Invalid)
    );
}

// --- profile_test 의 Auto ---

#[tokio::test]
async fn auto_candidates_skip_pinned() {
    let x = new_auto_env().await;
    let st = x.e.svc.store.load().unwrap();
    let s = AutoSettings::default();
    assert_eq!(x.auto.candidates(&st, &s, &None).len(), 2);
    x.e.alive.lock().unwrap().push(42);
    write_session(&x.e.svc.profile_dir("id1"), 42);
    assert_eq!(x.auto.candidates(&st, &s, &None).len(), 1);
}

// --- alerts_test ---

#[test]
fn display_names() {
    let a = |email: &str, alias: &str| Account {
        email: email.into(),
        alias: alias.into(),
        ..Account::default()
    };
    assert_eq!(display_name(&a("abcdef@x.com", "")), "ab***@");
    assert_eq!(display_name(&a("a@x.com", "")), "a***@");
    assert_eq!(display_name(&a("abcdef@x.com", "work")), "work");
}

#[tokio::test]
async fn alert_near_limit_once_even_after_restart() {
    let mut x = new_auto_env().await;
    x.put(r#"{"threshold":75,"hysteresisPct":50}"#);
    let resets = rfc3339(NOW_UNIX + 3600);
    x.usage(
        "id3",
        "at-c",
        &format!(r#"{{"five_hour":{{"utilization":80,"resets_at":"{resets}"}}}}"#),
    )
    .await;
    x.usage("id1", "at-a", r#"{"five_hour":{"utilization":45}}"#)
        .await;
    x.tick().await;
    assert_eq!(x.kinds(), [ALERT_NEAR_LIMIT]);
    let a = x.alerts.lock().unwrap()[0].clone();
    assert!(a.name == "c***@" && a.window == "five_hour" && a.resets_at == NOW_UNIX + 3600);
    x.tick().await;
    assert_eq!(x.kinds().len(), 1, "suppressed");
    let y = x.new_auto();
    y.load().unwrap();
    x.auto = y;
    x.tick().await;
    assert_eq!(x.kinds().len(), 1, "suppressed after restart");
}

#[tokio::test]
async fn alert_near_limit_not_when_candidate_exists() {
    let x = new_auto_env().await;
    x.put(r#"{"threshold":75}"#);
    x.tick().await;
    assert!(x.kinds().is_empty());
}

#[tokio::test]
async fn alert_all_exhausted_with_reset_available() {
    let x = new_auto_env().await;
    for (id, tok) in [("id1", "at-a"), ("id2", "at-b"), ("id3", "at-c")] {
        x.usage(id, tok, r#"{"five_hour":{"utilization":100}}"#)
            .await;
    }
    let mut r = x.eng.rows()["id2"].clone();
    r.resets = Some(Resets {
        juniper: Some(JuniperStatus {
            eligible: true,
            available: true,
            ..Default::default()
        }),
        ..Default::default()
    });
    x.eng.set_row("id2", r);
    x.tick().await;
    let al = x.alerts.lock().unwrap().clone();
    assert!(
        al.iter()
            .any(|a| a.kind == ALERT_ALL_EXHAUSTED && a.reset_available)
    );
    let n = al.len();
    x.tick().await;
    assert_eq!(x.kinds().len(), n, "suppressed");
}

#[tokio::test]
async fn alert_all_exhausted_needs_every_value_known() {
    let x = new_auto_env().await;
    x.usage("id1", "at-a", r#"{"five_hour":{"utilization":100}}"#)
        .await;
    x.usage("id3", "at-c", r#"{"five_hour":{"utilization":100}}"#)
        .await;
    let mut r = x.eng.rows()["id2"].clone();
    r.fetched_at = NOW_UNIX - 3600;
    x.eng.set_row("id2", r);
    x.tick().await;
    assert!(!x.kinds().iter().any(|k| k == ALERT_ALL_EXHAUSTED));
}

#[tokio::test]
async fn alert_relogin_once_per_fingerprint() {
    let x = new_auto_env().await;
    let mut r = x.eng.rows()["id1"].clone();
    r.status = STATUS_RELOGIN_REQUIRED.into();
    r.auth_dead_fp = "fp1".into();
    x.eng.set_row("id1", r.clone());
    x.tick().await;
    x.tick().await;
    let al = x.alerts.lock().unwrap().clone();
    assert!(al.len() == 1 && al[0].kind == ALERT_RELOGIN && al[0].name == "a***@");
    r.auth_dead_fp = "fp2".into();
    x.eng.set_row("id1", r);
    x.tick().await;
    assert_eq!(x.kinds().len(), 2, "new fingerprint");
}

#[tokio::test]
async fn alert_login_expiring_daily() {
    let x = new_auto_env().await;
    let mut r = x.eng.rows()["id2"].clone();
    r.login_expires_at = NOW_UNIX + 6 * 86400;
    x.eng.set_row("id2", r.clone());
    x.tick().await;
    x.tick().await;
    let al = x.alerts.lock().unwrap().clone();
    assert!(
        al.len() == 1
            && al[0].kind == ALERT_LOGIN_EXPIRING
            && al[0].expires_at == NOW_UNIX + 6 * 86400
    );
    x.e.advance(86400);
    x.tick().await;
    let n = x
        .kinds()
        .iter()
        .filter(|k| *k == ALERT_LOGIN_EXPIRING)
        .count();
    assert_eq!(n, 2, "next day");
    r.login_expires_at = NOW_UNIX + 30 * 86400;
    x.eng.set_row("id2", r);
    x.e.advance(86400);
    x.tick().await;
    assert_eq!(x.kinds().len(), n, "far expiry");
}

#[tokio::test]
async fn alert_notified_keys_pruned_after_eight_days() {
    let x = new_auto_env().await;
    x.auto.lock().file_state().notified = BTreeMap::from([
        ("old".to_owned(), NOW_UNIX - 9 * 86400),
        ("new".to_owned(), NOW_UNIX - 86400),
    ]);
    x.tick().await;
    let mut g = x.auto.lock();
    let n = &g.file_state().notified;
    assert!(!n.contains_key("old") && n.contains_key("new"));
}

#[tokio::test]
async fn alert_bodies_carry_no_email_or_id() {
    let x = new_auto_env().await;
    x.put(r#"{"enabled":true,"threshold":75}"#);
    let mut r = x.eng.rows()["id2"].clone();
    r.status = STATUS_RELOGIN_REQUIRED.into();
    r.auth_dead_fp = "fp".into();
    r.login_expires_at = NOW_UNIX + 86400;
    x.eng.set_row("id2", r);
    x.tick().await;
    let al = x.alerts.lock().unwrap().clone();
    assert!(al.len() >= 2, "{:?}", x.kinds());
    let b = String::from_utf8(dm_gocompat::json::marshal(&al).unwrap()).unwrap();
    for bad in ["@x.com", "id1", "id2", "id3", "at-", "rt-"] {
        assert!(!b.contains(bad), "{bad} in {b}");
    }
}

#[test]
fn alert_text() {
    let a = |kind: &str| Alert {
        kind: kind.into(),
        ..Alert::default()
    };
    for (al, want) in [
        (
            Alert {
                from: "ab***@".into(),
                to: "work".into(),
                trigger: TRIGGER_PROACTIVE.into(),
                ..a(ALERT_AUTOSWITCH)
            },
            "Claude 계정 자동 전환: ab***@ → work (proactive)".to_owned(),
        ),
        (
            Alert {
                name: "work".into(),
                window: "five_hour".into(),
                ..a(ALERT_NEAR_LIMIT)
            },
            "Claude 계정 한도 임박: work 의 five_hour 창이 라인에 닿았고 전환할 계정이 없습니다"
                .into(),
        ),
        (
            a(ALERT_ALL_EXHAUSTED),
            "Claude 계정: 모든 계정의 한도가 찼습니다".into(),
        ),
        (
            Alert {
                reset_available: true,
                ..a(ALERT_ALL_EXHAUSTED)
            },
            "Claude 계정: 모든 계정의 한도가 찼습니다 — 쓸 수 있는 제한 초기화가 있습니다".into(),
        ),
        (
            Alert {
                name: "work".into(),
                ..a(ALERT_RELOGIN)
            },
            "Claude 계정 work: 다시 로그인해야 합니다".into(),
        ),
        (
            a(ALERT_AUTOSWITCH_STOPPED),
            "Claude 계정 자동 전환을 껐습니다 — cswap auto 가 돌고 있습니다".into(),
        ),
    ] {
        assert_eq!(al.text(), want);
    }
    let exp = Alert {
        name: "work".into(),
        expires_at: 1_800_000_000,
        ..a(ALERT_LOGIN_EXPIRING)
    }
    .text();
    assert!(
        exp.starts_with("Claude 계정 work: 로그인 만료가 가까워졌습니다 (20") && exp.ends_with(')'),
        "{exp}"
    );
    assert_eq!(a("unknown").text(), "");
}

// Go `time.Unix(sec, 0).Format("2006-01-02")` 를 Local 시간대로 본다.
#[test]
fn local_day_matches_go_layout() {
    use dm_gocompat::time::Zone;
    let at = 1_795_446_000; // 2026-11-23T15:00:00Z
    assert_eq!(crate::alerts::local_day_in(at, &Zone::utc()), "2026-11-23");
    assert_eq!(
        crate::alerts::local_day_in(at, &Zone::fixed("KST", 9 * 3600)),
        "2026-11-24"
    );
    assert_eq!(
        crate::alerts::local_day_in(-2_193_350_400, &Zone::fixed("X", -1)),
        "1900-06-30"
    );
}
