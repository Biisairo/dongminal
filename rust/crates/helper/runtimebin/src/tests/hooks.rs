//! 에이전트 훅(activity·agent-context·ctx-hook)과 statusLine 프록시의 시험. Go
//! `dmctl_activity*_test.go`·`dmctl_ctxhook_test.go`·`dmctl_statusline*_test.go`·
//! `dmctl_subagent_statusline_test.go`·`report_socket_test.go`·`hook_budget_test.go` 를 옮겼다.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dm_shared_agentrec as agentrec;
use dm_shared_apipath as apipath;
use dm_shared_dmenv as dmenv;
use serde_json::{Value, json};

#[cfg(unix)]
use super::Req;
use super::{TestServer, run_with};
use crate::budgets::HOOK_BUDGET;
use crate::ctx::{Ctx, Env};
use crate::dmctl::hooks::{
    USAGE_TAIL_MAX, run_dmctl_activity, run_dmctl_agent_context, run_dmctl_ctx_hook,
    transcript_size, transcript_usage,
};
use crate::dmctl::notify::report_notify_activity;
use crate::dmctl::statusline::{
    STATUS_LINE_KEY, SUBAGENT_STATUS_LINE_KEY, SlEnv, run_dmctl_statusline,
    run_dmctl_subagent_statusline, statusline_account, statusline_downstream,
    statusline_project_dir,
};

const CANARY: &str = "CANARY-SECRET-DO-NOT-TRANSMIT";

/// activity 와 컨텍스트 관측 두 종단을 함께 받는 가짜 서버다 (Go `startCapture`).
struct Capture {
    srv: TestServer,
    env: Env,
    _home: tempfile::TempDir,
}

impl Capture {
    fn new(tool: &str) -> Self {
        let home = tempfile::tempdir().unwrap();
        let srv = TestServer::fixed(200, r#"{"ok":true}"#);
        let mut env = srv.env(home.path());
        env.set(dmenv::ENV_TOOL_ID, tool);
        Self {
            srv,
            env,
            _home: home,
        }
    }
    fn split(&self) -> (Vec<String>, Vec<String>) {
        let (mut act, mut ctx) = (Vec::new(), Vec::new());
        for r in self.srv.requests() {
            let b = String::from_utf8_lossy(&r.body).into_owned();
            if r.path() == apipath::RUNS_CONTEXT {
                ctx.push(b);
            } else {
                act.push(b);
            }
        }
        (act, ctx)
    }
    fn activity(&self) -> Vec<String> {
        self.split().0
    }
    fn context(&self) -> Vec<String> {
        self.split().1
    }
    fn all(&self) -> String {
        let (a, c) = self.split();
        [a, c].concat().join("\n")
    }
    fn last_context(&self) -> Value {
        let c = self.context();
        serde_json::from_str(c.last().expect("컨텍스트 관측이 전송되지 않았다")).unwrap()
    }
    fn activity_json(&self) -> Vec<Value> {
        self.activity()
            .iter()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    fn activity_hook(&self, agent: &str, stdin: &str) -> (i32, String, String) {
        run_with(&self.env, run_dmctl_activity, &[agent], stdin.as_bytes())
    }
}

fn hook(v: Value) -> String {
    v.to_string()
}

fn write_transcript(dir: &Path, body: &str) -> String {
    let p = dir.join("transcript.jsonl");
    std::fs::write(&p, body).unwrap();
    p.to_string_lossy().into_owned()
}

fn assistant_line(model: &str, i: i64, w: i64, r: i64, o: i64, body: &str) -> String {
    format!(
        r#"{{"type":"assistant","message":{{"model":{},"content":[{{"type":"text","text":{}}}],"usage":{{"input_tokens":{i},"cache_creation_input_tokens":{w},"cache_read_input_tokens":{r},"output_tokens":{o}}}}}}}"#,
        Value::from(model),
        Value::from(body)
    )
}

fn claude() -> &'static dm_shared_agentadapter::Adapter {
    dm_shared_agentadapter::get("claude").unwrap()
}

// ---- activity ----

#[test]
fn activity_is_non_fatal() {
    let env = Env::with_vars([(dmenv::ENV_TOOL_ID, "")]);
    for (args, stdin) in [
        (&["claude"][..], r#"{"hook_event_name":"Stop"}"#),
        (&["claude"][..], "garbage"),
        (&[][..], ""),
    ] {
        let (code, out, _) = run_with(&env, run_dmctl_activity, args, stdin.as_bytes());
        assert_eq!((code, out.as_str()), (0, ""));
    }
}

#[test]
fn activity_unknown_agent_says_so_and_exits_zero() {
    let cap = Capture::new("7");
    let (code, out, err) = cap.activity_hook("nope", r#"{"hook_event_name":"Stop"}"#);
    assert_eq!(code, 0);
    assert_eq!(out, "");
    assert_eq!(
        err,
        "dmctl activity: unknown_agent: \"nope\" (알려진 것: claude, codex, omp)\n"
    );
    assert!(cap.srv.requests().is_empty());
}

#[test]
fn activity_help_is_derived_from_registry() {
    let env = Env::with_vars([(dmenv::ENV_TOOL_ID, "")]);
    let (code, out, _) = run_with(&env, run_dmctl_activity, &["claude", "-h"], b"");
    assert_eq!(code, 0);
    assert!(out.starts_with("dmctl activity <agent>\n"), "{out}");
    assert!(
        out.contains("  <agent>: claude | codex | omp. DONGMINAL_TOOL_ID"),
        "{out}"
    );
}

#[test]
fn activity_report_carries_agent_id() {
    let cap = Capture::new("7");
    assert_eq!(cap.activity_hook("omp", r#"{"event":"agent_end"}"#).0, 0);
    let body = cap.activity().join("\n");
    assert!(body.contains(r#""agent":"omp""#), "{body}");
}

#[test]
fn codex_activity_report_omits_agent_id() {
    let cap = Capture::new("7");
    let (mut out, mut err, mut inp) = (Vec::new(), Vec::new(), &b""[..]);
    let ctx = Ctx::new(&mut out, &mut err, &mut inp, &cap.env);
    report_notify_activity(
        &ctx,
        "codex",
        &[r#"{"type":"agent-turn-complete"}"#.to_owned()],
        "7",
    );
    let body = cap.activity().join("\n");
    assert!(!body.is_empty(), "codex 활동 보고가 아예 가지 않았다");
    assert!(!body.contains(r#""agent""#), "{body}");
}

#[test]
fn notify_activity_guards() {
    let cap = Capture::new("7");
    let (mut out, mut err, mut inp) = (Vec::new(), Vec::new(), &b""[..]);
    let ctx = Ctx::new(&mut out, &mut err, &mut inp, &cap.env);
    let args = [r#"{"type":"agent-turn-complete"}"#.to_owned()];
    report_notify_activity(&ctx, "done", &args, "");
    report_notify_activity(&ctx, "claude", &args, "p1");
    assert!(cap.srv.requests().is_empty());
}

#[test]
fn activity_report_carries_bridge_fields() {
    let cap = Capture::new("7");
    let payload = r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":"toolu_9","session_id":"s1","transcript_path":"/t/s1.jsonl","tool_input":{"questions":[{"question":"색?","options":[{"label":"red"}]}]}}"#;
    assert_eq!(cap.activity_hook("claude", payload).0, 0);
    let body = cap.activity().join("\n");
    for want in [
        r#""hook":"PreToolUse""#,
        r#""transcript":"/t/s1.jsonl""#,
        r#""input":{"questions":[{"question":"색?""#,
    ] {
        assert!(body.contains(want), "{want} 없음: {body}");
    }
    assert_eq!(
        body,
        r#"{"agent":"claude","detail":"","hook":"PreToolUse","input":{"questions":[{"question":"색?","options":[{"label":"red"}]}]},"sessionId":"s1","state":"working","tool":"AskUserQuestion","toolId":"7","transcript":"/t/s1.jsonl"}"#
    );
}

#[test]
fn activity_report_omits_empty_bridge_fields() {
    let cap = Capture::new("7");
    cap.activity_hook(
        "claude",
        r#"{"hook_event_name":"Stop","tool_use_id":"toolu_1","source":"startup"}"#,
    );
    let body = cap.activity().join("\n");
    assert!(body.contains(r#""hook":"Stop""#), "{body}");
    for no in [
        r#""toolUseId""#,
        r#""input""#,
        r#""inputOver""#,
        r#""source""#,
        r#""transcript""#,
    ] {
        assert!(!body.contains(no), "{no}: {body}");
    }
}

#[test]
fn report_context_sends_measured_tokens_and_model() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_transcript(
        dir.path(),
        &format!(
            "{{\"type\":\"user\",\"message\":{{\"content\":\"{CANARY}\"}}}}\n{}\n",
            assistant_line("claude-opus-5[1m]", 2, 100, 400000, 50, CANARY)
        ),
    );
    let cap = Capture::new("tool-1");
    let stdin = hook(
        json!({"hook_event_name": "PostToolUse", "tool_name": "Bash",
        "session_id": "s-1", "transcript_path": path}),
    );
    assert_eq!(cap.activity_hook("claude", &stdin).0, 0);
    assert!(!cap.all().contains(CANARY), "{}", cap.all());
    let got = cap.last_context();
    assert_eq!(got["tokens"], json!(400102));
    assert_eq!(got["model"], json!("claude-opus-5[1m]"));
}

#[test]
fn report_context_never_sends_transcript_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_transcript(
        dir.path(),
        &format!(
            "{{\"role\":\"user\",\"text\":\"{CANARY}\"}}\n{{\"role\":\"assistant\",\"text\":\"{CANARY} again\"}}\n"
        ),
    );
    let cap = Capture::new("tool-1");
    let stdin = hook(json!({"hook_event_name": "PreToolUse", "tool_name": "Bash",
        "tool_input": {"command": "ls"}, "session_id": "s-1", "transcript_path": path}));
    assert_eq!(cap.activity_hook("claude", &stdin).0, 0);
    let all = cap.all();
    assert!(!all.contains(CANARY), "{all}");
    assert!(all.contains(r#""transcriptPath":"#), "{all}");
    let got = cap.last_context();
    assert_eq!(got["toolId"], json!("tool-1"));
    let size = std::fs::metadata(&path).unwrap().len();
    assert_eq!(got["bytes"], json!(size));
    assert_eq!(got["sessionId"], json!("s-1"));
    assert!(
        got.get("tokens").is_none() && got.get("model").is_none(),
        "{got}"
    );
    assert!(got.get("compacted").is_none(), "{got}");
}

#[test]
fn report_context_pre_compact_travels_without_transcript() {
    let cap = Capture::new("tool-1");
    cap.activity_hook("claude", r#"{"hook_event_name":"PreCompact"}"#);
    let got = cap.last_context();
    assert_eq!(got["compacted"], json!(true));
    assert!(got.get("bytes").is_none(), "{got}");
}

#[test]
fn report_context_silent_when_there_is_no_signal() {
    let cap = Capture::new("tool-1");
    cap.activity_hook("claude", r#"{"hook_event_name":"Stop"}"#);
    cap.activity_hook("codex", r#"{"type":"agent-turn-complete"}"#);
    let (a, c) = cap.split();
    assert_eq!((a.len(), c.len()), (2, 0));
}

#[test]
fn report_context_stat_failure_does_not_break_activity() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("없는파일.jsonl");
    let cap = Capture::new("tool-1");
    let stdin = hook(json!({"hook_event_name": "PreToolUse", "tool_name": "Bash",
        "transcript_path": missing.to_str().unwrap()}));
    assert_eq!(cap.activity_hook("claude", &stdin).0, 0);
    assert_eq!(cap.activity().len(), 1);
    assert!(cap.last_context().get("bytes").is_none());
}

#[test]
fn transcript_size_stats_only() {
    let dir = tempfile::tempdir().unwrap();
    let body = "{\"a\":1}\n{\"b\":2}\n";
    let p = write_transcript(dir.path(), body);
    assert_eq!(transcript_size(&p), Some(body.len() as u64));
    assert_eq!(transcript_size(""), None);
    assert_eq!(transcript_size(dir.path().to_str().unwrap()), None);
    assert_eq!(
        transcript_size(dir.path().join("없다").to_str().unwrap()),
        None
    );
}

#[test]
fn report_context_session_start_carries_identity_without_transcript() {
    let cap = Capture::new("tool-1");
    cap.activity_hook(
        "claude",
        r#"{"hook_event_name":"SessionStart","session_id":"sess-abc","source":"startup"}"#,
    );
    let got = cap.last_context();
    assert_eq!(got["sessionId"], json!("sess-abc"));
    assert_eq!(got["agent"], json!("claude"));
    assert!(got.get("transcriptPath").is_none() && got.get("bytes").is_none());
    let m = cap.activity_json();
    let last = m.last().expect("활동 보고가 전송되지 않았다");
    assert_eq!(last["sessionId"], json!("sess-abc"));
    assert_eq!(last["agent"], json!("claude"));
}

#[test]
fn activity_body_omits_empty_session() {
    let cap = Capture::new("tool-1");
    cap.activity_hook("claude", r#"{"hook_event_name":"Stop"}"#);
    assert!(
        cap.activity_json()
            .last()
            .unwrap()
            .get("sessionId")
            .is_none()
    );
}

// ---- 전사본 사용량 ----

fn write_lines(dir: &Path, lines: &[String]) -> String {
    write_transcript(dir, &(lines.join("\n") + "\n"))
}

#[test]
fn transcript_usage_sums_input_side() {
    let d = tempfile::tempdir().unwrap();
    let p = write_lines(
        d.path(),
        &[assistant_line(
            "claude-opus-5",
            2,
            1570,
            200613,
            840,
            "본문",
        )],
    );
    let u = transcript_usage(claude(), &p).unwrap();
    assert_eq!(u.tokens, 2 + 1570 + 200613);
    assert_eq!(u.model, "claude-opus-5");
}

#[test]
fn transcript_usage_picks_last_line() {
    let d = tempfile::tempdir().unwrap();
    let p = write_lines(
        d.path(),
        &[
            assistant_line("claude-opus-5", 1, 0, 1000, 5, "예전"),
            r#"{"type":"user","message":{"content":"사용자 줄에는 usage 가 없다"}}"#.to_owned(),
            assistant_line("claude-opus-5[1m]", 1, 0, 480000, 7, "지금"),
        ],
    );
    let u = transcript_usage(claude(), &p).unwrap();
    assert_eq!(u.tokens, 1 + 480000);
    assert_eq!(u.model, "claude-opus-5[1m]");
}

#[test]
fn transcript_usage_unknown_when_absent() {
    let d = tempfile::tempdir().unwrap();
    let p = write_lines(
        d.path(),
        &[r#"{"type":"user","message":{"content":"안녕"}}"#.to_owned()],
    );
    assert!(transcript_usage(claude(), &p).is_none());
    assert!(transcript_usage(claude(), "").is_none());
    assert!(transcript_usage(claude(), d.path().join("없다.jsonl").to_str().unwrap()).is_none());
}

#[test]
fn transcript_usage_reads_only_tail() {
    let d = tempfile::tempdir().unwrap();
    let pad = "x".repeat(USAGE_TAIL_MAX as usize);
    let p = write_lines(
        d.path(),
        &[
            assistant_line("claude-opus-5", 9, 9, 9, 9, &pad),
            assistant_line("claude-opus-5", 1, 2, 3, 4, "끝"),
        ],
    );
    assert!(std::fs::metadata(&p).unwrap().len() > USAGE_TAIL_MAX);
    assert_eq!(transcript_usage(claude(), &p).unwrap().tokens, 1 + 2 + 3);
}

#[test]
fn transcript_usage_carries_no_content() {
    let d = tempfile::tempdir().unwrap();
    let p = write_lines(
        d.path(),
        &[assistant_line("claude-opus-5", 1, 2, 3, 4, CANARY)],
    );
    let u = transcript_usage(claude(), &p).unwrap();
    assert!(!u.model.contains(CANARY));
}

// ---- 서브에이전트 활동 ----

#[test]
fn subagent_tool_hook_sends_one_sub_report() {
    let cap = Capture::new("tool-sub");
    let (code, out, _) = cap.activity_hook(
        "claude",
        r#"{"hook_event_name":"PreToolUse","agent_id":"a922","agent_type":"Explore","tool_name":"Grep","tool_input":{"pattern":"parse"}}"#,
    );
    assert_eq!((code, out.as_str()), (0, ""));
    let got = cap.activity_json();
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(
        got[0],
        json!({"toolId": "tool-sub", "agent": "claude", "agentId": "a922", "agentType": "Explore",
            "state": "working", "tool": "Grep", "detail": "parse"})
    );
}

#[test]
fn subagent_permission_sends_both() {
    let cap = Capture::new("tool-sub");
    cap.activity_hook(
        "claude",
        r#"{"hook_event_name":"PermissionRequest","agent_id":"a922","agent_type":"Explore","tool_name":"Bash","tool_input":{"command":"rm x"}}"#,
    );
    let got = cap.activity_json();
    assert_eq!(got.len(), 2, "{got:?}");
    let (sub, main): (Vec<_>, Vec<_>) = got.iter().partition(|b| b.get("agentId").is_some());
    assert_eq!(main.len(), 1);
    assert_eq!(sub.len(), 1);
    assert_eq!(main[0]["state"], json!("waiting"));
    assert_eq!(sub[0]["state"], json!("waiting"));
}

#[test]
fn ignored_hooks_send_no_activity() {
    let cap = Capture::new("tool-sub");
    for p in [
        r#"{"hook_event_name":"SubagentStop","agent_id":"a5b4","agent_type":""}"#,
        r#"{"hook_event_name":"Notification","notification_type":"idle_prompt"}"#,
        r#"{"hook_event_name":"SessionStart","source":"compact"}"#,
    ] {
        let (code, out, _) = cap.activity_hook("claude", p);
        assert_eq!((code, out.as_str()), (0, ""), "{p}");
    }
    assert!(cap.activity().is_empty(), "{:?}", cap.activity());
}

#[test]
fn main_hook_has_no_agent_id() {
    let cap = Capture::new("tool-sub");
    cap.activity_hook("claude", r#"{"hook_event_name":"Stop"}"#);
    let got = cap.activity_json();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["state"], json!("done"));
    assert!(got[0].get("agentId").is_none());
}

// ---- agent-context ----

fn agent_context(cap: &Capture, stdin: &str) -> (i32, String) {
    let (code, out, _) = run_with(
        &cap.env,
        run_dmctl_agent_context,
        &["claude"],
        stdin.as_bytes(),
    );
    (code, out)
}

#[test]
fn agent_context_output_matches_go_bytes() {
    let env = Env::with_vars([(dmenv::ENV_TOOL_ID, "")]);
    let (code, out, _) = run_with(&env, run_dmctl_agent_context, &[], b"");
    assert_eq!(code, 0);
    assert!(
        out.starts_with(
            r#"{"hookSpecificOutput":{"additionalContext":"이 세션은 dongminal 워크스페이스의 도구(터미널 탭) 안에서 실행 중이다.\n\n- 자기 식별: `dmctl who-am-i`"#
        ),
        "{out}"
    );
    assert!(
        out.contains(r#"[DONGMINAL-AGENT-MSG from=\u003c발신자 uuid\u003e to=\u003c수신자 uuid\u003e ts=\u003c시각\u003e]"#),
        "{out}"
    );
    assert!(
        out.ends_with("거절된다 (FR-IDU-9).\",\"hookEventName\":\"SessionStart\"}}\n"),
        "{out}"
    );
}

#[test]
fn agent_context_session_start_carries_identity() {
    let cap = Capture::new("tool-ctx");
    let dir = tempfile::tempdir().unwrap();
    let tp = write_transcript(
        dir.path(),
        "{\"type\":\"user\",\"message\":{\"content\":\"x\"}}\n",
    );
    let (code, out) = agent_context(
        &cap,
        &hook(
            json!({"hook_event_name": "SessionStart", "session_id": "s-start",
            "transcript_path": tp, "cwd": "/tmp"}),
        ),
    );
    assert_eq!(code, 0);
    assert!(out.contains("additionalContext"), "{out}");
    let got = cap.context();
    assert_eq!(got.len(), 1, "{got:?}");
    for want in [
        r#""sessionId":"s-start""#,
        r#""toolId":"tool-ctx""#,
        r#""agent":"claude""#,
        r#""transcriptPath":"#,
    ] {
        assert!(got[0].contains(want), "{want}: {}", got[0]);
    }
    assert!(!got[0].contains(r#""/tmp""#), "{}", got[0]);
}

#[test]
fn agent_context_sends_path_not_content() {
    let dir = tempfile::tempdir().unwrap();
    let tp = write_transcript(
        dir.path(),
        &format!("{{\"type\":\"user\",\"message\":{{\"content\":\"{CANARY}\"}}}}\n"),
    );
    let cap = Capture::new("tool-ctx");
    agent_context(
        &cap,
        &hook(
            json!({"hook_event_name": "SessionStart", "session_id": "s-start", "transcript_path": tp}),
        ),
    );
    assert_eq!(cap.last_context()["transcriptPath"], json!(tp));
    assert!(!cap.all().contains(CANARY));
}

#[test]
fn agent_context_no_identity_is_silent() {
    let cap = Capture::new("tool-ctx");
    let (_, out) = agent_context(&cap, r#"{"hook_event_name":"SessionStart"}"#);
    assert!(cap.context().is_empty());
    assert!(out.contains("additionalContext"), "{out}");
}

// ---- ctx-hook ----

fn ctx_hook_run(verdict: &str, stdin: &str) -> (String, i32) {
    let home = tempfile::tempdir().unwrap();
    let v = verdict.as_bytes().to_vec();
    let srv = TestServer::new(move |_| (200, v.clone()));
    let mut env = srv.env(home.path());
    env.set(dmenv::ENV_TOOL_ID, "tool-1");
    let (rc, out, _) = run_with(&env, run_dmctl_ctx_hook, &["claude"], stdin.as_bytes());
    let reqs = srv.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].target, "/api/tools/migration-advice?id=tool-1");
    (out, rc)
}

#[test]
fn ctx_hook_advise_carries_pct_and_event() {
    let (out, rc) = ctx_hook_run(
        r#"{"verdict":"advise","usedPct":57,"ctxPct":50,"judgePct":40,"capPct":85}"#,
        r#"{"hook_event_name":"PostToolUse"}"#,
    );
    assert_eq!(rc, 0);
    let got: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        got["hookSpecificOutput"]["hookEventName"],
        json!("PostToolUse")
    );
    let text = got["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert_eq!(
        text,
        "[dongminal] 지금 맥락 57% · 기준 50% (판단은 40% 부터, 85% 이상이면 무조건 넘긴다).\n\
         기준쯤에서 넘기는 것이 좋다. 지금 하려는 일(또는 하던 일)을 끝냈을 때 맥락이 어디쯤일지 가늠하라.\n\
         - 기준을 크게 넘거나 85% 에 닿을 것 같으면: 그 일을 시작하지 말고 지금 넘겨라 — /dongminal:migration.\n\
         - 기준에서 크게 벗어나지 않을 것 같으면: 그 일을 끝내고 넘겨라. 끝냈을 때 아직 기준보다 한참 아래면 다음 일에서 다시 판단한다.\n\
         어느 쪽인지 지금 맥락·기준·예상치를 넣어 사용자에게 한 줄로 알려라."
    );
}

#[test]
fn ctx_hook_must_says_now_without_judgement() {
    let (out, rc) = ctx_hook_run(
        r#"{"verdict":"must","usedPct":86,"ctxPct":50,"judgePct":40,"capPct":85}"#,
        r#"{"hook_event_name":"UserPromptSubmit"}"#,
    );
    assert_eq!(rc, 0);
    for want in [
        "지금 맥락 86%",
        "상한 85%",
        "판단하지 말고",
        "/dongminal:migration",
        "UserPromptSubmit",
        "100% 에 닿으면",
    ] {
        assert!(out.contains(want), "{want}: {out}");
    }
}

#[test]
fn ctx_hook_unknown_once_and_quiet_otherwise() {
    let (out, _) = ctx_hook_run(
        r#"{"verdict":"unknown","ctxPct":50}"#,
        r#"{"hook_event_name":"UserPromptSubmit"}"#,
    );
    assert_eq!(
        out,
        "{\"hookSpecificOutput\":{\"additionalContext\":\"[dongminal] 맥락 사용률을 읽을 수 없어 migration 기준을 적용하지 못한다. 이 알림은 한 번만 나온다.\",\"hookEventName\":\"UserPromptSubmit\"}}\n"
    );
    for v in [
        r#"{"verdict":"ok","usedPct":10,"ctxPct":50}"#,
        r#"{"verdict":"skip","ctxPct":50}"#,
    ] {
        assert_eq!(
            ctx_hook_run(v, r#"{"hook_event_name":"PostToolUse"}"#),
            (String::new(), 0)
        );
    }
}

#[test]
fn ctx_hook_silent_on_failure() {
    let home = tempfile::tempdir().unwrap();
    let srv = TestServer::fixed(500, "");
    let mut env = srv.env(home.path());
    env.set(dmenv::ENV_TOOL_ID, "tool-1");
    assert_eq!(
        run_with(
            &env,
            run_dmctl_ctx_hook,
            &["claude"],
            br#"{"hook_event_name":"X"}"#
        ),
        (0, String::new(), String::new())
    );
    assert_eq!(
        run_with(&env, run_dmctl_ctx_hook, &["claude"], b"{}"),
        (0, String::new(), String::new())
    );
    env.set(dmenv::ENV_TOOL_ID, "");
    assert_eq!(
        run_with(&env, run_dmctl_ctx_hook, &["claude"], b"{}"),
        (0, String::new(), String::new())
    );
}

#[test]
fn ctx_hook_old_server_without_judge_cap() {
    let (out, rc) = ctx_hook_run(
        r#"{"verdict":"advise","usedPct":54,"ctxPct":50}"#,
        r#"{"hook_event_name":"PostToolUse"}"#,
    );
    assert_eq!(rc, 0);
    for bad in ["0% 부터", "0% 이상이면", " 0% 에 닿"] {
        assert!(!out.contains(bad), "{out}");
    }
    for want in [
        "지금 맥락 54% · 기준 50%.",
        "- 기준을 크게 넘을 것 같으면: 그 일을 시작하지 말고 지금 넘겨라",
        "끝내고 넘겨라",
    ] {
        assert!(out.contains(want), "{want}: {out}");
    }
}

#[test]
fn ctx_hook_carries_chat_unread() {
    let home = tempfile::Builder::new().tempdir_in("/tmp").unwrap();
    let sock = dm_shared_chatwire::socket_path(home.path());
    std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
    let ln = dm_shared_platform::current().ipc.listen(&sock).unwrap();
    let got = std::thread::spawn(move || {
        let mut c = ln.accept().unwrap();
        let mut line = String::new();
        BufReader::new(&mut c).read_line(&mut line).unwrap();
        let _ = c.write_all(b"{\"t\":\"unread\",\"total\":3}\n");
        line
    });
    let srv = TestServer::fixed(200, r#"{"verdict":"ok"}"#);
    let mut env = srv.env(home.path());
    env.set(dmenv::ENV_HOME, home.path().to_str().unwrap());
    let (rc, out, _) = run_with(
        &env,
        run_dmctl_ctx_hook,
        &["claude"],
        br#"{"hook_event_name":"PostToolUse","session_id":"s9"}"#,
    );
    assert_eq!(rc, 0);
    assert_eq!(
        got.join().unwrap(),
        "{\"t\":\"unread\",\"session\":\"s9\"}\n"
    );
    assert_eq!(
        out,
        "{\"hookSpecificOutput\":{\"additionalContext\":\"[dongminal chat] 읽지 않은 글 3건. 하던 일을 마친 뒤 chat_read 로 확인한다.\",\"hookEventName\":\"PostToolUse\"}}\n"
    );
}

// ---- statusLine ----

const SL_SAMPLE: &str = r#"{"session_id":"c009","transcript_path":"/Users/x/.claude/projects/p/c009.jsonl","cwd":"PROJ",
"effort":{"level":"medium"},"model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},
"workspace":{"current_dir":"PROJ","project_dir":"PROJ","added_dirs":[]},"version":"2.1.318",
"output_style":{"name":"default"},
"cost":{"total_cost_usd":0.5,"total_duration_ms":1019,"total_api_duration_ms":10,"total_lines_added":3,"total_lines_removed":1},
"context_window":{"total_input_tokens":100,"total_output_tokens":20,"context_window_size":1000000,
"current_usage":{"input_tokens":6,"output_tokens":8,"cache_creation_input_tokens":62146,"cache_read_input_tokens":0},
"used_percentage":6,"remaining_percentage":94},
"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1793860000},"seven_day":{"used_percentage":40,"resets_at":null}},
"exceeds_200k_tokens":false,"fast_mode":false,"thinking":{"enabled":true},"secret_new_field":"leak?"}"#;

const SSL_SAMPLE: &str = r#"{"session_id":"9cfd","transcript_path":"/Users/x/t.jsonl","cwd":"PROJ","columns":80,
"tasks":[{"id":"a3b7","agentType":"Explore","status":"running","label":"secret","model":"claude-haiku-5-5",
"contextWindowSize":1000000,"tokenCount":19250,"startTime":1794204238088}]}"#;

fn sl_env(home: &Path) -> SlEnv {
    SlEnv {
        home: home.to_string_lossy().into_owned(),
        ..Default::default()
    }
}

fn write_setting(p: &Path, key: &str, cmd: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    let v = json!({key: {"type": "command", "command": cmd}});
    std::fs::write(p, v.to_string()).unwrap();
}

#[test]
fn statusline_downstream_precedence() {
    let (home, proj) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let projs = proj.path().to_str().unwrap();
    let env = sl_env(home.path());
    let k = STATUS_LINE_KEY;
    write_setting(&home.path().join(".claude/settings.json"), k, "user-cmd");
    assert_eq!(statusline_downstream(projs, &env, k), "user-cmd");
    write_setting(&proj.path().join(".claude/settings.json"), k, "proj-cmd");
    assert_eq!(statusline_downstream(projs, &env, k), "proj-cmd");
    write_setting(
        &proj.path().join(".claude/settings.local.json"),
        k,
        "local-cmd",
    );
    assert_eq!(statusline_downstream(projs, &env, k), "local-cmd");
    let cfg = tempfile::tempdir().unwrap();
    write_setting(&cfg.path().join("settings.json"), k, "cfg-cmd");
    let other = tempfile::tempdir().unwrap();
    let env2 = SlEnv {
        config_dir: cfg.path().to_string_lossy().into_owned(),
        ..env.clone()
    };
    assert_eq!(
        statusline_downstream(other.path().to_str().unwrap(), &env2, k),
        "cfg-cmd"
    );
    write_setting(
        &proj.path().join(".claude/settings.local.json"),
        k,
        "dmctl statusline",
    );
    assert_eq!(statusline_downstream(projs, &env, k), "proj-cmd");
}

#[test]
fn statusline_downstream_disable_all_hooks() {
    let (home, proj) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    std::fs::create_dir_all(home.path().join(".claude")).unwrap();
    std::fs::write(
        home.path().join(".claude/settings.json"),
        r#"{"disableAllHooks":true}"#,
    )
    .unwrap();
    write_setting(
        &proj.path().join(".claude/settings.json"),
        STATUS_LINE_KEY,
        "proj-cmd",
    );
    assert_eq!(
        statusline_downstream(
            proj.path().to_str().unwrap(),
            &sl_env(home.path()),
            STATUS_LINE_KEY
        ),
        ""
    );
}

#[test]
fn subagent_statusline_downstream() {
    let (home, proj) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let projs = proj.path().to_str().unwrap();
    let env = sl_env(home.path());
    let user = home.path().join(".claude/settings.json");
    std::fs::create_dir_all(user.parent().unwrap()).unwrap();
    std::fs::write(
        &user,
        "{\"statusLine\":{\"type\":\"command\",\"command\":\"main-cmd\"},\n\"subagentStatusLine\":{\"type\":\"command\",\"command\":\"sub-cmd\"}}",
    )
    .unwrap();
    assert_eq!(
        statusline_downstream(projs, &env, SUBAGENT_STATUS_LINE_KEY),
        "sub-cmd"
    );
    assert_eq!(
        statusline_downstream(projs, &env, STATUS_LINE_KEY),
        "main-cmd"
    );
    let local = proj.path().join(".claude/settings.local.json");
    write_setting(
        &local,
        SUBAGENT_STATUS_LINE_KEY,
        "\"/x/dmctl\" subagent-statusline",
    );
    assert_eq!(
        statusline_downstream(projs, &env, SUBAGENT_STATUS_LINE_KEY),
        "sub-cmd"
    );
    std::fs::write(&local, r#"{"disableAllHooks":true}"#).unwrap();
    assert_eq!(
        statusline_downstream(projs, &env, SUBAGENT_STATUS_LINE_KEY),
        ""
    );
}

#[test]
fn statusline_project_dir_ignores_cwd_field() {
    assert_eq!(
        statusline_project_dir(br#"{"cwd":"/evil","workspace":{"project_dir":"/proj"}}"#),
        "/proj"
    );
    let wd = std::env::current_dir().unwrap();
    assert_eq!(
        statusline_project_dir(br#"{"cwd":"/evil"}"#),
        wd.to_string_lossy()
    );
}

/// statusLine 프록시를 돌린다. home 은 설정을 찾는 홈이다.
fn sl_run(
    f: crate::RunFn,
    srv: &TestServer,
    home: &Path,
    tool: &str,
    stdin: &str,
) -> (i32, String, String) {
    let state = tempfile::tempdir().unwrap();
    let mut env = srv.env(state.path());
    env.set("HOME", home.to_str().unwrap());
    env.set(dmenv::ENV_TOOL_ID, tool);
    run_with(&env, f, &[], stdin.as_bytes())
}

#[test]
fn statusline_proxy_no_downstream_empty() {
    let srv = TestServer::fixed(200, "{}");
    let home = tempfile::tempdir().unwrap();
    assert_eq!(
        sl_run(run_dmctl_statusline, &srv, home.path(), "", "{}"),
        (0, String::new(), String::new())
    );
}

#[cfg(unix)]
#[test]
fn statusline_proxy_pass_through() {
    let (home, proj, gotd) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let got = gotd.path().join("got.txt");
    let cmd = format!("cat > {}; printf 'LINE-OUT'", got.display());
    let settings = home.path().join(".claude/settings.json");
    write_setting(&settings, STATUS_LINE_KEY, &cmd);
    let orig = std::fs::read(&settings).unwrap();
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let input = SL_SAMPLE.replace("PROJ", proj.path().to_str().unwrap());
    let (rc, out, err) = sl_run(run_dmctl_statusline, &srv, home.path(), "tool-1", &input);
    assert_eq!((rc, out.as_str()), (0, "LINE-OUT"), "{err}");
    assert_eq!(std::fs::read_to_string(&got).unwrap(), input);
    assert_eq!(std::fs::read(&settings).unwrap(), orig);
    let reqs = srv.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].path(), apipath::TOOLS_USAGE);
    let posted = reqs[0].json();
    assert_eq!(posted["toolId"], json!("tool-1"));
    assert!(posted["usage"].is_object());
    assert!(posted.get("account").is_none());
}

#[cfg(unix)]
#[test]
fn statusline_proxy_server_hang_does_not_block() {
    let srv = TestServer::new(|_: &Req| {
        std::thread::sleep(Duration::from_secs(2));
        (200, Vec::new())
    });
    let home = tempfile::tempdir().unwrap();
    write_setting(
        &home.path().join(".claude/settings.json"),
        STATUS_LINE_KEY,
        "printf OK",
    );
    let start = Instant::now();
    let (rc, out, _) = sl_run(run_dmctl_statusline, &srv, home.path(), "t", SL_SAMPLE);
    assert_eq!((rc, out.as_str()), (0, "OK"));
    let el = start.elapsed();
    assert!(
        el < Duration::from_millis(600),
        "서버 지연이 표시를 막았다: {el:?}"
    );
}

#[cfg(unix)]
#[test]
fn subagent_statusline_proxy_pass_through() {
    let (home, gotd) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let got = gotd.path().join("got.txt");
    let cmd = format!(
        "cat > {}; printf '{{\"id\":\"a3b7\",\"content\":\"X\"}}'; exit 3",
        got.display()
    );
    write_setting(
        &home.path().join(".claude/settings.json"),
        SUBAGENT_STATUS_LINE_KEY,
        &cmd,
    );
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let (rc, out, err) = sl_run(
        run_dmctl_subagent_statusline,
        &srv,
        home.path(),
        "p1",
        SSL_SAMPLE,
    );
    assert_eq!(
        (rc, out.as_str()),
        (3, r#"{"id":"a3b7","content":"X"}"#),
        "{err}"
    );
    assert_eq!(std::fs::read_to_string(&got).unwrap(), SSL_SAMPLE);
}

#[test]
fn subagent_statusline_reports() {
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let home = tempfile::tempdir().unwrap();
    let (rc, out, _) = sl_run(
        run_dmctl_subagent_statusline,
        &srv,
        home.path(),
        "p1",
        SSL_SAMPLE,
    );
    assert_eq!((rc, out.as_str()), (0, ""));
    let reqs = srv.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].path(), apipath::TOOLS_SUBAGENTS);
    let body = String::from_utf8_lossy(&reqs[0].body).into_owned();
    assert!(body.starts_with(r#"{"tasks":[{"id":"a3b7""#), "{body}");
    assert!(body.ends_with(r#""toolId":"p1"}"#), "{body}");
    assert!(
        !body.contains("secret") && !body.contains("/Users/x"),
        "{body}"
    );
}

#[test]
fn subagent_statusline_reports_empty() {
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let home = tempfile::tempdir().unwrap();
    sl_run(
        run_dmctl_subagent_statusline,
        &srv,
        home.path(),
        "p1",
        r#"{"tasks":[]}"#,
    );
    let reqs = srv.requests();
    assert_eq!(
        String::from_utf8_lossy(&reqs[0].body),
        r#"{"tasks":[],"toolId":"p1"}"#
    );
}

#[test]
fn subagent_statusline_no_report() {
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let home = tempfile::tempdir().unwrap();
    sl_run(
        run_dmctl_subagent_statusline,
        &srv,
        home.path(),
        "",
        SSL_SAMPLE,
    );
    sl_run(
        run_dmctl_subagent_statusline,
        &srv,
        home.path(),
        "p1",
        r#"{"session_id":"x"}"#,
    );
    assert!(srv.requests().is_empty());
}

fn write_claude_json(dir: &Path, body: &str) {
    std::fs::write(dir.join(".claude.json"), body).unwrap();
}

#[test]
fn statusline_account_reads_config_dir() {
    let (home, prof) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    write_claude_json(
        home.path(),
        r#"{"oauthAccount":{"emailAddress":"a@x.com","organizationUuid":"org-a"},"theme":"dark"}"#,
    );
    write_claude_json(
        prof.path(),
        r#"{"oauthAccount":{"emailAddress":"b@x.com","organizationUuid":"org-b"}}"#,
    );
    let a = statusline_account(&sl_env(home.path())).unwrap();
    assert_eq!(
        (a.email.as_str(), a.org_uuid.as_str()),
        ("a@x.com", "org-a")
    );
    let env = SlEnv {
        config_dir: prof.path().to_string_lossy().into_owned(),
        ..sl_env(home.path())
    };
    assert_eq!(statusline_account(&env).unwrap().email, "b@x.com");
    let none = tempfile::tempdir().unwrap();
    assert!(statusline_account(&sl_env(none.path())).is_none());
    let empty = tempfile::tempdir().unwrap();
    write_claude_json(empty.path(), r#"{"oauthAccount":{"organizationUuid":"o"}}"#);
    assert!(statusline_account(&sl_env(empty.path())).is_none());
    write_claude_json(empty.path(), "not json");
    assert!(statusline_account(&sl_env(empty.path())).is_none());
}

#[test]
fn statusline_report_carries_account_first() {
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let home = tempfile::tempdir().unwrap();
    write_claude_json(
        home.path(),
        r#"{"oauthAccount":{"emailAddress":"a@x.com","organizationUuid":"org-a"}}"#,
    );
    sl_run(run_dmctl_statusline, &srv, home.path(), "t1", SL_SAMPLE);
    let body = String::from_utf8_lossy(&srv.requests()[0].body).into_owned();
    assert!(
        body.starts_with(
            r#"{"account":{"email":"a@x.com","organizationUuid":"org-a"},"toolId":"t1","usage":{"#
        ),
        "{body}"
    );
}

// ---- 보고 소켓 (report_socket_test.go) ----

/// 보고 소켓의 가짜 데몬이다. reply 가 없으면 답하지 않고 붙든다.
struct FakeReportSock {
    reqs: Arc<Mutex<Vec<agentrec::Request>>>,
    home: tempfile::TempDir,
}

fn start_report_sock(reply: Option<&'static str>) -> FakeReportSock {
    let home = tempfile::Builder::new().tempdir_in("/tmp").unwrap();
    let sock = agentrec::socket_path(home.path());
    std::fs::create_dir_all(sock.parent().unwrap()).unwrap();
    let ln = dm_shared_platform::current().ipc.listen(&sock).unwrap();
    let reqs = Arc::new(Mutex::new(Vec::new()));
    let r2 = reqs.clone();
    std::thread::spawn(move || {
        while let Ok(mut c) = ln.accept() {
            let r3 = r2.clone();
            std::thread::spawn(move || {
                let mut line = Vec::new();
                if BufReader::new(&mut c).read_until(b'\n', &mut line).is_err() {
                    return;
                }
                if let Ok(req) = dm_gocompat::json::unmarshal::<agentrec::Request>(&line) {
                    r3.lock().unwrap().push(req);
                }
                match reply {
                    Some(r) => {
                        let _ = c.write_all(r.as_bytes());
                    }
                    None => std::thread::sleep(Duration::from_secs(5)),
                }
            });
        }
    });
    FakeReportSock { reqs, home }
}

impl FakeReportSock {
    fn got(&self) -> Vec<agentrec::Request> {
        self.reqs.lock().unwrap().clone()
    }
    fn env(&self, srv: &TestServer, tool: &str) -> Env {
        let mut env = srv.env(self.home.path());
        env.set(dmenv::ENV_HOME, self.home.path().to_str().unwrap());
        env.set(dmenv::ENV_TOOL_ID, tool);
        env
    }
}

#[test]
fn post_report_socket_rejects_goes_http() {
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let sock = start_report_sock(Some("{\"ok\":false,\"error\":\"no such tool\"}\n"));
    let env = sock.env(&srv, "t1");
    let r = crate::report::post_report(
        &env,
        agentrec::METHOD_SUBAGENTS,
        apipath::TOOLS_SUBAGENTS,
        &json!({"toolId": "t1"}),
        HOOK_BUDGET,
    );
    assert_eq!(r.status, 200);
    assert_eq!((sock.got().len(), srv.requests().len()), (1, 1));
}

#[test]
fn post_report_socket_hangs_stays_within_budget() {
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let sock = start_report_sock(None);
    let env = sock.env(&srv, "t1");
    let budget = Duration::from_millis(400);
    let start = Instant::now();
    let r = crate::report::post_report(
        &env,
        agentrec::METHOD_ACTIVITY,
        apipath::TOOLS_ACTIVITY_SET,
        &json!({"toolId": "t1"}),
        budget,
    );
    let el = start.elapsed();
    assert_eq!((r.status, srv.requests().len()), (200, 1));
    assert!(el <= budget + Duration::from_millis(100), "{el:?}");
}

#[test]
fn activity_via_socket_keeps_context_on_http() {
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let sock = start_report_sock(Some("{\"ok\":true}\n"));
    let env = sock.env(&srv, "t1");
    let (code, _, _) = run_with(
        &env,
        run_dmctl_activity,
        &["claude"],
        br#"{"hook_event_name":"UserPromptSubmit","session_id":"s1"}"#,
    );
    assert_eq!(code, 0);
    let got = sock.got();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].method, agentrec::METHOD_ACTIVITY);
    let paths: Vec<String> = srv.requests().iter().map(|r| r.path().to_owned()).collect();
    assert_eq!(paths, [apipath::RUNS_CONTEXT]);
}

#[test]
fn statusline_via_socket() {
    let srv = TestServer::fixed(200, r#"{"ok":true}"#);
    let sock = start_report_sock(Some("{\"ok\":true}\n"));
    let mut env = sock.env(&srv, "t1");
    let home = tempfile::tempdir().unwrap();
    env.set("HOME", home.path().to_str().unwrap());
    run_with(&env, run_dmctl_statusline, &[], SL_SAMPLE.as_bytes());
    run_with(
        &env,
        run_dmctl_subagent_statusline,
        &[],
        SSL_SAMPLE.as_bytes(),
    );
    let got = sock.got();
    assert_eq!(got.len(), 2);
    assert_eq!(got[0].method, agentrec::METHOD_USAGE);
    assert_eq!(got[1].method, agentrec::METHOD_SUBAGENTS);
    assert!(srv.requests().is_empty());
}

// ---- hook_budget_test.go ----

#[test]
fn hook_budget_is_on_the_hot_path() {
    assert!(!HOOK_BUDGET.is_zero() && HOOK_BUDGET <= Duration::from_secs(3));
}
