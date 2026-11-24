//! smart_test (FR-CAC-31·110).

use std::sync::Arc;

use super::engine::{NOW_UNIX, three_accounts};
use crate::error::Sentinel;
use crate::*;

fn req(id: &str, strategy: &str, by: &str) -> SwitchRequest {
    SwitchRequest {
        id: id.into(),
        strategy: strategy.into(),
        by: by.into(),
    }
}

fn last_history(e: &super::service::Env, n: usize) -> Vec<HistoryEntry> {
    read_history(&e.data, n).unwrap()
}

#[tokio::test]
async fn switch_by_id_records_history() {
    let (e, eng, _) = three_accounts().await;
    let res = eng.switch(&req("id1", "", BY_OTTERCTL)).await.unwrap();
    assert_eq!((res.from.as_str(), res.to.as_str()), ("id3", "id1"));
    let h = last_history(&e, 10);
    assert_eq!(h.len(), 1);
    let x = &h[0];
    assert!(
        x.trigger == TRIGGER_MANUAL
            && x.by == BY_OTTERCTL
            && x.from == "id3"
            && x.to == "id1"
            && x.at == NOW_UNIX
    );
    assert_eq!((x.headroom_from, x.headroom_to), (Some(20.0), Some(70.0)));
    assert_eq!(eng.last_switch_at(), NOW_UNIX);
}

#[tokio::test]
async fn switch_by_defaults_and_rejects_by() {
    let (e, eng, _) = three_accounts().await;
    let err = eng.switch(&req("id1", "", "auto")).await.unwrap_err();
    assert_eq!(err.to_string(), "값이 범위를 벗어났습니다: by \"auto\"");
    assert!(
        eng.switch(&req("id1", "", "robot"))
            .await
            .unwrap_err()
            .is(Sentinel::Invalid)
    );
    assert!(
        eng.switch(&req("", "random", ""))
            .await
            .unwrap_err()
            .is(Sentinel::Invalid)
    );
    let err = eng.switch(&req("", "", "")).await.unwrap_err();
    assert_eq!(
        err.to_string(),
        "값이 범위를 벗어났습니다: id 또는 strategy 가 필요합니다"
    );
    eng.switch(&req("id1", "", "")).await.unwrap();
    let h = last_history(&e, 10);
    assert!(h.len() == 1 && h[0].by == BY_UI);
}

#[tokio::test]
async fn switch_noop_is_not_recorded() {
    let (e, eng, _) = three_accounts().await;
    assert!(eng.switch(&req("id3", "", "")).await.unwrap().no_op);
    assert!(last_history(&e, 10).is_empty());
}

#[tokio::test]
async fn switch_history_unknown_headroom_is_null() {
    let (e, eng, _) = three_accounts().await;
    e.advance(600);
    eng.switch(&req("id1", "", "")).await.unwrap();
    let h = last_history(&e, 10);
    assert!(h[0].headroom_from.is_none() && h[0].headroom_to.is_none());
    let line = std::fs::read_to_string(e.data.join("history.jsonl")).unwrap();
    assert!(
        line.contains(r#""headroomFrom":null,"headroomTo":null"#),
        "{line}"
    );
}

#[tokio::test]
async fn switch_next_records_strategy_trigger() {
    let (e, eng, _) = three_accounts().await;
    assert_eq!(
        eng.switch(&req("", STRATEGY_NEXT, "")).await.unwrap().to,
        "id1"
    );
    assert_eq!(last_history(&e, 10)[0].trigger, TRIGGER_NEXT);
}

#[tokio::test]
async fn next_available_skips_exhausted() {
    let (e, eng, api) = three_accounts().await;
    eng.switch(&req("id2", "", "")).await.unwrap();
    api.set_usage(
        "at-c",
        r#"{"five_hour":{"utilization":100},"seven_day":{"utilization":10}}"#,
    );
    e.advance(240);
    eng.fetch_now("id3").await.unwrap();
    assert_eq!(
        eng.switch(&req("", STRATEGY_NEXT_AVAILABLE, ""))
            .await
            .unwrap()
            .to,
        "id1"
    );
    assert_eq!(last_history(&e, 1)[0].trigger, TRIGGER_NEXT_AVAILABLE);
}

#[tokio::test]
async fn next_available_skips_unknown_without_refetching_backoff() {
    let (e, eng, api) = three_accounts().await;
    api.status.lock().unwrap().insert("at-a".into(), 500);
    e.advance(600);
    let before = api.count("usage:at-a");
    assert_eq!(
        eng.switch(&req("", STRATEGY_NEXT_AVAILABLE, ""))
            .await
            .unwrap()
            .to,
        "id2"
    );
    assert_eq!(api.count("usage:at-a"), before + 1, "one refresh attempt");
    let mut r = eng.rows()["id1"].clone();
    r.backoff_until = eng.now_unix() + 3600;
    eng.set_row("id1", r);
    e.advance(120);
    eng.switch(&req("", STRATEGY_NEXT_AVAILABLE, ""))
        .await
        .unwrap();
    assert_eq!(api.count("usage:at-a"), before + 1, "backoff → no refetch");
}

#[tokio::test]
async fn smart_refreshes_stale_first() {
    let (e, eng, api) = three_accounts().await;
    e.advance(600);
    api.set_usage("at-a", r#"{"five_hour":{"utilization":100}}"#);
    assert_eq!(
        eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap().to,
        "id2"
    );
    for t in ["usage:at-a", "usage:at-b", "usage:at-c"] {
        assert_eq!(api.count(t), 2, "each stale account fetched once more: {t}");
    }
}

#[tokio::test]
async fn smart_skips_recent_attempt_and_disabled_and_dead() {
    let (e, eng, api) = three_accounts().await;
    e.svc
        .update(
            "id2",
            &Patch {
                disabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
    let mut r = eng.rows()["id1"].clone();
    r.auth_dead_fp = "dead".into();
    eng.set_row("id1", r);
    e.advance(600);
    eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap();
    assert!(
        api.count("usage:at-a") == 1 && api.count("usage:at-b") == 1,
        "dead and disabled are not fetched"
    );
    assert_eq!(api.count("usage:at-c"), 2, "active is fetched");
}

#[tokio::test]
async fn best_picks_largest_headroom() {
    let (e, eng, _) = three_accounts().await;
    let res = eng
        .switch(&req("", STRATEGY_BEST, BY_OTTERCTL))
        .await
        .unwrap();
    assert!(res.to == "id1" && !res.no_op);
    let h = &last_history(&e, 1)[0];
    assert!(h.trigger == TRIGGER_BEST && h.by == BY_OTTERCTL);
}

#[tokio::test]
async fn best_tie_goes_to_earlier_in_order() {
    let (e, eng, api) = three_accounts().await;
    let a = api.usage.lock().unwrap()["at-a"].clone();
    api.set_usage("at-b", &a);
    e.advance(120);
    let _ = eng.fetch_now("id2").await;
    assert_eq!(
        eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap().to,
        "id1"
    );
}

#[tokio::test]
async fn best_reason_stay() {
    let (e, eng, _) = three_accounts().await;
    eng.switch(&req("id1", "", "")).await.unwrap();
    let res = eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap();
    assert!(res.no_op && res.reason == REASON_STAY && res.to == "id1");
    assert_eq!(last_history(&e, 10).len(), 1, "noop not recorded");
    assert_eq!(
        String::from_utf8(otter_gocompat::json::marshal(&res).unwrap()).unwrap(),
        r#"{"from":"id1","to":"id1","noop":true,"reason":"stay"}"#
    );
}

#[tokio::test]
async fn best_reason_current_unavailable() {
    let (e, eng, api) = three_accounts().await;
    api.status.lock().unwrap().insert("at-c".into(), 500);
    e.advance(600);
    let res = eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap();
    assert!(res.no_op && res.reason == REASON_CURRENT_UNAVAILABLE);
}

#[tokio::test]
async fn best_reason_no_comparison() {
    let (e, eng, api) = three_accounts().await;
    api.status
        .lock()
        .unwrap()
        .extend([("at-a".to_owned(), 500), ("at-b".to_owned(), 500)]);
    e.advance(600);
    let res = eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap();
    assert!(res.no_op && res.reason == REASON_NO_COMPARISON);
}

#[tokio::test]
async fn best_reason_exhausted() {
    let (e, eng, api) = three_accounts().await;
    for k in ["at-a", "at-b", "at-c"] {
        api.set_usage(k, r#"{"five_hour":{"utilization":100}}"#);
    }
    e.advance(600);
    let res = eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap();
    assert!(res.no_op && res.reason == REASON_EXHAUSTED);
}

#[tokio::test]
async fn best_reason_none() {
    let (e, eng, _) = three_accounts().await;
    for id in ["id1", "id2"] {
        e.svc
            .update(
                id,
                &Patch {
                    disabled: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    let res = eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap();
    assert!(res.no_op && res.reason == REASON_NONE);
}

#[tokio::test]
async fn next_available_no_candidate() {
    let (e, eng, api) = three_accounts().await;
    api.set_usage("at-a", r#"{"five_hour":{"utilization":100}}"#);
    api.set_usage("at-b", r#"{"five_hour":{"utilization":100}}"#);
    e.advance(600);
    let err = eng
        .switch(&req("", STRATEGY_NEXT_AVAILABLE, ""))
        .await
        .unwrap_err();
    assert!(err.is(Sentinel::NoCandidate));
}

async fn models_setup() -> (super::service::Env, Engine) {
    let (e, eng, api) = three_accounts().await;
    api.set_usage("at-a", r#"{"five_hour":{"utilization":30},"limits":[{"scope":{"model":{"display_name":"Fable"}},"percent":100}]}"#);
    e.advance(600);
    (e, eng)
}

#[tokio::test]
async fn smart_models_none() {
    let (_e, eng) = models_setup().await;
    assert_eq!(
        eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap().to,
        "id1"
    );
}

#[tokio::test]
async fn smart_models_all() {
    let (_e, mut eng) = models_setup().await;
    eng.models = Some(Arc::new(|| vec![MODELS_ALL.to_uppercase()]));
    assert_eq!(
        eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap().to,
        "id2"
    );
}

#[tokio::test]
async fn smart_models_named() {
    let (_e, mut eng) = models_setup().await;
    eng.models = Some(Arc::new(|| vec!["Sonnet".to_owned()]));
    assert_eq!(
        eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap().to,
        "id1"
    );
    eng.models = Some(Arc::new(|| vec!["Fable".to_owned()]));
    eng.switch(&req("id3", "", "")).await.unwrap();
    assert_eq!(
        eng.switch(&req("", STRATEGY_BEST, "")).await.unwrap().to,
        "id2"
    );
}
