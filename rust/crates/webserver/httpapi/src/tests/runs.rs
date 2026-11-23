//! Run 오케스트레이션의 관측 동작 (Go `handlers_runs*_test.go` 중 골든이 닿지 않는 갈래).
//! 고정 장치는 `golden_554` 의 것과 같다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dm_shared_toolhub::ShellState;
use dm_webserver_domain_run::{self as run, ContextObservation, ContextPolicy};
use dm_webserver_seam_toolaccess::WorkspaceEntry;
use serde_json::Value;

use super::golden_554::{RunEnv, run_env, run_env_with};
use super::support::*;
use crate::runs::member_state_from;
use crate::runs_recover::*;

async fn post(env: &RunEnv, target: &str, body: &str) -> (u16, Value) {
    let r = call(
        &env.srv,
        "POST",
        target,
        &[("Content-Type", "application/json")],
        body,
        LOCAL,
    )
    .await;
    (
        r.status,
        serde_json::from_str(&r.body).unwrap_or(Value::Null),
    )
}

async fn get_json(env: &RunEnv, target: &str) -> (u16, Value) {
    let r = get(&env.srv, target).await;
    (
        r.status,
        serde_json::from_str(&r.body).unwrap_or(Value::Null),
    )
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}

async fn start(env: &RunEnv, coord: &str) -> String {
    let (code, out) = post(
        env,
        "/api/runs",
        &format!(r#"{{"objective":"o","projection":"dedicated-window","windowId":"win-1","toolId":"{coord}"}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    s(&out["id"])
}

async fn add_member(env: &RunEnv, run_id: &str, role: &str, at: &str) -> String {
    let (code, out) = post(
        env,
        "/api/runs/members",
        &format!(r#"{{"runId":"{run_id}","role":"{role}","agent":"claude","id":"{at}"}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    s(&out["id"])
}

fn run_changed(env: &RunEnv) -> usize {
    env.cmds
        .published()
        .iter()
        .filter(|p| p.contains(r#""action":"run_changed""#))
        .count()
}

fn pastes(env: &RunEnv) -> Vec<(String, bool, String)> {
    env.io.pastes.lock().unwrap().clone()
}

/// 블로킹 몸을 가진 서버 메서드를 시험에서 부른다.
async fn blocking<T: Send + 'static>(
    env: &RunEnv,
    f: impl FnOnce(&crate::Server) -> T + Send + 'static,
) -> T {
    let srv = env.srv.clone();
    tokio::task::spawn_blocking(move || f(&srv)).await.unwrap()
}

#[test]
fn member_state_from_table() {
    use dm_shared_activity as a;
    let cases: &[(&str, &str, bool, &str, bool, &str)] = &[
        (
            "쉬는 중간 노드",
            "",
            true,
            a::IDLE,
            true,
            run::WAITING_CHILDREN,
        ),
        (
            "턴을 끝낸 중간 노드",
            "",
            true,
            a::DONE,
            true,
            run::WAITING_CHILDREN,
        ),
        ("일하는 중간 노드", "", true, a::WORKING, true, run::WORKING),
        ("묻는 중간 노드", "", true, a::WAITING, true, run::WAITING),
        ("쉬는 잎", "", true, a::IDLE, false, run::READY),
        ("죽은 중간 노드", "", false, a::IDLE, true, run::LOST),
        ("보고한 노드", run::DONE, true, a::IDLE, true, run::DONE),
        ("보고 없음", "", true, "", true, run::STARTING),
        (
            "승계로 넘긴 노드",
            run::SUCCEEDED,
            false,
            "",
            false,
            run::SUCCEEDED,
        ),
        (
            "승계로 넘긴 살아 있는 노드",
            run::SUCCEEDED,
            true,
            a::IDLE,
            false,
            run::SUCCEEDED,
        ),
    ];
    for (name, rec, live, hook, kids, want) in cases {
        assert_eq!(member_state_from(rec, *live, hook, *kids), *want, "{name}");
    }
}

#[test]
fn recover_static_table() {
    let ok = RecoverTarget {
        tool_id: "T".into(),
        agent: "claude".into(),
        session_id: "S".into(),
        ..RecoverTarget::default()
    };
    let with = |f: &dyn Fn(&mut RecoverTarget)| {
        let mut c = ok.clone();
        f(&mut c);
        c
    };
    let cases: Vec<(&str, RecoverTarget, bool, &str)> = vec![
        (
            "끝난 멤버",
            with(&|c| {
                c.ended = true;
                c.tool_id.clear()
            }),
            true,
            REASON_ENDED,
        ),
        (
            "도구 id 없음",
            with(&|c| {
                c.tool_id.clear();
                c.agent.clear()
            }),
            true,
            REASON_NO_TOOL,
        ),
        ("도구 죽음", ok.clone(), false, REASON_NO_TOOL),
        (
            "에이전트 모름",
            with(&|c| {
                c.agent.clear();
                c.session_id.clear()
            }),
            true,
            REASON_NO_AGENT,
        ),
        (
            "등록부에 없는 에이전트",
            with(&|c| c.agent = "없는것".into()),
            true,
            REASON_NO_RESUME,
        ),
        (
            "재개 미확인(codex)",
            with(&|c| {
                c.agent = "codex".into();
                c.session_id.clear()
            }),
            true,
            REASON_NO_RESUME,
        ),
        (
            "세션 없음",
            with(&|c| c.session_id.clear()),
            true,
            REASON_NO_SESSION,
        ),
        (
            "세션 형식",
            with(&|c| c.session_id = "a;b".into()),
            true,
            REASON_BAD_SESSION,
        ),
        ("통과", ok.clone(), true, ""),
    ];
    for (name, t, live, want) in cases {
        let got = recover_static(&t, live).err().unwrap_or("");
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn recover_dynamic_table() {
    use ShellState::*;
    let cases = [
        ("등록부 모름", false, Idle, false, REASON_UNKNOWN, true),
        ("셸 모름", true, Unknown, false, REASON_UNKNOWN, true),
        (
            "이 셸에서 돈다",
            true,
            Here,
            false,
            REASON_RUNNING_HERE,
            false,
        ),
        (
            "다른 곳에서 돈다",
            true,
            Elsewhere,
            false,
            REASON_RUNNING_ELSEWHERE,
            false,
        ),
        ("셸 점유", true, Busy, false, REASON_BUSY, false),
        ("빈 셸", true, Idle, false, "", false),
        ("강제 + 셸 모름", true, Unknown, true, "", false),
        ("강제 + 등록부 모름 + 빈 셸", false, Idle, true, "", false),
        (
            "강제여도 점유는 건너뜀",
            false,
            Busy,
            true,
            REASON_BUSY,
            false,
        ),
        (
            "강제여도 이 셸에서 돌면 건너뜀",
            true,
            Here,
            true,
            REASON_RUNNING_HERE,
            false,
        ),
        (
            "강제여도 다른 곳에서 돌면 건너뜀",
            true,
            Elsewhere,
            true,
            REASON_RUNNING_ELSEWHERE,
            false,
        ),
    ];
    for (name, reg, shell, force, want, nf) in cases {
        assert_eq!(recover_dynamic(reg, shell, force), (want, nf), "{name}");
    }
}

type Probed = Arc<Mutex<HashMap<String, Option<Vec<i64>>>>>;

/// Go `newRecoverFixture`: 조정자 tool-a, 멤버 c·b·e. 세션 등록부는 임시 폴더다.
fn recover_env(shell: HashMap<&'static str, ShellState>) -> (RunEnv, Probed, tempfile::TempDir) {
    let reg = tempfile::tempdir().unwrap();
    let probed: Probed = Arc::default();
    let (p, dir) = (probed.clone(), reg.path().to_path_buf());
    let env = run_env_with(
        true,
        |_| {},
        move |srv| {
            srv.run_aux.recover_probe = Some(Box::new(move |id, pids| {
                p.lock()
                    .unwrap()
                    .insert(id.to_owned(), pids.map(<[i64]>::to_vec));
                shell.get(id).copied().unwrap_or(ShellState::Idle)
            }));
            srv.run_aux.recover_dirs = Some(Box::new(move || vec![dir.clone()]));
        },
    );
    (env, probed, reg)
}

async fn recover_run(env: &RunEnv) -> String {
    let id = start(env, "tool-a").await;
    for (role, tool) in [("c", "tool-c"), ("b", "tool-b"), ("e", "tool-e")] {
        add_member(env, &id, role, tool).await;
    }
    let st = env.store.clone().unwrap();
    let pol = ContextPolicy::default_policy();
    let obs = |sid: &str, agent: &str| ContextObservation {
        session_id: sid.into(),
        agent: agent.into(),
        ..ContextObservation::default()
    };
    st.observe_context("tool-a", &obs("coord-s", "claude"), pol);
    st.observe_context("tool-c", &obs("c-s", ""), pol);
    st.observe_context("tool-b", &obs("b-s", ""), pol);
    id
}

fn results_by_tool(out: &Value) -> HashMap<String, Value> {
    out["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (s(&r["toolId"]), r.clone()))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recover_run_wide_resumes_what_it_can_once() {
    let (env, probed, reg) = recover_env(HashMap::from([("tool-b", ShellState::Busy)]));
    let id = recover_run(&env).await;
    std::fs::create_dir_all(reg.path().join("sessions")).unwrap();
    std::fs::write(
        reg.path().join("sessions/4242.json"),
        r#"{"pid":4242,"sessionId":"c-s"}"#,
    )
    .unwrap();
    env.cmds.published.lock().unwrap().clear();

    let (code, out) = post(&env, "/api/runs/recover", &format!(r#"{{"runId":"{id}"}}"#)).await;
    assert_eq!(code, 200, "{out}");
    let got = results_by_tool(&out);
    assert_eq!(got.len(), 4, "{out}");
    assert_eq!(s(&got["tool-a"]["target"]), "coordinator");
    assert_eq!(s(&got["tool-a"]["outcome"]), "resumed");
    assert_eq!(s(&got["tool-c"]["outcome"]), "resumed");
    assert_eq!(probed.lock().unwrap()["tool-c"], Some(vec![4242]));
    assert_eq!(s(&got["tool-b"]["reason"]), REASON_BUSY);
    assert_eq!(s(&got["tool-e"]["reason"]), REASON_NO_SESSION);
    let p: HashMap<String, (bool, String)> = pastes(&env)
        .into_iter()
        .map(|(id, submit, text)| (id, (submit, text)))
        .collect();
    assert_eq!(p.len(), 2, "{p:?}");
    assert!(p.values().all(|(submit, _)| *submit));
    assert!(p["tool-a"].1.contains("--resume") && !p["tool-a"].1.contains("allowedTools"));
    assert!(p["tool-c"].1.contains("c-s") && p["tool-c"].1.contains("allowedTools"));
    assert_eq!(run_changed(&env), 1);

    // FR-RRC-18: 막 재개한 도구는 다시 넣지 않는다.
    let (_, out) = post(&env, "/api/runs/recover", &format!(r#"{{"runId":"{id}"}}"#)).await;
    let got = results_by_tool(&out);
    assert_eq!(s(&got["tool-a"]["reason"]), "recovering");
    assert_eq!(pastes(&env).len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recover_single_needs_force() {
    let (env, _, _reg) = recover_env(HashMap::from([("tool-c", ShellState::Unknown)]));
    let id = recover_run(&env).await;
    let m = env
        .store
        .as_ref()
        .unwrap()
        .member_by_tool("tool-c")
        .unwrap()
        .id;
    let body = format!(r#"{{"runId":"{id}","memberId":"{m}""#);
    let (_, out) = post(&env, "/api/runs/recover", &format!("{body}}}")).await;
    let got = results_by_tool(&out);
    assert_eq!(got.len(), 1);
    assert_eq!(s(&got["tool-c"]["reason"]), REASON_UNKNOWN);
    assert_eq!(got["tool-c"]["needsForce"], Value::Bool(true));
    let (_, out) = post(
        &env,
        "/api/runs/recover",
        &format!(r#"{body},"force":true}}"#),
    )
    .await;
    assert_eq!(s(&results_by_tool(&out)["tool-c"]["outcome"]), "resumed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_and_detach_follow_the_browser() {
    let env = run_env(true, |_| {});
    let id = start(&env, "tool-a").await;
    let (code, out) = post(
        &env,
        "/api/runs/members",
        &format!(r#"{{"runId":"{id}","role":"bg","agent":"claude","headless":true,"cwd":"/tmp"}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let (m, tool) = (s(&out["id"]), s(&out["toolId"]));
    assert_eq!(out.get("tabId"), None, "헤드리스 멤버는 탭이 없다: {out}");
    env.io.set_has(&tool, true);

    // 브라우저가 탭을 만든 것처럼 색인을 바꾼다.
    let idx = env.idx.clone();
    let t2 = tool.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        idx.entries.lock().unwrap().push(WorkspaceEntry {
            tool_id: t2,
            tab_uuid: "tab-new".into(),
            window_uuid: "win-1".into(),
            ..WorkspaceEntry::default()
        });
        idx.sig.notify();
    });
    let (code, out) = post(
        &env,
        "/api/runs/attach",
        &format!(r#"{{"memberId":"{m}","location":"tab-a"}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(s(&out["tabId"]), "tab-new");
    assert!(
        env.cmds
            .published()
            .iter()
            .any(|p| p.contains(r#""action":"restoreTool""#) && p.contains(r#""location":"tab-a""#))
    );
    let st = env.store.clone().unwrap();
    assert_eq!(st.find_member(&m).unwrap().1.tab_id, "tab-new");

    let idx = env.idx.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        idx.entries
            .lock()
            .unwrap()
            .retain(|e| e.tab_uuid != "tab-new");
        idx.sig.notify();
    });
    let (code, out) = post(
        &env,
        "/api/runs/detach",
        &format!(r#"{{"memberId":"{m}"}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out.get("tabId"), None);
    assert_eq!(st.find_member(&m).unwrap().1.tab_id, "");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attach_without_browser_or_tab_is_refused() {
    let env = run_env(true, |_| {});
    let id = start(&env, "tool-a").await;
    let (_, out) = post(
        &env,
        "/api/runs/members",
        &format!(r#"{{"runId":"{id}","role":"bg","agent":"claude","headless":true}}"#),
    )
    .await;
    let (m, tool) = (s(&out["id"]), s(&out["toolId"]));
    env.io.set_has(&tool, true);
    // 탭이 생기지 않는다 — 기록은 그대로다.
    let (code, out) = post(
        &env,
        "/api/runs/attach",
        &format!(r#"{{"memberId":"{m}"}}"#),
    )
    .await;
    assert_eq!(code, 504, "{out}");
    assert_eq!(
        env.store
            .as_ref()
            .unwrap()
            .find_member(&m)
            .unwrap()
            .1
            .tab_id,
        ""
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn succeed_waits_for_the_handoff_it_asked_for() {
    let env = run_env(true, |_| {});
    let id = start(&env, "tool-a").await;
    let m1 = add_member(&env, &id, "writer", "tab-b").await;
    let srv = env.srv.clone();
    let m = m1.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let r = call(
            &srv,
            "POST",
            "/api/runs/handoff",
            &[("Content-Type", "application/json")],
            &format!(r#"{{"memberId":"{m}","toolId":"tool-b","summary":"반쯤 했다"}}"#),
            LOCAL,
        )
        .await;
        assert_eq!(r.status, 200, "{}", r.body);
    });
    let (code, out) = post(
        &env,
        "/api/runs/succeed",
        &format!(r#"{{"memberId":"{m1}","at":"tab-c","timeoutMs":5000}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["hasSummary"], Value::Bool(true), "{out}");
    assert_eq!(s(&out["prevState"]), run::SUCCEEDED);
    assert!(s(&out["member"]["preamble"]).contains("반쯤 했다"));
    let asked = pastes(&env);
    assert!(
        asked
            .iter()
            .any(|(to, _, t)| to == "tool-b" && t.contains("[HANDOFF-REQUEST run=")),
        "{asked:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preamble_waits_for_a_late_handoff() {
    let env = run_env(true, |_| {});
    let id = start(&env, "tool-a").await;
    let m1 = add_member(&env, &id, "writer", "tab-b").await;
    let (code, out) = post(
        &env,
        "/api/runs/succeed",
        &format!(r#"{{"memberId":"{m1}","at":"tab-c","timeoutMs":1}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(out["hasSummary"], Value::Bool(false));
    let next = s(&out["member"]["id"]);
    let srv = env.srv.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        call(
            &srv,
            "POST",
            "/api/runs/handoff",
            &[("Content-Type", "application/json")],
            &format!(r#"{{"memberId":"{m1}","toolId":"tool-b","summary":"늦은 요약"}}"#),
            LOCAL,
        )
        .await;
    });
    let (code, out) = get_json(&env, &format!("/api/runs/preamble?member={next}")).await;
    assert_eq!(code, 200, "{out}");
    assert!(s(&out["preamble"]).contains("늦은 요약"), "{out}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reap_removes_runs_whose_coordinator_is_dead() {
    let env = run_env(true, |_| {});
    let gone = start(&env, "tool-d").await;
    let alive = start(&env, "tool-a").await;
    assert_eq!(blocking(&env, |s| s.reap_runs()).await, 1);
    let st = env.store.clone().unwrap();
    assert!(st.get(&gone).is_none());
    assert!(st.get(&alive).is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_asks_busy_agents_to_exit_and_closes_tabs() {
    let env = run_env(true, |_| {});
    let id = start(&env, "tool-a").await;
    add_member(&env, &id, "writer", "tab-b").await;
    env.hub.busy.lock().unwrap().insert("tool-b".into(), true);
    let hub = env.hub.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        hub.busy.lock().unwrap().insert("tool-b".into(), false);
    });
    let (code, out) = post(
        &env,
        "/api/runs/close",
        &format!(r#"{{"runId":"{id}","force":true}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert!(
        pastes(&env)
            .iter()
            .any(|(to, submit, t)| to == "tool-b" && *submit && t == "/exit")
    );
    let closed = out["closedTabs"].as_array().unwrap();
    let member = closed.iter().find(|c| c["tabId"] == "tab-b").unwrap();
    assert_eq!(member["exited"], Value::Bool(true));
    let empty: Vec<String> = closed
        .iter()
        .filter(|c| c["empty"] == Value::Bool(true))
        .map(|c| s(&c["tabId"]))
        .collect();
    assert_eq!(empty, ["tab-a", "tab-c", "tab-x"]);
    // 남은 것이 없으므로 레코드는 지워진다.
    assert!(env.store.as_ref().unwrap().get(&id).is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quiescence_follows_the_members_adapter() {
    let env = run_env(true, |_| {});
    let id = start(&env, "tool-a").await;
    add_member(&env, &id, "writer", "tab-b").await;
    let hooks = dm_shared_agentadapter::get("claude")
        .unwrap()
        .readiness
        .hooks;
    assert_eq!(env.srv.quiescence_allowed("tool-b"), !hooks);
    assert!(env.srv.quiescence_allowed("tool-c"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_report_feeds_the_run_context() {
    let env = run_env(true, |_| {});
    let id = start(&env, "tool-a").await;
    let m = add_member(&env, &id, "writer", "tab-b").await;
    let (code, out) = post(
        &env,
        "/api/tools/usage",
        r#"{"toolId":"tool-b","usage":{"sessionId":"s9","contextWindow":{"windowTokens":1000000,"currentUsage":{"inputTokens":1000,"cacheReadInputTokens":9000}}}}"#,
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let got = env.store.as_ref().unwrap().find_member(&m).unwrap().1;
    assert_eq!(got.context.context_tokens, 10_000);
    assert_eq!(got.context.session_id, "s9");
}

/// git 이 없으면 건너뛴다.
fn isolated_env() -> Option<(RunEnv, dm_shared_gittest::Repo, tempfile::TempDir)> {
    let repo = dm_shared_gittest::repo()?;
    let home = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(home.path())
        .unwrap()
        .join("worktrees");
    let mgr = dm_webserver_domain_worktree::Manager::new(&root.to_string_lossy());
    let env = run_env(true, move |d| d.worktrees = Some(Arc::new(mgr)));
    Some((env, repo, home))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn per_member_isolation_creates_and_cleans_worktrees() {
    let Some((env, repo, home)) = isolated_env() else {
        return;
    };
    let repo_path = repo.path().to_string_lossy().into_owned();
    let (code, out) = post(
        &env,
        "/api/runs",
        &format!(r#"{{"objective":"격리","projection":"inline","isolation":"per-member","cwd":"{repo_path}","toolId":"tool-a"}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    assert_eq!(s(&out["repo"]), repo_path);
    assert_eq!(s(&out["base"]), "main");
    let id = s(&out["id"]);
    let mut paths = Vec::new();
    for tab in ["tab-b", "tab-c"] {
        let (code, out) = post(
            &env,
            "/api/runs/members",
            &format!(r#"{{"runId":"{id}","role":"작가","agent":"claude","id":"{tab}"}}"#),
        )
        .await;
        assert_eq!(code, 200, "{out}");
        let path = s(&out["worktree"]["path"]);
        assert!(std::path::Path::new(&path).is_dir(), "{path}");
        assert!(
            path.starts_with(
                &*std::fs::canonicalize(home.path())
                    .unwrap()
                    .to_string_lossy()
            )
        );
        assert!(s(&out["preamble"]).contains(&path));
        assert!(!paths.contains(&path), "두 멤버가 같은 경로를 쓴다");
        paths.push(path);
    }
    let (code, out) = post(
        &env,
        "/api/runs/close",
        &format!(r#"{{"runId":"{id}","force":true}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let trees = out["worktrees"].as_array().unwrap();
    assert_eq!(trees.len(), 2, "{out}");
    assert!(
        trees.iter().all(|t| t["removed"] == Value::Bool(true)),
        "{out}"
    );
    assert!(paths.iter().all(|p| !std::path::Path::new(p).exists()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn per_run_isolation_shares_one_worktree() {
    let Some((env, repo, _home)) = isolated_env() else {
        return;
    };
    let repo_path = repo.path().to_string_lossy().into_owned();
    let (code, out) = post(
        &env,
        "/api/runs",
        &format!(r#"{{"objective":"공유","projection":"inline","isolation":"per-run","cwd":"{repo_path}","toolId":"tool-a"}}"#),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let shared = s(&out["worktree"]["path"]);
    assert!(std::path::Path::new(&shared).is_dir());
    let id = s(&out["id"]);
    let (_, out) = post(
        &env,
        "/api/runs/members",
        &format!(r#"{{"runId":"{id}","role":"w","agent":"claude","id":"tab-b"}}"#),
    )
    .await;
    assert_eq!(s(&out["worktree"]["path"]), shared);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn isolation_outside_a_repo_is_refused_and_leaves_no_record() {
    let Some((env, _repo, _home)) = isolated_env() else {
        return;
    };
    let plain = tempfile::tempdir().unwrap();
    let (code, out) = post(
        &env,
        "/api/runs",
        &format!(
            r#"{{"objective":"x","projection":"inline","isolation":"per-member","cwd":"{}"}}"#,
            plain.path().display()
        ),
    )
    .await;
    assert_eq!(code, 400, "{out}");
    assert_eq!(s(&out["error"]), "not_a_git_repo");
    assert!(env.store.as_ref().unwrap().list().is_empty());
}
