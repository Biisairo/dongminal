//! Go `internal/shared/agentadapter` 테스트의 관측 동작 부분.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use otter_gocompat::json;
use otter_shared_agentadapter::*;
use otter_shared_platform::{ShellProvider, ShellSpec};
use serde_json::{Value, json};

fn host_quote(s: &str) -> String {
    otter_shared_platform::current().shell.quote(s)
}

fn parse(id: &str, payload: &str) -> Option<Report> {
    (get(id).unwrap().hook_parse)(payload.as_bytes())
}

/// 인용을 가로채는 대역. 어떤 값이 인용을 거쳤는지만 본다.
#[derive(Default)]
struct RecordingShell {
    seen: Mutex<Vec<String>>,
}

impl ShellProvider for RecordingShell {
    fn echo_command(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn run_command(&self, _: &str) -> Vec<String> {
        Vec::new()
    }
    fn shell(&self, _: &Path) -> ShellSpec {
        ShellSpec::default()
    }
    fn hook_root(&self) -> &'static str {
        ""
    }
    fn quote(&self, s: &str) -> String {
        self.seen.lock().unwrap().push(s.to_owned());
        format!("«{s}»")
    }
}

#[test]
fn get_unknown_agent_is_a_clear_error() {
    let err = get("gpt-9").unwrap_err();
    assert!(matches!(err, Error::UnknownAgent { .. }));
    assert_eq!(
        err.to_string(),
        r#"unknown_agent: "gpt-9" (알려진 것: claude, codex, omp)"#
    );
    assert!(matches!(get(""), Err(Error::UnknownAgent { .. })));
}

#[test]
fn get_known_agents_and_ids() {
    assert_eq!(ids(), ["claude", "codex", "omp"]);
    for id in ids() {
        let ad = get(id).unwrap();
        assert_eq!(ad.id, id);
        assert!(!ad.detect_cmd.is_empty() && !ad.launch.is_empty());
        assert!(ad.policy_injection.session_scoped, "{id}");
        assert!(!ad.policy_injection.flags.is_empty(), "{id}");
        assert!(ad.readiness.screen_patterns.is_empty(), "{id}");
        // V-AEV-8
        assert_eq!(ad.readiness.hooks, ad.signals.idle, "{id}");
    }
    assert!(get("claude").unwrap().readiness.hooks);
    assert!(!get("codex").unwrap().readiness.hooks);
}

#[test]
fn registry_lookups() {
    assert_eq!(status_line_reporter(), Some("claude"));
    assert_eq!(shim_commands(), ["claude"]);
    for id in ids() {
        assert_eq!(by_command(get(id).unwrap().detect_cmd).unwrap().id, id);
    }
    for n in ["", "zsh", "bash", "node"] {
        assert!(by_command(n).is_none(), "{n}");
    }
}

#[cfg(unix)]
#[test]
fn installed_checks_agent_bin_dir_then_path() {
    use std::os::unix::fs::PermissionsExt;
    // 프로세스 환경을 바꾸므로 이 시험만 환경을 쓴다.
    let ad = get("claude").unwrap();
    let empty = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    let exe = bin.path().join(ad.detect_cmd);
    fs::write(&exe, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
    let saved = std::env::var_os("PATH");
    // SAFETY: 이 시험 바이너리에서 PATH·OTTERMINAL_AGENT_BIN_DIR 을 읽고 쓰는 시험은 이것 하나다.
    unsafe {
        std::env::set_var("PATH", empty.path());
        std::env::set_var(otter_shared_otterenv::ENV_AGENT_BIN_DIR, "");
    }
    assert!(!ad.installed());
    unsafe { std::env::set_var(otter_shared_otterenv::ENV_AGENT_BIN_DIR, bin.path()) };
    assert!(ad.installed());
    unsafe {
        std::env::set_var(otter_shared_otterenv::ENV_AGENT_BIN_DIR, "");
        std::env::set_var("PATH", bin.path());
    }
    assert!(ad.installed());
    unsafe {
        match saved {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        std::env::remove_var(otter_shared_otterenv::ENV_AGENT_BIN_DIR);
    }
}

#[test]
fn hook_parse_reached_through_the_registry() {
    let r = parse(
        "claude",
        r#"{"hook_event_name":"Notification","notification_type":"permission_prompt"}"#,
    )
    .unwrap();
    assert_eq!(r.state, "waiting");
    assert_eq!(
        parse("codex", r#"{"type":"agent-turn-complete"}"#)
            .unwrap()
            .state,
        "done"
    );
    assert!(parse("codex", r#"{"hook_event_name":"Stop"}"#).is_none());
}

#[test]
fn launch_line_argv_quoting_survives_metacharacters() {
    let claude = get("claude").unwrap();
    let prompt = "요약: it's \"quoted\" $HOME `date`\n둘째 줄";
    let line = claude.launch_line("", "sonnet", prompt).unwrap();
    let want = format!(
        "claude --model {} {} {} -- {}",
        host_quote("sonnet"),
        host_quote("--allowedTools"),
        host_quote("Bash(otterctl:*)"),
        host_quote(prompt)
    );
    assert_eq!(line, want);
    assert!(!line.contains(" it's "));
}

#[test]
fn launch_line_delegates_quoting_to_the_shell() {
    let claude = get("claude").unwrap();
    let sh = RecordingShell::default();
    let line = claude
        .launch_line_in(&sh, "", "sonnet", "it's a prompt")
        .unwrap();
    assert_eq!(
        *sh.seen.lock().unwrap(),
        [
            "sonnet",
            "--allowedTools",
            "Bash(otterctl:*)",
            "it's a prompt"
        ]
    );
    assert_eq!(
        line,
        "claude --model «sonnet» «--allowedTools» «Bash(otterctl:*)» -- «it's a prompt»"
    );
    for model in ["claude-opus-5[1m]", "a b; rm -rf x", "it's"] {
        let line = claude
            .launch_line_in(&RecordingShell::default(), "", model, "x")
            .unwrap();
        assert!(line.contains(&format!("--model «{model}» ")), "{line}");
        let host = claude.launch_line("", model, "x").unwrap();
        assert!(
            host.contains(&format!("--model {} ", host_quote(model))),
            "{host}"
        );
    }
}

#[test]
fn launch_line_omits_model_when_unknown() {
    let claude = get("claude").unwrap();
    assert!(
        !claude
            .launch_line("", "", "안녕")
            .unwrap()
            .contains("--model")
    );
    let unknown = Adapter {
        id: "x",
        launch: &["x"],
        model_flag: "",
        member_args: &[],
        argv_separator: "",
        ..*claude
    };
    assert_eq!(
        unknown
            .launch_line_in(&RecordingShell::default(), "", "o3", "안녕")
            .unwrap(),
        "x «안녕»"
    );
    let stdin = Adapter {
        prompt_injection: PromptInjection::StdinAfterStart,
        ..unknown
    };
    assert_eq!(stdin.launch_line("", "", "비밀 프롬프트").unwrap(), "x");
}

#[test]
fn codex_terminal_surface_is_measured() {
    let codex = get("codex").unwrap();
    assert_eq!(codex.prompt_injection, PromptInjection::Argv);
    assert_eq!(
        codex.launch_line("", "o3", "안녕").unwrap(),
        format!("codex --model {} {}", host_quote("o3"), host_quote("안녕"))
    );
}

#[test]
fn omp_member_config_is_resolved_and_token_required() {
    let omp = get("omp").unwrap();
    let hooks = std::env::temp_dir()
        .join("otter")
        .join("bin")
        .join("agent-hooks");
    let hooks = hooks.to_str().unwrap();
    let line = omp.launch_line(hooks, "opus", "프리앰블 본문").unwrap();
    let cfg = Path::new(hooks).join(OMP_MEMBER_CONFIG_FILE);
    assert_eq!(
        line,
        format!(
            "omp --model {} {} {} {}",
            host_quote("opus"),
            host_quote("--config"),
            host_quote(cfg.to_str().unwrap()),
            host_quote("프리앰블 본문")
        )
    );
    let err = omp.launch_line("", "opus", "안녕").unwrap_err();
    assert_eq!(
        err.to_string(),
        r#"omp: "{{otterHooks}}/omp-member.yml" 의 자리를 채울 경로가 없다"#
    );
    for id in ["claude", "codex"] {
        assert!(get(id).unwrap().launch_line("", "haiku", "안녕").is_ok());
    }
}

#[test]
fn omp_confirmed_values() {
    let omp = get("omp").unwrap();
    assert_eq!(
        (omp.detect_cmd, omp.launch, omp.model_flag),
        ("omp", &["omp"][..], "--model")
    );
    assert_eq!(omp.argv_separator, "");
    assert_eq!(omp.exit_command, "/exit");
    assert_eq!(omp.policy_injection.flags, ["--hook", "--plugin-dir"]);
}

#[test]
fn resume_lines() {
    let sh = RecordingShell::default();
    let claude = get("claude").unwrap();
    assert_eq!(
        claude.resume_line_in(&sh, "", "abc-123", true).unwrap(),
        "claude «--resume» «abc-123» «--allowedTools» «Bash(otterctl:*)»"
    );
    assert_eq!(
        claude.resume_line_in(&sh, "", "abc-123", false).unwrap(),
        "claude «--resume» «abc-123»"
    );
    let omp = get("omp").unwrap();
    let hooks = PathBuf::from("h").join("agent-hooks");
    let hooks = hooks.to_str().unwrap();
    assert_eq!(
        omp.resume_line_in(&sh, hooks, "s1", true).unwrap(),
        format!(
            "omp «--resume=s1» «--config» «{}»",
            Path::new(hooks).join(OMP_MEMBER_CONFIG_FILE).display()
        )
    );
    assert!(omp.resume_line_in(&sh, "", "s1", true).is_err());
    let codex = get("codex").unwrap();
    assert!(!codex.can_resume());
    let err = codex.resume_line_in(&sh, "", "s1", true).unwrap_err();
    assert_eq!(err.to_string(), "no_resume: codex");
    assert_eq!(
        claude.resume_line_in(&sh, "", "a;b", true).unwrap_err(),
        Error::BadSession
    );
}

#[test]
fn valid_session_ids() {
    let x128 = "x".repeat(128);
    for s in [
        "8f365211-937f-4591-8f20-2e03362d855e",
        "a",
        "A.b_c-9",
        x128.as_str(),
    ] {
        assert!(valid_session_id(s), "{s}");
    }
    let x129 = "x".repeat(129);
    for s in [
        "",
        "a;b",
        "$(rm)",
        "a b",
        "a'b",
        "a/b",
        x129.as_str(),
        "가",
        "-x",
        "--dangerously-skip-permissions",
        ".a",
        "_a",
    ] {
        assert!(!valid_session_id(s), "{s}");
    }
}

#[test]
fn claude_session_pids() {
    let claude = get("claude").unwrap();
    let f = claude.session_pids.unwrap();
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let write = |dir: &Path, name: &str, body: &str| {
        fs::create_dir_all(dir.join("sessions")).unwrap();
        fs::write(dir.join("sessions").join(name), body).unwrap();
    };
    write(a.path(), "11.json", r#"{"pid":11,"sessionId":"S"}"#);
    write(a.path(), "12.json", r#"{"pid":12,"sessionId":"other"}"#);
    write(a.path(), "13.json", "{깨짐");
    write(a.path(), "11.abc.key", r#"{"pid":99,"sessionId":"S"}"#);
    write(b.path(), "21.json", r#"{"pid":21,"sessionId":"S"}"#);
    let missing = tempfile::tempdir().unwrap().path().join("없음");
    let dirs = [
        a.path().to_path_buf(),
        b.path().to_path_buf(),
        missing.clone(),
    ];
    assert_eq!(f("S", &dirs), Some(vec![11, 21]));
    assert_eq!(f("S", &[missing]), Some(vec![]));
    let c = tempfile::tempdir().unwrap();
    fs::write(c.path().join("sessions"), "x").unwrap();
    assert_eq!(f("S", &[c.path().to_path_buf()]), None);
    assert!(get("omp").unwrap().session_pids.is_none());
}

// ── 훅 해석표 (TC-ASV-2·3·4, TGB-70, CBG, AEV-15) ──

#[test]
fn claude_hook_main_table() {
    let cases: &[(&str, &str, &str, &str)] = &[
        (
            r#"{"hook_event_name":"UserPromptSubmit","prompt":"고쳐줘"}"#,
            "working",
            "",
            "고쳐줘",
        ),
        (
            r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}"#,
            "working",
            "Bash",
            "ls",
        ),
        (
            r#"{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/a.go"}}"#,
            "working",
            "Read",
            "/a.go",
        ),
        (
            r#"{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"make"},"error":"exit 2"}"#,
            "working",
            "Bash",
            "make",
        ),
        (
            r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm x"}}"#,
            "waiting",
            "Bash",
            "rm x",
        ),
        (
            r#"{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"needs permission"}"#,
            "waiting",
            "",
            "needs permission",
        ),
        (
            r#"{"hook_event_name":"Notification","notification_type":"elicitation_dialog","message":"m"}"#,
            "waiting",
            "",
            "m",
        ),
        (
            r#"{"hook_event_name":"Notification","notification_type":"elicitation_url_dialog","message":"m"}"#,
            "waiting",
            "",
            "m",
        ),
        (
            r#"{"hook_event_name":"Notification","notification_type":"agent_needs_input","message":"m"}"#,
            "waiting",
            "",
            "m",
        ),
        (
            r#"{"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"}"#,
            "",
            "",
            "",
        ),
        (
            r#"{"hook_event_name":"Notification","notification_type":"auth_success"}"#,
            "",
            "",
            "",
        ),
        (
            r#"{"hook_event_name":"Notification","message":"m"}"#,
            "",
            "",
            "",
        ),
        (
            r#"{"hook_event_name":"PreCompact","trigger":"auto"}"#,
            "working",
            "",
            "",
        ),
        (
            r#"{"hook_event_name":"PostCompact","trigger":"manual"}"#,
            "idle",
            "",
            "",
        ),
        (
            r#"{"hook_event_name":"PostCompact","trigger":"auto"}"#,
            "",
            "",
            "",
        ),
        (
            r#"{"hook_event_name":"Stop","background_tasks":[{"id":"a1","status":"running"}]}"#,
            "done",
            "",
            "",
        ),
        (
            r#"{"hook_event_name":"StopFailure","error":"rate_limit"}"#,
            "done",
            "",
            "rate_limit",
        ),
        (
            r#"{"hook_event_name":"SessionStart","source":"startup"}"#,
            "idle",
            "",
            "startup",
        ),
        (
            r#"{"hook_event_name":"SessionStart","source":"compact"}"#,
            "",
            "",
            "",
        ),
        (r#"{"hook_event_name":"SessionEnd"}"#, "ended", "", ""),
        (r#"{"hook_event_name":"SubagentStop"}"#, "", "", ""),
        (
            r#"{"hook_event_name":"UserPromptSubmit","prompt":"<agent-message from=\"a922\">\n[Subagent hand-back] ..."}"#,
            "working",
            "",
            "<agent-message from=\"a922\">\n[Subagent hand-back] ...",
        ),
    ];
    for (p, state, tool, detail) in cases {
        let r = parse("claude", p).unwrap_or_else(|| panic!("{p}"));
        assert_eq!(
            (r.state.as_str(), r.tool.as_str(), r.detail.as_str()),
            (*state, *tool, *detail),
            "{p}"
        );
        assert!(r.sub.is_none(), "{p}");
    }
    assert!(parse("claude", r#"{"hook_event_name":"Bogus"}"#).is_none());
    assert!(parse("claude", "{").is_none());
}

#[test]
fn claude_hook_internal_agent_is_dropped() {
    for p in [
        r#"{"hook_event_name":"SubagentStop","agent_id":"a5b478e531a856437","agent_type":""}"#,
        r#"{"hook_event_name":"SubagentStop","agent_id":"a5b478e531a856437"}"#,
        r#"{"hook_event_name":"PreToolUse","agent_id":"a5b4","agent_type":"","tool_name":"Read"}"#,
    ] {
        assert!(parse("claude", p).is_none(), "{p}");
    }
}

#[test]
fn claude_hook_subagent_table() {
    let sub = |ev: &str, extra: &str| {
        format!(r#"{{"hook_event_name":"{ev}","agent_id":"a92","agent_type":"Explore"{extra}}}"#)
    };
    let cases = [
        (sub("SubagentStart", ""), "working", "", "", "", ""),
        (
            sub(
                "PreToolUse",
                r#","tool_name":"Grep","tool_input":{"pattern":"parse"}"#,
            ),
            "working",
            "Grep",
            "parse",
            "",
            "",
        ),
        (
            sub(
                "PostToolUse",
                r#","tool_name":"Bash","tool_input":{"command":"ls"}"#,
            ),
            "working",
            "Bash",
            "ls",
            "",
            "",
        ),
        (
            sub(
                "PostToolUseFailure",
                r#","tool_name":"Bash","tool_input":{"command":"x"}"#,
            ),
            "working",
            "Bash",
            "x",
            "",
            "",
        ),
        (
            sub(
                "PermissionRequest",
                r#","tool_name":"Bash","tool_input":{"command":"rm"}"#,
            ),
            "waiting",
            "Bash",
            "rm",
            "waiting",
            "rm",
        ),
        (
            sub(
                "Notification",
                r#","notification_type":"permission_prompt","message":"m""#,
            ),
            "waiting",
            "",
            "m",
            "waiting",
            "m",
        ),
        (sub("SubagentStop", ""), "done", "", "", "", ""),
        (
            sub(
                "PreToolUse",
                r#","tool_name":"SubagentHandback","tool_input":{"message":"r"}"#,
            ),
            "done",
            "SubagentHandback",
            "",
            "",
            "",
        ),
        (
            sub(
                "PostToolUse",
                r#","tool_name":"SubagentHandback","tool_input":{"message":"r"}"#,
            ),
            "done",
            "SubagentHandback",
            "",
            "",
            "",
        ),
        (
            sub(
                "PostToolUseFailure",
                r#","tool_name":"SubagentHandback","tool_input":{"message":"r"}"#,
            ),
            "done",
            "SubagentHandback",
            "",
            "",
            "",
        ),
    ];
    for (p, state, tool, detail, main_state, main_detail) in &cases {
        let r = parse("claude", p).unwrap();
        let s = r.sub.as_ref().unwrap_or_else(|| panic!("{p}"));
        assert_eq!(
            (
                s.agent_id.as_str(),
                s.agent_type.as_str(),
                s.state.as_str(),
                s.tool.as_str(),
                s.detail.as_str()
            ),
            ("a92", "Explore", *state, *tool, *detail),
            "{p}"
        );
        assert_eq!(r.state, *main_state, "{p}");
        if !main_state.is_empty() {
            assert_eq!(r.detail, *main_detail);
        }
    }
    let r = parse(
        "claude",
        &sub("Notification", r#","notification_type":"idle_prompt""#),
    )
    .unwrap();
    assert!(r.sub.is_none() && r.state.is_empty());
}

#[test]
fn claude_hook_bridge_fields() {
    let cases = [
        (
            r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"date > out.txt"},"tool_use_id":"toolu_1"}"#,
            "PreToolUse",
            "",
        ),
        (
            r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"색?","options":[{"label":"red"}]}]},"tool_use_id":"toolu_2"}"#,
            "PreToolUse",
            r#"{"questions":[{"question":"색?","options":[{"label":"red"}]}]}"#,
        ),
        (
            r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm x"},"permission_suggestions":[]}"#,
            "PermissionRequest",
            r#"{"command":"rm x"}"#,
        ),
        (
            r#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"toolu_3","tool_response":{"stdout":"secret"}}"#,
            "PostToolUse",
            "",
        ),
        (
            r#"{"hook_event_name":"StopFailure","error":"rate_limit"}"#,
            "StopFailure",
            "",
        ),
        (r#"{"hook_event_name":"Stop"}"#, "Stop", ""),
        (
            r#"{"hook_event_name":"PermissionRequest","agent_id":"a1","agent_type":"general","tool_name":"Bash","tool_input":{"command":"ls"}}"#,
            "PermissionRequest",
            r#"{"command":"ls"}"#,
        ),
    ];
    for (p, hook, input) in cases {
        let r = parse("claude", p).unwrap();
        assert_eq!(r.hook, hook, "{p}");
        assert_eq!(String::from_utf8_lossy(&r.input.0), input, "{p}");
        assert!(!r.input_over);
    }
    let big = "a".repeat(BRIDGE_INPUT_MAX);
    let p = format!(
        r#"{{"hook_event_name":"PermissionRequest","tool_name":"Write","tool_input":{{"file_path":"/x","content":"{big}"}}}}"#
    );
    let r = parse("claude", &p).unwrap();
    assert!(r.input.0.is_empty() && r.input_over);
    assert_eq!(r.state, "waiting");
}

#[test]
fn context_signals() {
    let r = parse(
        "claude",
        r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"s-1","transcript_path":"/tmp/t.jsonl"}"#,
    )
    .unwrap();
    assert_eq!(
        (r.transcript.as_str(), r.session_id.as_str()),
        ("/tmp/t.jsonl", "s-1")
    );
    assert!(!r.compacted);
    let r = parse("claude", r#"{"hook_event_name":"Stop"}"#).unwrap();
    assert!(r.transcript.is_empty() && r.session_id.is_empty());
    let r = parse(
        "claude",
        r#"{"hook_event_name":"PreCompact","transcript_path":"/t"}"#,
    )
    .unwrap();
    assert!(r.compacted && r.state == "working");
    let r = parse("codex", r#"{"type":"agent-turn-complete"}"#).unwrap();
    assert!(
        r.transcript.is_empty() && r.session_id.is_empty() && !r.compacted && r.detail.is_empty()
    );
}

#[test]
fn alarm_carries_detail() {
    let r = parse("claude", r#"{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}"#).unwrap();
    assert_eq!(
        (r.state.as_str(), r.detail.as_str()),
        ("waiting", "Claude needs your permission to use Bash")
    );
    let r = parse(
        "codex",
        r#"{"type":"agent-turn-complete","last-assistant-message":"빌드를 고쳤다"}"#,
    )
    .unwrap();
    assert_eq!(
        (r.state.as_str(), r.detail.as_str()),
        ("done", "빌드를 고쳤다")
    );
    let r = parse("omp", r#"{"event":"agent_end","detail":"작업 완료"}"#).unwrap();
    assert_eq!((r.state.as_str(), r.detail.as_str()), ("done", "작업 완료"));
}

#[test]
fn omp_hook_table() {
    let cases = [
        (r#"{"event":"session_start"}"#, "idle", "", false),
        (r#"{"event":"agent_start"}"#, "working", "", false),
        (r#"{"event":"turn_start"}"#, "working", "", false),
        (r#"{"event":"turn_end"}"#, "working", "", false),
        (
            r#"{"event":"tool_call","tool":"bash","detail":"ls -al"}"#,
            "working",
            "bash",
            false,
        ),
        (
            r#"{"event":"tool_result","tool":"read"}"#,
            "working",
            "read",
            false,
        ),
        (r#"{"event":"compaction"}"#, "working", "", true),
        (r#"{"event":"agent_end"}"#, "done", "", false),
        (r#"{"event":"session_shutdown"}"#, "ended", "", false),
    ];
    for (p, state, tool, compact) in cases {
        let r = parse("omp", p).unwrap();
        assert_eq!(
            (r.state.as_str(), r.tool.as_str(), r.compacted),
            (state, tool, compact),
            "{p}"
        );
    }
    for p in [
        r#"{"event":"ttsr_triggered"}"#,
        r#"{"event":""}"#,
        "{",
        "",
        r#"{"hook_event_name":"Stop"}"#,
    ] {
        assert!(parse("omp", p).is_none(), "{p}");
    }
    let r = parse("omp", r#"{"event":"turn_start"}"#).unwrap();
    assert!(r.session_id.is_empty() && r.transcript.is_empty());
    let r = parse(
        "omp",
        r#"{"event":"turn_start","sessionId":"s-1","transcript":"/tmp/s.jsonl"}"#,
    )
    .unwrap();
    assert_eq!(
        (r.session_id.as_str(), r.transcript.as_str()),
        ("s-1", "/tmp/s.jsonl")
    );
}

/// V-AEV-7: 선언과 실제 산출이 일치한다.
#[test]
fn signals_match_hook_parse() {
    let native: &[(&str, &[&str])] = &[
        (
            "claude",
            &[
                r#"{"hook_event_name":"SessionStart"}"#,
                r#"{"hook_event_name":"UserPromptSubmit"}"#,
                r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}"#,
                r#"{"hook_event_name":"PostToolUse","tool_name":"Bash"}"#,
                r#"{"hook_event_name":"PostToolUseFailure","tool_name":"Bash"}"#,
                r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#,
                r#"{"hook_event_name":"SubagentStart","agent_id":"a1","agent_type":"Explore"}"#,
                r#"{"hook_event_name":"SubagentStop","agent_id":"a1","agent_type":"Explore"}"#,
                r#"{"hook_event_name":"PreCompact"}"#,
                r#"{"hook_event_name":"PostCompact","trigger":"manual"}"#,
                r#"{"hook_event_name":"Notification","notification_type":"permission_prompt"}"#,
                r#"{"hook_event_name":"Stop"}"#,
                r#"{"hook_event_name":"StopFailure","error":"rate_limit"}"#,
                r#"{"hook_event_name":"SessionEnd"}"#,
            ],
        ),
        (
            "omp",
            &[
                r#"{"event":"session_start"}"#,
                r#"{"event":"agent_start"}"#,
                r#"{"event":"turn_start"}"#,
                r#"{"event":"turn_end"}"#,
                r#"{"event":"tool_call","tool":"bash","detail":"ls"}"#,
                r#"{"event":"tool_result","tool":"bash"}"#,
                r#"{"event":"compaction"}"#,
                r#"{"event":"agent_end"}"#,
                r#"{"event":"session_shutdown"}"#,
            ],
        ),
        ("codex", &[r#"{"type":"agent-turn-complete"}"#]),
    ];
    assert_eq!(native.len(), ids().len());
    for (id, events) in native {
        let mut got = Signals::default();
        for ev in *events {
            let r = parse(id, ev).unwrap_or_else(|| panic!("{id}: {ev}"));
            match r.state.as_str() {
                "" => {}
                "idle" => got.idle = true,
                "working" => got.working = true,
                "waiting" => got.waiting = true,
                "done" => got.done = true,
                "ended" => got.ended = true,
                s => panic!("{id}: 어휘 밖의 상태 {s}"),
            }
            got.compaction |= r.compacted;
            got.tool_detail |= !r.tool.is_empty() || !r.detail.is_empty();
        }
        got.session = get(id).unwrap().signals.session;
        assert_eq!(got, get(id).unwrap().signals, "{id}");
    }
}

// ── 설치물 ──

fn hook_commands(blob: &[u8]) -> Vec<(String, Vec<String>)> {
    let v: Value = json::unmarshal(blob).unwrap();
    let mut out = Vec::new();
    for (ev, groups) in v["hooks"].as_object().unwrap() {
        let mut cmds = Vec::new();
        for g in groups.as_array().unwrap() {
            for h in g["hooks"].as_array().unwrap() {
                cmds.push(h["command"].as_str().unwrap().to_owned());
            }
        }
        out.push((ev.clone(), cmds));
    }
    out
}

fn install_claude(root: &Path, otterctl: &str) -> InstallSpec {
    let spec = InstallSpec {
        dir: root.join("hooks"),
        plugin_dir: root.join("plugin"),
        otterctl: otterctl.to_owned(),
    };
    fs::create_dir_all(&spec.dir).unwrap();
    (get("claude").unwrap().install_assets.unwrap())(&spec).unwrap();
    spec
}

#[test]
fn claude_settings_hooks_statusline_and_ctx() {
    let root = tempfile::tempdir().unwrap();
    let spec = install_claude(root.path(), "/opt/otter/bin/otterctl");
    let blob = fs::read(spec.dir.join("claude.json")).unwrap();
    let v: Value = json::unmarshal(&blob).unwrap();
    assert_eq!(v["statusLine"]["type"], "command");
    assert_eq!(
        v["statusLine"]["command"],
        r#""/opt/otter/bin/otterctl" statusline"#
    );
    assert_eq!(
        v["subagentStatusLine"]["command"],
        r#""/opt/otter/bin/otterctl" subagent-statusline"#
    );
    let hooks = hook_commands(&blob);
    assert_eq!(hooks.len(), 14);
    let ctx = r#""/opt/otter/bin/otterctl" ctx-hook claude"#;
    // ISSUE_TREE_CHAT_SRS FR-CAL-8 · AGENT_MSG_REWAKE_SRS FR-AMW-23: SessionStart 와 Stop 에 깨움 훅을
    // 따로 건다. 활동 훅에는 asyncRewake 가 없다.
    let wait = r#""/opt/otter/bin/otterctl" chat-wait"#;
    for ev in ["SessionStart", "Stop"] {
        let list = &v["hooks"][ev][0]["hooks"];
        assert_eq!(list[1]["asyncRewake"], json!(true), "{ev}: {list}");
        assert_eq!(list[1]["timeout"], json!(CHAT_WAIT_TIMEOUT_SECS), "{ev}: {list}");
        assert!(list[0].get("asyncRewake").is_none(), "{ev}: {list}");
    }
    for (ev, cmds) in &hooks {
        assert_eq!(cmds[0], r#""/opt/otter/bin/otterctl" activity claude"#);
        if ev == "PostToolUse" || ev == "UserPromptSubmit" {
            assert_eq!(cmds, &[cmds[0].clone(), ctx.to_owned()]);
        } else if ev == "Stop" || ev == "SessionStart" {
            assert_eq!(cmds, &[cmds[0].clone(), wait.to_owned()]);
        } else {
            assert_eq!(cmds.len(), 1, "{ev}");
        }
    }
    assert!(!String::from_utf8_lossy(&blob).contains("notify"));
    let plugin = fs::read(spec.plugin_dir.join("hooks").join("hooks.json")).unwrap();
    assert_eq!(
        hook_commands(&plugin),
        [(
            "SessionStart".to_owned(),
            vec![r#""/opt/otter/bin/otterctl" agent-context claude"#.to_owned()]
        )]
    );
}

#[test]
fn hook_command_quotes_executable_only() {
    let s = InstallSpec {
        otterctl: r"C:\Program Files\otter\otterctl.exe".into(),
        ..InstallSpec::default()
    };
    assert_eq!(
        s.hook_command(&["notify", "done"]),
        r#""C:\Program Files\otter\otterctl.exe" notify done"#
    );
    let s = InstallSpec {
        otterctl: "/home/u/.otterminal/bin/otterctl".into(),
        ..InstallSpec::default()
    };
    assert_eq!(s.hook_command(&[]), r#""/home/u/.otterminal/bin/otterctl""#);
}

/// FR-OPT-5-5: 되풀이해 써도 같은 파일은 교체되지 않는다.
#[test]
fn install_assets_keeps_unchanged_files() {
    let root = tempfile::tempdir().unwrap();
    let install = || {
        let spec = install_claude(root.path(), "/x/otterctl");
        (get("omp").unwrap().install_assets.unwrap())(&spec).unwrap();
    };
    install();
    let stamp = SystemTime::UNIX_EPOCH + Duration::from_secs(946_684_800);
    let mut files = Vec::new();
    for dir in ["hooks", "plugin/hooks"] {
        for e in fs::read_dir(root.path().join(dir)).unwrap() {
            let p = e.unwrap().path();
            if p.is_file() {
                fs::File::options()
                    .write(true)
                    .open(&p)
                    .unwrap()
                    .set_modified(stamp)
                    .unwrap();
                files.push(p);
            }
        }
    }
    assert_eq!(files.len(), 4);
    install();
    for p in files {
        assert_eq!(
            fs::metadata(&p).unwrap().modified().unwrap(),
            stamp,
            "{}",
            p.display()
        );
    }
}

#[test]
fn omp_shim_and_overlay() {
    let root = tempfile::tempdir().unwrap();
    let spec = install_claude(root.path(), r#"/x y/"q"\otterctl"#);
    (get("omp").unwrap().install_assets.unwrap())(&spec).unwrap();
    let s = fs::read_to_string(spec.dir.join(OMP_SHIM_FILE)).unwrap();
    assert!(
        s.contains(r#"const OTTERCTL = "/x y/\"q\"\\otterctl";"#),
        "{s}"
    );
    for ev in [
        "session_start",
        "session_shutdown",
        "agent_start",
        "agent_end",
        "turn_start",
        "turn_end",
        "tool_call",
        "tool_result",
        "compaction",
    ] {
        assert!(s.contains(&format!("event: \"{ev}\"")), "{ev}");
    }
    let o = fs::read_to_string(spec.dir.join(OMP_MEMBER_CONFIG_FILE)).unwrap();
    assert!(o.contains("patterns") && o.contains("otterctl") && o.contains("allow"));
    assert!(!o.contains("approvalMode"));
}
