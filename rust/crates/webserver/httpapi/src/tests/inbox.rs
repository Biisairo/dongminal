//! 에이전트 메시지의 전달 대기열 (AGENT_MSG_REWAKE_SRS 묶음 Q·H·S).

use std::time::Duration;

use super::attnenv::*;
use super::support::*;

const WAIT: &str = "/api/tools/inbox/wait";

fn env() -> Env {
    tracked(&["p1"])
}

async fn send(env: &Env, msg: &str) -> serde_json::Value {
    let r = post(
        &env.srv,
        "/api/tools/message",
        &format!(r#"{{"to":"p1","from":"p1","message":"{msg}"}}"#),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    r.json()
}

async fn activity(env: &Env, state: &str) {
    let r = post(
        &env.srv,
        "/api/tools/activity/set",
        &format!(r#"{{"toolId":"p1","state":"{state}","agent":"claude"}}"#),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
}

async fn state(env: &Env) -> String {
    let r = get(&env.srv, "/api/tools/activity/get?id=p1").await;
    r.json()["state"].as_str().unwrap_or_default().to_owned()
}

/// 훅 대기 하나를 띄운다. 끝나면 받은 메시지 목록을 돌려준다.
fn spawn_wait(env: &Env, session: &str) -> tokio::task::JoinHandle<Vec<String>> {
    let srv = env.srv.clone();
    let target = format!("{WAIT}?id=p1&session={session}");
    tokio::spawn(async move {
        let r = get(&srv, &target).await;
        assert_eq!(r.status, 200, "{}", r.body);
        messages(&r.json())
    })
}

fn messages(v: &serde_json::Value) -> Vec<String> {
    v["messages"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| m.as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// 아직 끝나지 않았음을 본다. 대기는 서버 안의 일이라 짧게 양보한 뒤 본다.
async fn pending(h: &tokio::task::JoinHandle<Vec<String>>) -> bool {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    !h.is_finished()
}

async fn now(env: &Env, session: &str) -> Vec<String> {
    let r = get(&env.srv, &format!("{WAIT}?id=p1&session={session}&now=1")).await;
    assert_eq!(r.status, 200, "{}", r.body);
    messages(&r.json())
}

// FR-AMW-1·3·7: 이 세션의 훅 대기를 본 적이 없으면 지금처럼 넣고 제출한다.
#[tokio::test]
async fn message_pastes_without_hook() {
    let env = env();
    let o = send(&env, "하나").await;
    assert_eq!(o["delivery"], "pasted");
    let pastes = env.io.pastes.lock().unwrap().clone();
    assert_eq!(pastes.len(), 1);
    assert_eq!(pastes[0].0, "p1");
    assert!(pastes[0].1.contains("하나"), "{pastes:?}");
    assert!(pastes[0].2, "제출한다");
}

// FR-AMW-2·4·12·14: 훅 대기가 있으면 대기열에 넣고, 쉬는 중이면 곧바로 그 대기에 건넨다.
#[tokio::test]
async fn message_queued_and_handed_to_waiting_hook() {
    let env = env();
    let w = spawn_wait(&env, "s1");
    assert!(pending(&w).await, "메시지 전에 끝났다");
    let o = send(&env, "하나").await;
    assert_eq!(o["delivery"], "queued");
    let got = w.await.unwrap();
    assert_eq!(got.len(), 1);
    assert!(
        got[0].starts_with("[OTTERMINAL-AGENT-MSG from=p1 to=p1 "),
        "{got:?}"
    );
    assert!(got[0].contains("하나"));
    assert!(
        env.io.pastes.lock().unwrap().is_empty(),
        "입력창을 건드렸다"
    );
}

// FR-AMW-12·13·17 · D-AMW-5: 일하는 중에는 건네지 않고, 턴이 끝나면 온 순서대로 한 번에 건넨다.
// 그때 상태는 done 이 아니라 working 이다.
#[tokio::test]
async fn working_holds_until_turn_ends() {
    let env = env();
    activity(&env, "working").await;
    let w = spawn_wait(&env, "s1");
    assert!(pending(&w).await);
    assert_eq!(send(&env, "하나").await["delivery"], "queued");
    assert_eq!(send(&env, "둘").await["delivery"], "queued");
    assert!(pending(&w).await, "일하는 중에 건넸다");
    activity(&env, "done").await;
    let got = w.await.unwrap();
    assert_eq!(got.len(), 2, "{got:?}");
    assert!(got[0].contains("하나") && got[1].contains("둘"), "{got:?}");
    assert_eq!(state(&env).await, "working", "D-AMW-5");
    // 깨어난 턴이 끝나면 그때 done 이다.
    activity(&env, "working").await;
    activity(&env, "done").await;
    assert_eq!(state(&env).await, "done");
}

// FR-AMW-17·18: 상태를 데몬이 판정해 추적기가 done 을 들고 있어도, 건넨 메시지의 깨어난 턴이 working 을
// 보고하기 전까지 status·wait 는 working 이다 (2026-11-27 실측: 추적기는 데몬의 done 을 거울로 받았다).
#[tokio::test]
async fn status_holds_working_even_if_tracker_says_done() {
    let env = env();
    activity(&env, "working").await;
    let w = spawn_wait(&env, "s1");
    assert!(pending(&w).await);
    assert_eq!(send(&env, "하나").await["delivery"], "queued");
    activity(&env, "done").await;
    assert_eq!(w.await.unwrap().len(), 1);
    // 데몬의 판정이 거울에 그대로 들어온 꼴이다.
    env.tr.set_activity("p1", "done", "", "");
    assert_eq!(
        state(&env).await,
        "working",
        "깨어난 턴 전에 done 으로 보였다"
    );
    let r = get(
        &env.srv,
        "/api/tools/activity/wait?id=p1&for=done&timeoutMs=300",
    )
    .await;
    assert_eq!(r.json()["status"], "timeout", "{}", r.body);
    // 깨어난 턴이 시작하고 끝나면 그때 done 이다.
    activity(&env, "working").await;
    activity(&env, "done").await;
    assert_eq!(state(&env).await, "done");
}

// FR-AMW-1·17·18: 깨운 뒤 다음 훅이 아직 없을 때(깨어난 턴) 온 메시지도 붙여넣지 않는다. 턴이
// 끝나면 상태는 working 으로 남고, 다음 훅 대기가 곧바로 받는다.
#[tokio::test]
async fn queued_without_waiter_goes_to_next_hook() {
    let env = env();
    assert!(now(&env, "s1").await.is_empty());
    activity(&env, "working").await;
    assert_eq!(send(&env, "하나").await["delivery"], "queued");
    activity(&env, "done").await;
    assert_eq!(state(&env).await, "working");
    let got = now(&env, "s1").await;
    assert_eq!(got.len(), 1, "{got:?}");
    assert!(env.io.pastes.lock().unwrap().is_empty());
}

// FR-AMW-12·25: 같은 탭의 새 훅 대기가 오면 앞의 대기는 빈 답으로 끝난다. now=1 은 기다리지 않는다.
#[tokio::test]
async fn newer_wait_supersedes_older() {
    let env = env();
    let old = spawn_wait(&env, "s1");
    assert!(pending(&old).await);
    let new = spawn_wait(&env, "s1");
    assert!(old.await.unwrap().is_empty());
    assert!(pending(&new).await);
    assert!(now(&env, "s1").await.is_empty(), "now=1 은 곧바로 빈 답");
    assert!(new.await.unwrap().is_empty(), "now=1 도 앞의 대기를 끝낸다");
}

// FR-AMW-5·6 · D-AMW-4: 세션이 끝나면 대기열을 버리고, 다음 메시지는 붙여넣는다.
#[tokio::test]
async fn session_end_drops_queue() {
    let env = env();
    assert!(now(&env, "s1").await.is_empty());
    activity(&env, "working").await;
    assert_eq!(send(&env, "하나").await["delivery"], "queued");
    activity(&env, "ended").await;
    assert_eq!(send(&env, "둘").await["delivery"], "pasted");
    let w = spawn_wait(&env, "s2");
    assert!(pending(&w).await, "버린 메시지를 건넸다");
}

// FR-AMW-5: 다른 세션의 훅 대기가 오면 앞 세션의 대기열을 버린다.
#[tokio::test]
async fn new_session_drops_queue() {
    let env = env();
    assert!(now(&env, "s1").await.is_empty());
    activity(&env, "working").await;
    assert_eq!(send(&env, "하나").await["delivery"], "queued");
    let w = spawn_wait(&env, "s2");
    assert!(pending(&w).await, "앞 세션의 메시지를 건넸다");
    // 새 세션의 SessionStart 는 idle 로 보고된다.
    activity(&env, "idle").await;
    assert_eq!(send(&env, "둘").await["delivery"], "queued");
    let got = w.await.unwrap();
    assert_eq!(got.len(), 1, "{got:?}");
    assert!(got[0].contains("둘"));
}

// FR-AMW-9 · D-AMW-6: 서버 알림도 같은 길을 지난다.
#[tokio::test]
async fn server_notice_uses_same_path() {
    let env = env();
    assert_eq!(env.srv.deliver_envelope("p1", "알림"), Ok("pasted"));
    assert!(now(&env, "s1").await.is_empty());
    assert_eq!(env.srv.deliver_envelope("p1", "알림"), Ok("queued"));
    assert_eq!(now(&env, "s1").await, vec!["알림".to_owned()]);
}

// 훅 대기 종단은 도구 식별자를 푼다. 모르는 도구는 404 류로 답한다.
#[tokio::test]
async fn wait_unknown_tool() {
    let env = env();
    let r = get(&env.srv, &format!("{WAIT}?id=nobody&session=s1&now=1")).await;
    assert_ne!(r.status, 200);
}
