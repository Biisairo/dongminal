//! statusline_merge_test(Auto 를 쓰지 않는 것)·view_test (FR-CAC-90~93).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use super::engine::three_accounts;
use crate::smart::merge_window;
use crate::usage::line_headroom;
use crate::*;

type SlMap = Arc<Mutex<HashMap<String, (Usage, i64)>>>;

fn with_status_line(eng: &mut Engine) -> SlMap {
    let m: SlMap = Arc::default();
    let m2 = m.clone();
    eng.status_line = Some(Arc::new(move |a: &Account| {
        m2.lock().unwrap().get(&a.email).cloned()
    }));
    m
}

fn win(pct: f64, resets_at: i64) -> Option<Window> {
    Some(Window { pct, resets_at })
}

fn five(pct: f64) -> Usage {
    Usage {
        five_hour: win(pct, 0),
        ..Usage::default()
    }
}

fn none_models() -> Models {
    Some(HashSet::new())
}

fn account(eng: &Engine, id: &str) -> Account {
    let st = eng.svc.store.load().unwrap();
    st.accounts[st.find(id).unwrap()].clone()
}

#[test]
fn merge_window_cases() {
    let now = 1000;
    let cases = [
        ("both nil", None, None, None),
        ("oauth only", win(30.0, 5000), None, win(30.0, 5000)),
        ("sl only", None, win(40.0, 5000), win(40.0, 5000)),
        (
            "bigger wins",
            win(30.0, 5000),
            win(45.0, 5000),
            win(45.0, 5000),
        ),
        (
            "bigger wins oauth",
            win(50.0, 5000),
            win(45.0, 5100),
            win(50.0, 5000),
        ),
        (
            "reset passed dropped",
            win(90.0, 900),
            win(10.0, 0),
            win(10.0, 0),
        ),
        ("both reset passed", win(90.0, 900), win(80.0, 999), None),
        (
            "newer window wins",
            win(95.0, 2000),
            win(5.0, 20000),
            win(5.0, 20000),
        ),
        (
            "unknown reset keeps max",
            win(20.0, 0),
            win(25.0, 5000),
            win(25.0, 5000),
        ),
    ];
    for (name, o, s, want) in cases {
        assert_eq!(merge_window(o, s, now), want, "{name}");
    }
}

#[tokio::test]
async fn decision_uses_bigger_status_line() {
    let (_e, mut eng, _) = three_accounts().await;
    let sl = with_status_line(&mut eng);
    let now = eng.now_unix();
    sl.lock()
        .unwrap()
        .insert("c@x.com".into(), (five(95.0), now));
    let acc = account(&eng, "id3");
    assert_eq!(eng.fresh_headroom(&acc, &none_models()), Some(5.0));
    sl.lock()
        .unwrap()
        .insert("c@x.com".into(), (five(50.0), now));
    assert_eq!(eng.fresh_headroom(&acc, &none_models()), Some(20.0));
}

#[tokio::test]
async fn status_line_freshness_and_switch_grace() {
    let (e, mut eng, api) = three_accounts().await;
    let sl = with_status_line(&mut eng);
    let acc = account(&eng, "id3");
    let now = eng.now_unix();
    sl.lock()
        .unwrap()
        .insert("c@x.com".into(), (five(95.0), now - 301));
    assert_eq!(
        eng.fresh_headroom(&acc, &none_models()),
        Some(20.0),
        "old statusLine ignored"
    );
    e.advance(600);
    let now = eng.now_unix();
    sl.lock()
        .unwrap()
        .insert("c@x.com".into(), (five(60.0), now));
    assert_eq!(
        eng.fresh_headroom(&acc, &none_models()),
        Some(40.0),
        "statusLine alone is known"
    );
    api.set_usage("at-c", r#"{"five_hour":{"utilization":80}}"#);
    eng.switch(&SwitchRequest {
        id: "id1".into(),
        ..Default::default()
    })
    .await
    .unwrap();
    let a1 = account(&eng, "id1");
    sl.lock()
        .unwrap()
        .insert("a@x.com".into(), (five(99.0), now + 30));
    e.advance(40);
    assert_eq!(
        eng.fresh_headroom(&a1, &none_models()),
        None,
        "report within 60s after switch is ignored"
    );
    let now = eng.now_unix();
    sl.lock()
        .unwrap()
        .insert("a@x.com".into(), (five(99.0), now + 30));
    e.advance(40);
    assert_eq!(
        eng.fresh_headroom(&a1, &none_models()),
        Some(1.0),
        "after grace"
    );
}

#[test]
fn line_headroom_at_line_100() {
    for (pct, want) in [(0.0, 100.0), (50.0, 55.0), (99.0, 10.9), (100.0, 0.0)] {
        let got = line_headroom(pct, 100.0, 90.0);
        assert!((got - want).abs() < 1e-9, "{pct} → {got}");
    }
}

fn acct(id: &str, email: &str) -> Account {
    Account {
        id: id.into(),
        email: email.into(),
        ..Account::default()
    }
}

#[test]
fn build_views_basic() {
    let st = State {
        active_id: "b".into(),
        accounts: vec![acct("a", "a@x.com"), acct("b", "b@x.com")],
        ..State::default()
    };
    let now = 1_000_000;
    let u = Usage {
        five_hour: win(10.0, now + 3600),
        seven_day: win(60.0, now + 4 * 86400),
        scoped: vec![ScopedWindow {
            name: "Opus".into(),
            pct: 30.0,
            resets_at: now + 4 * 86400,
        }],
        spend: None,
    };
    let rows = BTreeMap::from([(
        "a".to_owned(),
        Row {
            last_good: Some(u),
            fetched_at: now - 400,
            status: STATUS_OK.into(),
            login_expires_at: now + 3 * 86400,
            next_poll_at: now + 10,
            ..Row::default()
        },
    )]);
    let vs = build_views(&st, &rows, now);
    assert!(vs.len() == 2 && vs[0].account.id == "a" && !vs[0].active && vs[1].active);
    let a = vs[0].usage.as_ref().unwrap();
    assert!(a.status == STATUS_OK && a.age_seconds == 400 && a.stale);
    assert!(a.pace.seven_day.is_some() && a.pace.scoped.contains_key("Opus"));
    assert!(a.login_expires_at == now + 3 * 86400 && a.login_expiring_soon);
    let b = vs[1].usage.as_ref().unwrap();
    assert!(
        b.status.is_empty() && b.windows.is_none(),
        "no row yet → empty usage view"
    );
    // 관측 바이트: Account 임베드 뒤에 active·usage, 빈 pace 는 {}.
    assert_eq!(
        String::from_utf8(otter_gocompat::json::marshal(&vs[1]).unwrap()).unwrap(),
        r#"{"id":"b","email":"b@x.com","accountUuid":"","organizationUuid":"","organizationName":"","addedAt":"0001-01-01T00:00:00Z","color":"","disabled":false,"priority":0,"active":true,"usage":{"pace":{}}}"#
    );
    let s = String::from_utf8(otter_gocompat::json::marshal(&vs[0].usage).unwrap()).unwrap();
    assert!(s.starts_with(r#"{"status":"ok","windows":{"fiveHour":{"pct":10,"resetsAt":1003600,"resetsInSec":3600,"level":""},"sevenDay":{"pct":60,"resetsAt":1345600,"resetsInSec":345600,"level":""},"scoped":[{"name":"Opus","pct":30,"resetsAt":1345600,"resetsInSec":345600,"level":""}]},"pace":{"sevenDay":{"#), "{s}");
    assert!(s.ends_with(r#""fetchedAt":999600,"ageSeconds":400,"stale":true,"nextPollAt":1000010,"loginExpiresAt":1259200,"loginExpiringSoon":true}"#), "{s}");
}

#[test]
fn build_views_window_levels() {
    let st = State {
        accounts: vec![acct("a", "")],
        ..State::default()
    };
    let now = 1_000_000;
    let u = Usage {
        five_hour: win(10.0, now + 3600),
        seven_day: win(75.0, now - 5),
        scoped: vec![ScopedWindow {
            name: "Opus".into(),
            pct: 95.0,
            resets_at: 0,
        }],
        spend: Some(Spend {
            used: 12.4,
            limit: 50.0,
            pct: 24.8,
            currency: "USD".into(),
        }),
    };
    let vs = build_views(
        &st,
        &BTreeMap::from([(
            "a".to_owned(),
            Row {
                last_good: Some(u),
                fetched_at: now,
                ..Row::default()
            },
        )]),
        now,
    );
    let w = vs[0].usage.as_ref().unwrap().windows.clone().unwrap();
    let f = w.five_hour.unwrap();
    assert!(f.pct == 10.0 && f.level.is_empty() && f.resets_in_sec == Some(3600));
    let s7 = w.seven_day.unwrap();
    assert!(
        s7.level == "warn" && s7.resets_in_sec == Some(0),
        "지난 초기화는 0 이다"
    );
    let sc = &w.scoped[0];
    assert!(sc.name == "Opus" && sc.level == "critical" && sc.resets_in_sec.is_none());
    let sp = w.spend.unwrap();
    assert!(sp.used == 12.4 && sp.currency == "USD");
}

#[test]
fn usage_level_bounds() {
    for (pct, want) in [
        (0.0, ""),
        (69.9, ""),
        (70.0, "warn"),
        (89.9, "warn"),
        (90.0, "critical"),
        (120.0, "critical"),
    ] {
        assert_eq!(usage_level(pct), want, "{pct}");
    }
}

#[test]
fn build_views_resets() {
    let st = State {
        accounts: vec![acct("a", ""), acct("b", "")],
        ..State::default()
    };
    let rs = Resets {
        juniper: Some(JuniperStatus {
            eligible: true,
            available: true,
            ..Default::default()
        }),
        fetched_at: 5,
        ..Default::default()
    };
    let vs = build_views(
        &st,
        &BTreeMap::from([(
            "a".to_owned(),
            Row {
                resets: Some(rs.clone()),
                ..Row::default()
            },
        )]),
        10,
    );
    assert_eq!(vs[0].usage.as_ref().unwrap().resets, Some(rs));
    assert_eq!(vs[1].usage.as_ref().unwrap().resets, None);
}

#[test]
fn apply_status_line_cases() {
    let now = 1_000_000;
    let oauth = Usage {
        five_hour: win(20.0, now + 3600),
        seven_day: win(60.0, now + 4 * 86400),
        scoped: vec![ScopedWindow {
            name: "Opus".into(),
            pct: 30.0,
            resets_at: now + 4 * 86400,
        }],
        spend: None,
    };
    let build = |o: Option<&Usage>| {
        let mut rows = BTreeMap::new();
        if let Some(o) = o {
            rows.insert(
                "a".to_owned(),
                Row {
                    last_good: Some(o.clone()),
                    fetched_at: now - 600,
                    ..Row::default()
                },
            );
        }
        build_views(
            &State {
                accounts: vec![acct("a", "")],
                ..State::default()
            },
            &rows,
            now,
        )
        .remove(0)
    };
    let sl = Usage {
        five_hour: win(35.0, now + 3600),
        seven_day: win(50.0, now + 4 * 86400),
        ..Usage::default()
    };
    let windows = |v: &AccountView| v.usage.as_ref().unwrap().windows.clone().unwrap();
    let mut v = build(Some(&oauth));
    v.apply_status_line(Some(&oauth), &sl, now - 900, 0, now);
    let w = windows(&v);
    assert!(
        w.five_hour.as_ref().unwrap().pct == 35.0
            && w.five_hour.as_ref().unwrap().level.is_empty()
            && w.seven_day.as_ref().unwrap().pct == 60.0
    );
    assert!(
        w.scoped.len() == 1 && w.scoped[0].pct == 30.0,
        "scoped 는 OAuth 그대로"
    );
    let slv = v.status_line.clone().unwrap();
    assert!(slv.windows.five_hour.as_ref().unwrap().pct == 35.0 && slv.stale);
    assert_eq!(
        String::from_utf8(otter_gocompat::json::marshal(&slv).unwrap()).unwrap(),
        r#"{"windows":{"fiveHour":{"pct":35,"resetsAt":1003600,"resetsInSec":3600,"level":""},"sevenDay":{"pct":50,"resetsAt":1345600,"resetsInSec":345600,"level":""}},"observedAt":999100,"ageSeconds":900,"stale":true}"#
    );
    let mut v = build(Some(&oauth));
    v.apply_status_line(
        Some(&oauth),
        &Usage {
            five_hour: win(2.0, now + 3600 + 5 * 3600),
            ..Usage::default()
        },
        now - 10,
        0,
        now,
    );
    let w = windows(&v);
    assert!(
        w.five_hour.unwrap().pct == 2.0 && w.seven_day.unwrap().pct == 60.0,
        "새 창"
    );
    let mut v = build(Some(&oauth));
    v.apply_status_line(Some(&oauth), &sl, now - 30, now - 50, now);
    assert!(
        windows(&v).five_hour.unwrap().pct == 20.0 && v.status_line.is_some(),
        "전환 직후"
    );
    let mut v = build(None);
    v.apply_status_line(None, &sl, now - 10, 0, now);
    let w = windows(&v);
    assert!(
        w.five_hour.unwrap().pct == 35.0 && w.seven_day.unwrap().pct == 50.0,
        "OAuth 없음"
    );
    let mut v = build(Some(&oauth));
    v.apply_status_line(
        Some(&oauth),
        &Usage {
            five_hour: win(99.0, now - 1),
            ..Usage::default()
        },
        now - 10,
        0,
        now,
    );
    assert_eq!(windows(&v).five_hour.unwrap().pct, 20.0, "지난 창");
}

#[test]
fn masked_names() {
    assert_eq!(masked_name("abcdef@x.com"), "ab***@");
    assert_eq!(masked_name("가나다@x.com"), "가나***@");
    assert_eq!(masked_name("a@x.com"), "a***@");
}
