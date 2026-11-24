//! usage_test·resets_test·pace_test·policy_test·store_test(Validate·pickColor)·account_ranges_test.

use std::collections::BTreeMap;

use otter_gocompat::json;

use crate::error::{Error, HttpStatusError, Sentinel};
use crate::pace::WEEK_SECONDS;
use crate::policy::*;
use crate::resets::claim_result_of;
use crate::store::{PALETTE, pick_color};
use crate::usage::parse_resets_at;
use crate::*;

// TC-CAC-10: 사용량 응답 해석.
const USAGE_BODY: &str = r#"{
 "five_hour":{"utilization":34.5,"resets_at":"2026-11-13T12:00:00.5+00:00"},
 "seven_day":{"utilization":21,"resets_at":"2026-11-18T00:00:00Z"},
 "extra_usage":{"is_enabled":true,"used_credits":1240,"monthly_limit":5000,"utilization":24.8,"currency":"USD"},
 "limits":[
   {"scope":{"model":{"display_name":"Opus"}},"percent":40,"resets_at":"2026-11-18T00:00:00Z"},
   {"scope":{"model":{}},"percent":3},
   {"percent":5}
 ]}"#;

#[test]
fn parse_usage_reads_windows() {
    let u = parse_usage(USAGE_BODY.as_bytes()).unwrap();
    let five = u.five_hour.unwrap();
    assert_eq!((five.pct, five.resets_at), (34.5, 1_794_571_200));
    assert_eq!(u.seven_day.unwrap().pct, 21.0);
    assert_eq!(u.scoped.len(), 1);
    assert_eq!((u.scoped[0].name.as_str(), u.scoped[0].pct), ("Opus", 40.0));
    let sp = u.spend.clone().unwrap();
    assert_eq!(
        (sp.used, sp.limit, sp.pct, sp.currency.as_str()),
        (12.4, 50.0, 24.8, "USD")
    );
    // 관측 바이트: Go Usage 의 JSON.
    assert_eq!(
        String::from_utf8(json::marshal(&u).unwrap()).unwrap(),
        r#"{"fiveHour":{"pct":34.5,"resetsAt":1794571200},"sevenDay":{"pct":21,"resetsAt":1794960000},"scoped":[{"name":"Opus","pct":40,"resetsAt":1794960000}],"spend":{"used":12.4,"limit":50,"pct":24.8,"currency":"USD"}}"#
    );
}

#[test]
fn parse_usage_edges() {
    let u = parse_usage(
        br#"{"five_hour":{"utilization":10},"extra_usage":{"is_enabled":true,"used_credits":null,"monthly_limit":5000,"utilization":1}}"#,
    )
    .unwrap();
    assert!(u.five_hour.unwrap().resets_at == 0 && u.spend.is_none() && u.seven_day.is_none());
    for bad in ["<html>", "[]", "{}", r#"{"five_hour":{"utilization":"x"}}"#] {
        let e = parse_usage(bad.as_bytes()).unwrap_err();
        assert_eq!(e.to_string(), "사용량 응답을 읽을 수 없습니다", "{bad}");
    }
}

#[test]
fn usage_windows_and_headroom() {
    let u = parse_usage(USAGE_BODY.as_bytes()).unwrap();
    assert_eq!(u.headroom(&None), 100.0 - 40.0);
    assert_eq!(u.headroom(&Some(Default::default())), 100.0 - 34.5);
}

// TC-CAC-13·14 (FR-CAC-60a·61·63)
#[test]
fn parse_juniper_status() {
    let raw = br#"{"five_hour":{"utilization":1},"juniper_tide":{"eligible":true,"ineligible_reason":null,"available":false,"next_available_at":"2027-01-15T08:00:00Z","arm":"reset"}}"#;
    let j = parse_juniper(raw).unwrap();
    assert!(j.eligible && !j.available);
    assert_eq!(j.next_available_at, parse_resets_at("2027-01-15T08:00:00Z"));
    assert_ne!(j.next_available_at, 0);
    for bad in [
        "{}",
        r#"{"juniper_tide":null}"#,
        r#"{"juniper_tide":{"available":true}}"#,
        r#"{"juniper_tide":"x"}"#,
        "not json",
    ] {
        assert!(parse_juniper(bad.as_bytes()).is_none(), "{bad}");
    }
    let j = parse_juniper(br#"{"juniper_tide":{"eligible":false,"ineligible_reason":"tier"}}"#)
        .unwrap();
    assert!(!j.eligible && j.ineligible_reason == "tier" && !j.available);
}

#[test]
fn parse_cedar_status() {
    let raw = br#"{"cedar_ember":{"eligible":true,"at_limit":true,"exhausted":["five_hour","bogus"],
	 "weekly_resets_at":"2027-01-20T00:00:00Z","cooldown_until":null,"grants":[
	  {"id":"g_1","label":"Fable reset","resets_total":3,"resets_left":2,"ends_at":"2027-02-01T00:00:00Z",
	   "clears":["five_hour","seven_day","nope"],"usable_now":true,"percent_used":{"five_hour":100,"seven_day":140,"x":3},
	   "blocking":[],"gives_back_weekly":true},
	  {"id":"BAD ID","resets_left":1},
	  {"id":"g_2","resets_left":-1},
	  {"id":"g_3","resets_left":0,"paused":true}]}}"#;
    let c = parse_cedar(raw).unwrap();
    assert!(c.eligible && c.at_limit && c.weekly_resets_at != 0 && c.cooldown_until == 0);
    assert_eq!(c.exhausted, ["five_hour"]);
    assert_eq!(
        c.grants.iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
        ["g_1", "g_3"]
    );
    let g = &c.grants[0];
    assert!(g.label == "Fable reset" && g.resets_total == 3 && g.resets_left == 2);
    assert!(g.ends_at != 0 && g.usable_now && g.gives_back_weekly);
    assert_eq!(g.clears, ["five_hour", "seven_day"]);
    assert_eq!(
        g.percent_used,
        BTreeMap::from([("five_hour".to_owned(), 100)])
    );
    assert!(g.use_requires_limit, "use_requires_limit 가 없으면 true 다");
    assert!(c.grants[1].paused);
    for bad in [
        "{}",
        r#"{"cedar_ember":{"grants":[]}}"#,
        r#"{"cedar_ember":[]}"#,
    ] {
        assert!(parse_cedar(bad.as_bytes()).is_none(), "{bad}");
    }
    // 관측 바이트: Go Resets 의 JSON (FR-CAC-61).
    let r = Resets {
        juniper: None,
        cedar: Some(CedarStatus {
            grants: vec![c.grants[1].clone()],
            ..c.clone()
        }),
        fetched_at: 5,
    };
    assert_eq!(
        String::from_utf8(json::marshal(&r).unwrap()).unwrap(),
        format!(
            r#"{{"cedarEmber":{{"eligible":true,"atLimit":true,"exhausted":["five_hour"],"weeklyResetsAt":{},"grants":[{{"id":"g_3","label":"","resetsTotal":0,"resetsLeft":0,"clears":[],"paused":true,"usableNow":false,"useRequiresLimit":true,"blocking":[],"givesBackWeekly":false}}]}},"fetchedAt":5}}"#,
            c.weekly_resets_at
        )
    );
}

#[test]
fn resets_usable() {
    assert!(!Resets::usable(None));
    let j = |e, a| Resets {
        juniper: Some(JuniperStatus {
            eligible: e,
            available: a,
            ..Default::default()
        }),
        ..Default::default()
    };
    assert!(Resets::usable(Some(&j(true, true))));
    assert!(!Resets::usable(Some(&j(true, false))));
    let g = |left, now| Resets {
        cedar: Some(CedarStatus {
            eligible: true,
            grants: vec![CedarGrant {
                resets_left: left,
                usable_now: now,
                ..Default::default()
            }],
            ..Default::default()
        }),
        ..Default::default()
    };
    assert!(Resets::usable(Some(&g(1, true))));
    assert!(!Resets::usable(Some(&g(0, true))));
    assert!(!Resets::usable(Some(&g(1, false))));
}

#[test]
fn claim_result_mapping() {
    let t = parse_resets_at;
    let st = |s: u16| {
        Error::from(HttpStatusError {
            status: s,
            retry_after: String::new(),
        })
    };
    let ok = |r: &str| ClaimResult {
        result: r.into(),
        ..Default::default()
    };
    let cases: Vec<(&str, &str, &str, Option<Error>, ClaimResult)> = vec![
        (
            "juniper ok",
            PROGRAM_JUNIPER,
            r#"{"result":"reset","next_available_at":"2027-01-15T08:00:00Z"}"#,
            None,
            ClaimResult {
                next_available_at: t("2027-01-15T08:00:00Z"),
                ..ok("reset")
            },
        ),
        (
            "cedar ok",
            PROGRAM_CEDAR,
            r#"{"result":"reset","resets_left":1,"cleared":["five_hour","x"],"weekly_resets_at":"2027-01-20T00:00:00Z"}"#,
            None,
            ClaimResult {
                resets_left: Some(1),
                cleared: vec!["five_hour".into()],
                weekly_resets_at: t("2027-01-20T00:00:00Z"),
                ..ok("reset")
            },
        ),
        (
            "cedar cooldown",
            PROGRAM_CEDAR,
            r#"{"result":"cooldown","reason":"cooldown","cooldown_until":"2027-01-20T00:00:00Z"}"#,
            None,
            ClaimResult {
                reason: "cooldown".into(),
                cooldown_until: t("2027-01-20T00:00:00Z"),
                ..ok("cooldown")
            },
        ),
        (
            "juniper 는 cooldown 을 모른다",
            PROGRAM_JUNIPER,
            r#"{"result":"cooldown"}"#,
            None,
            ok("unavailable"),
        ),
        (
            "모르는 결과",
            PROGRAM_CEDAR,
            r#"{"result":"whatever"}"#,
            None,
            ok("unavailable"),
        ),
        (
            "읽을 수 없는 본문",
            PROGRAM_CEDAR,
            "nope",
            None,
            ok("error"),
        ),
        (
            "429",
            PROGRAM_JUNIPER,
            "",
            Some(st(429)),
            ok("rate_limited"),
        ),
        ("401", PROGRAM_JUNIPER, "", Some(st(401)), ok("auth_error")),
        ("403", PROGRAM_CEDAR, "", Some(st(403)), ok("auth_error")),
        ("500", PROGRAM_CEDAR, "", Some(st(500)), ok("error")),
        (
            "응답 없음",
            PROGRAM_CEDAR,
            "",
            Some(Error::new("timeout")),
            ok("unconfirmed"),
        ),
    ];
    for (name, program, body, err, want) in cases {
        assert_eq!(
            claim_result_of(program, body.as_bytes(), err.as_ref()),
            want,
            "{name}"
        );
    }
    assert_eq!(
        String::from_utf8(
            json::marshal(&ClaimResult {
                resets_left: Some(0),
                ..ok("reset")
            })
            .unwrap()
        )
        .unwrap(),
        r#"{"result":"reset","resetsLeft":0}"#
    );
}

// TC-CAC-13: cswap pace.py 와 같은 입력에 같은 출력.
#[test]
fn pace_suppressed_first_day() {
    let f = 1_000_000;
    assert!(compute_pace(30.0, f + (6.5 * 86400.0) as i64, f).is_none());
}

#[test]
fn pace_numbers() {
    let f = 1_000_000;
    let p = compute_pace(60.0, f + 4 * 86400, f).unwrap();
    assert_eq!(p.expected_pct, 42.9);
    assert!(p.ahead_of_pace);
    let rate: f64 = 60.0 / (3.0 * 86400.0);
    let want = f + (40.0 / rate).round() as i64;
    assert!((p.projected_exhaustion_at.unwrap() - want).abs() <= 1);
    assert!(!p.will_last_to_reset);
    assert_eq!(
        String::from_utf8(json::marshal(&p).unwrap()).unwrap(),
        format!(
            r#"{{"expectedPct":42.9,"aheadOfPace":true,"projectedExhaustionAt":{},"willLastToReset":false}}"#,
            p.projected_exhaustion_at.unwrap()
        )
    );
}

#[test]
fn pace_slow_and_full() {
    let f = 1_000_000;
    let p = compute_pace(20.0, f + 4 * 86400, f).unwrap();
    assert!(!p.ahead_of_pace && p.will_last_to_reset);
    let p = compute_pace(100.0, f + 4 * 86400, f).unwrap();
    assert_eq!(p.projected_exhaustion_at, Some(f));
    let p = compute_pace(0.0, f + 4 * 86400, f).unwrap();
    assert!(p.projected_exhaustion_at.is_none() && p.will_last_to_reset);
}

#[test]
fn pace_remaining_modulo_and_zero() {
    let f = 1_000_000;
    let a = compute_pace(50.0, f + WEEK_SECONDS + 4 * 86400, f).unwrap();
    let b = compute_pace(50.0, f + 4 * 86400, f).unwrap();
    assert_eq!(a.expected_pct, b.expected_pct);
    assert!(compute_pace(50.0, f, f).is_none());
}

// TC-CAC-11: 조회 주기와 물러나기 표. 흔들기는 0 으로 둔다.
fn usage_of(five: f64, seven: f64, r5: i64, r7: i64) -> Usage {
    Usage {
        five_hour: Some(Window {
            pct: five,
            resets_at: r5,
        }),
        seven_day: Some(Window {
            pct: seven,
            resets_at: r7,
        }),
        ..Usage::default()
    }
}

#[test]
fn plan_interval_movement() {
    let now = 10_000;
    let far = now + 100_000;
    let prev = usage_of(10.0, 10.0, far, far);
    let mut next = usage_of(12.0, 10.0, far, far);
    let mk = |next: &Usage, piv, active, prev: Option<&Usage>| {
        plan_interval(
            &PlanInput {
                now,
                prev_interval: piv,
                prev,
                next: Some(next),
                active,
                line: 90.0,
                last429: 0,
            },
            0.0,
        )
    };
    assert_eq!(mk(&next, 300, false, Some(&prev)), 180);
    next = usage_of(10.5, 10.0, far, far);
    assert_eq!(mk(&next, 300, false, Some(&prev)), 450);
    assert_eq!(mk(&next, 500, false, Some(&prev)), 600);
    assert_eq!(mk(&next, 500, true, Some(&prev)), 300);
    assert_eq!(mk(&next, 500, false, None), CANDIDATE_DEFAULT_S);
}

#[test]
fn plan_interval_urgent() {
    let now = 10_000;
    let far = now + 100_000;
    let (prev, next) = (
        usage_of(70.0, 10.0, far, far),
        usage_of(76.0, 10.0, far, far),
    );
    let mut inp = PlanInput {
        now,
        prev_interval: 300,
        prev: Some(&prev),
        next: Some(&next),
        active: true,
        line: 90.0,
        last429: 0,
    };
    assert_eq!(plan_interval(&inp, 0.0), URGENT_INTERVAL_S);
    inp.active = false;
    assert_ne!(plan_interval(&inp, 0.0), URGENT_INTERVAL_S);
}

#[test]
fn plan_interval_recent429_and_exhausted() {
    let now = 10_000;
    let far = now + 100_000;
    let (prev, next) = (
        usage_of(10.0, 10.0, far, far),
        usage_of(12.0, 10.0, far, far),
    );
    let mut inp = PlanInput {
        now,
        prev_interval: 300,
        prev: Some(&prev),
        next: Some(&next),
        active: false,
        line: 90.0,
        last429: now - 100,
    };
    assert_eq!(plan_interval(&inp, 0.0), 450);
    inp.prev_interval = 1500;
    assert_eq!(plan_interval(&inp, 0.0), 1800);
    let full = usage_of(100.0, 10.0, far, far);
    let inp = PlanInput {
        now,
        prev_interval: 180,
        prev: Some(&full),
        next: Some(&full),
        active: false,
        line: 90.0,
        last429: 0,
    };
    assert!(plan_interval(&inp, 0.0) >= EXHAUSTED_S);
    // 흔들기는 ±10%.
    let inp = PlanInput {
        now,
        prev_interval: 300,
        prev: Some(&prev),
        next: Some(&next),
        active: false,
        line: 90.0,
        last429: 0,
    };
    assert_eq!(
        (plan_interval(&inp, 1.0), plan_interval(&inp, -1.0)),
        (198, 162)
    );
}

#[test]
fn plan_next_capped_by_reset() {
    let now = 10_000;
    let u = usage_of(10.0, 10.0, now + 100, now + 100_000);
    let inp = PlanInput {
        now,
        prev_interval: 600,
        prev: Some(&u),
        next: Some(&u),
        active: false,
        line: 90.0,
        last429: 0,
    };
    assert_eq!(plan_next(&inp, 0.0), now + 100 + RESET_SLACK_S);
}

#[test]
fn backoff_table() {
    for (fails, status, ra, want) in [
        (1, 500, "", 30),
        (2, 500, "", 60),
        (6, 0, "", 600),
        (1, 429, "0", 300),
        (1, 429, "120", 120),
        (3, 429, "120", 120),
        (4, 429, "", 240),
        (1, 429, "700", 1600),
        (1, 429, "9999", 4500),
        (1, 503, "9999", 30),
        (1, 429, " 120 ", 120),
        (1, 429, "1.5", 30),
        (1, 429, "-3", 30),
    ] {
        assert_eq!(
            backoff_seconds(fails, status, ra),
            want,
            "{fails} {status} {ra:?}"
        );
    }
}

#[test]
fn validate_patch() {
    let bad = [
        Patch {
            alias: Some("가".repeat(25)),
            ..Default::default()
        },
        Patch {
            threshold: Some(49.9),
            ..Default::default()
        },
        Patch {
            threshold: Some(100.1),
            ..Default::default()
        },
        Patch {
            priority: Some(-1),
            ..Default::default()
        },
        Patch {
            priority: Some(1001),
            ..Default::default()
        },
        Patch {
            color: Some("red".into()),
            ..Default::default()
        },
    ];
    for (n, p) in bad.iter().enumerate() {
        assert!(p.validate().unwrap_err().is(Sentinel::Invalid), "case {n}");
    }
    assert_eq!(
        bad[5].validate().unwrap_err().to_string(),
        "값이 범위를 벗어났습니다: 알 수 없는 색 \"red\""
    );
    let good = Patch {
        alias: Some("가".repeat(24)),
        threshold: Some(100.0),
        priority: Some(1000),
        color: Some("acct-8".into()),
        ..Default::default()
    };
    good.validate().unwrap();
    Patch {
        threshold: Some(50.0),
        ..Default::default()
    }
    .validate()
    .unwrap();
    Patch {
        threshold: Some(1.0),
        clear_threshold: true,
        ..Default::default()
    }
    .validate()
    .unwrap();
}

#[test]
fn pick_color_order() {
    let used = [
        Account {
            color: "acct-1".into(),
            ..Default::default()
        },
        Account {
            color: "acct-2".into(),
            ..Default::default()
        },
    ];
    assert_eq!(pick_color(&used), "acct-3");
    let all: Vec<_> = PALETTE
        .iter()
        .map(|c| Account {
            color: (*c).into(),
            ..Default::default()
        })
        .collect();
    assert_eq!(pick_color(&all), "acct-1");
}

// REFACTOR3_FE_FIX_SRS TC-FFX-15 (FX-7)
#[test]
fn account_ranges_source_of_validate() {
    let want = BTreeMap::from([
        (
            "alias",
            AutoRange {
                min: 0.0,
                max: 24.0,
            },
        ),
        (
            "priority",
            AutoRange {
                min: 0.0,
                max: 1000.0,
            },
        ),
        (
            "threshold",
            AutoRange {
                min: 50.0,
                max: 100.0,
            },
        ),
    ]);
    assert_eq!(*ACCOUNT_RANGES, want);
    assert_eq!(
        String::from_utf8(json::marshal(&*ACCOUNT_RANGES).unwrap()).unwrap(),
        r#"{"alias":{"min":0,"max":24},"priority":{"min":0,"max":1000},"threshold":{"min":50,"max":100}}"#
    );
    let patch = |k: &str, v: f64| match k {
        "alias" => Patch {
            alias: Some("가".repeat(v as usize)),
            ..Default::default()
        },
        "threshold" => Patch {
            threshold: Some(v),
            ..Default::default()
        },
        _ => Patch {
            priority: Some(v as i64),
            ..Default::default()
        },
    };
    for (k, r) in ACCOUNT_RANGES.iter() {
        for v in [r.min, r.max] {
            patch(k, v).validate().unwrap();
        }
        let mut out = vec![r.max + 1.0];
        if *k != "alias" {
            out.push(r.min - 1.0);
        }
        for v in out {
            assert!(
                patch(k, v).validate().unwrap_err().is(Sentinel::Invalid),
                "{k}={v}"
            );
        }
    }
    for (k, msg) in [
        ("alias", "값이 범위를 벗어났습니다: 별칭은 24자 이하입니다"),
        (
            "threshold",
            "값이 범위를 벗어났습니다: 문턱값은 50~100.0 입니다",
        ),
        (
            "priority",
            "값이 범위를 벗어났습니다: 우선순위는 0~1000 입니다",
        ),
    ] {
        let e = patch(k, ACCOUNT_RANGES[k].max + 1.0)
            .validate()
            .unwrap_err();
        assert_eq!(e.to_string(), msg);
    }
}

#[test]
fn line_headroom_and_binding() {
    use crate::usage::{binding_of, line_headroom};
    assert_eq!(line_headroom(30.0, 90.0, 90.0), 70.0);
    assert_eq!(line_headroom(100.0, 100.0, 50.0), 0.0);
    assert_eq!(line_headroom(45.0, 90.0, 50.0), 75.0);
    assert_eq!(line_headroom(95.0, 90.0, 50.0), 25.0);
    let u = usage_of(80.0, 60.0, 1, 2);
    let b = binding_of(&u, &None, 90.0, Some(50.0), 50.0).unwrap();
    assert!(b.name == "seven_day" && b.over && b.line == 50.0);
    let b = binding_of(&u, &None, 90.0, None, 50.0).unwrap();
    assert!(b.name == "five_hour" && !b.over);
    assert!(binding_of(&Usage::default(), &None, 90.0, None, 50.0).is_none());
}
