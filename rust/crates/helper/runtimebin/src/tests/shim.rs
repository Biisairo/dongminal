//! CLAUDE_ACCOUNTS_SRS TC-CAC-20, AGENT_MEMORY_INJECTION_SRS TC-AMI-2·3·4, PEER_CHAT_SRS TC-PCH-15.
//! Go claude_shim_posix_test.go·claude_shim_memory_posix_test.go·claude_shim_chat_posix_test.go.
//! POSIX 실행 비트로 진짜 claude 를 흉내 내므로 POSIX 전용이다. 진짜 명령은 실행하지 않는다.
#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use otter_shared_chatwire as chatwire;
use otter_shared_otterenv as otterenv;
use serde_json::{Value, json};
use tempfile::TempDir;

use super::{Req, TestServer, closed_port, env_at, run_with};
use crate::ctx::Env;
use crate::helper;
use crate::otterctl::hooks::run_otterctl_ctx_hook;

const NONE: &str = r#"{"source":"none"}"#;
const ADD_DIR_MEMORY_ENV: &str = "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD";

#[derive(Default, Clone)]
struct ShimRun {
    path: String,
    argv: Vec<String>,
    env: Vec<String>,
}

struct Fixture {
    home: TempDir,
    _real_dir: TempDir,
    real: String,
    ran: Arc<Mutex<Option<ShimRun>>>,
    env: Env,
}

impl Fixture {
    fn ran(&self) -> Option<ShimRun> {
        self.ran.lock().unwrap().clone()
    }
    fn home(&self) -> &Path {
        self.home.path()
    }
    fn bin(&self) -> PathBuf {
        self.home().join("bin")
    }
    fn run(&self, args: &[&str]) -> (i32, String, String) {
        run_with(&self.env, helper("claude").unwrap(), args, b"")
    }
}

/// 소켓 경로 상한(104바이트) 안의 짧은 홈이다.
fn short_dir() -> TempDir {
    tempfile::Builder::new().tempdir_in("/tmp").unwrap()
}

fn write_exe(path: &Path) {
    fs::write(path, "#!/bin/sh\n").unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// OTTERMINAL_HOME, 진짜 claude 가 있는 PATH, 실행 가로채기를 세운다. 서버는 port 다.
fn fixture(port: u16) -> Fixture {
    let home = short_dir();
    let shims = otterenv::agent_shims_dir_in(&home.path().join("bin"));
    let real_dir = tempfile::tempdir().unwrap();
    for d in [&shims, &real_dir.path().to_path_buf()] {
        fs::create_dir_all(d).unwrap();
        write_exe(&d.join("claude"));
    }
    let mut env = env_at(home.path(), port);
    env.set(otterenv::ENV_HOME, home.path().to_str().unwrap());
    env.set(
        "PATH",
        &format!("{}:{}", shims.display(), real_dir.path().display()),
    );
    env.set("CLAUDE_CONFIG_DIR", "");
    env.set(otterenv::ENV_TOOL_ID, "tool-1");
    let ran = Arc::new(Mutex::new(None));
    let r2 = ran.clone();
    env.shim_exec = Some(Arc::new(move |path, argv, envl| {
        *r2.lock().unwrap() = Some(ShimRun {
            path: path.to_owned(),
            argv: argv.to_vec(),
            env: envl.to_vec(),
        });
        7
    }));
    let real = real_dir.path().join("claude").to_str().unwrap().to_owned();
    Fixture {
        home,
        _real_dir: real_dir,
        real,
        ran,
        env,
    }
}

fn env_value(env: &[String], key: &str) -> Option<String> {
    env.iter()
        .rev()
        .filter_map(|kv| kv.split_once('='))
        .filter(|(k, _)| *k == key)
        .map(|(_, v)| v.to_owned())
        .next()
}

#[test]
fn shim_registered_for_every_declared_command() {
    for name in otter_shared_agentadapter::shim_commands() {
        assert!(helper(name).is_some(), "{name}");
    }
    assert!(otter_shared_agentadapter::shim_commands().contains(&"claude"));
}

#[test]
fn claude_shim_finds_real_claude_outside_shims() {
    let srv = TestServer::fixed(200, NONE);
    let f = fixture(srv.port);
    let (code, _, err) = f.run(&["-p", "hi"]);
    assert_eq!(code, 7, "{err}");
    let ran = f.ran().unwrap();
    assert_eq!(ran.path, f.real);
    assert_eq!(ran.argv, vec![f.real.clone(), "-p".into(), "hi".into()]);
    assert!(env_value(&ran.env, "CLAUDE_CONFIG_DIR").is_none_or(|v| v.is_empty()));
}

#[test]
fn claude_shim_not_found() {
    let mut f = fixture(closed_port());
    let shims = otterenv::agent_shims_dir_in(&f.bin());
    f.env.set("PATH", shims.to_str().unwrap());
    let (code, out, err) = f.run(&[]);
    assert_eq!(
        (code, out.as_str(), err.as_str()),
        (127, "", "claude 를 찾을 수 없습니다\n")
    );
    assert!(f.ran().is_none());
}

/// 기존 래퍼와 같은 규칙: 있을 때만 붙인다. 붙이는 플래그는 어댑터 선언과 같다.
#[test]
fn claude_shim_injects_hook_args() {
    let srv = TestServer::fixed(200, NONE);
    let f = fixture(srv.port);
    f.run(&["x"]);
    assert_eq!(f.ran().unwrap().argv.len(), 2, "no assets → no flags");
    let settings = otterenv::agent_hooks_dir_in(&f.bin()).join("claude.json");
    let plugin = f.bin().join("agent-plugin");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(&settings, "{}").unwrap();
    fs::create_dir_all(&plugin).unwrap();
    f.run(&["x"]);
    let ran = f.ran().unwrap();
    let want = vec![
        ran.path.clone(),
        "--settings".into(),
        settings.to_str().unwrap().to_owned(),
        "--plugin-dir".into(),
        plugin.to_str().unwrap().to_owned(),
        "x".into(),
    ];
    assert_eq!(ran.argv, want);
    let joined = ran.argv.join(" ");
    for flag in otter_shared_agentadapter::get("claude")
        .unwrap()
        .policy_injection
        .flags
    {
        assert!(joined.contains(flag), "declared flag {flag:?} not injected");
    }
}

#[test]
fn claude_shim_user_config_dir_wins() {
    let srv = TestServer::fixed(200, NONE);
    let mut f = fixture(srv.port);
    f.env.set("CLAUDE_CONFIG_DIR", "/mine");
    assert_eq!(f.run(&[]).0, 7);
    assert!(srv.requests().is_empty(), "server must not be asked");
    assert_eq!(
        env_value(&f.ran().unwrap().env, "CLAUDE_CONFIG_DIR").as_deref(),
        Some("/mine")
    );
}

#[test]
fn claude_shim_applies_config_dir() {
    let srv = TestServer::new(|r: &Req| {
        if r.method != "POST" || r.path() != "/api/claude-accounts/launch" {
            return (404, b"bad\n".to_vec());
        }
        (
            200,
            br#"{"accountId":"a1","source":"tab","configDir":"/p/a1"}"#.to_vec(),
        )
    });
    let f = fixture(srv.port);
    assert_eq!(f.run(&[]).0, 7);
    assert_eq!(
        env_value(&f.ran().unwrap().env, "CLAUDE_CONFIG_DIR").as_deref(),
        Some("/p/a1")
    );
    let reqs = srv.requests();
    let wd = std::env::current_dir().unwrap();
    assert_eq!(
        reqs[0].json(),
        json!({"cwd": wd.to_str().unwrap(), "toolId": "tool-1"})
    );
    assert_eq!(
        String::from_utf8(reqs[0].body.clone()).unwrap(),
        json!({"cwd": wd.to_str().unwrap(), "toolId": "tool-1"}).to_string()
    );
}

/// D-CAC-25: 오류·시간 초과면 실행하지 않는다.
#[test]
fn claude_shim_server_error_refuses() {
    let srv = TestServer::fixed(
        500,
        r#"{"code":"internal","message":"profile preparation failed"}"#,
    );
    let f = fixture(srv.port);
    let (code, _, err) = f.run(&[]);
    assert_eq!(code, 1);
    assert_eq!(
        err,
        "otterminal: Claude 계정 지정을 적용하지 못했습니다 (HTTP 500 internal)\n"
    );
    assert!(f.ran().is_none());
}

#[test]
fn claude_shim_bad_reply_refuses() {
    let srv = TestServer::fixed(200, "not json");
    let f = fixture(srv.port);
    let (code, _, err) = f.run(&[]);
    assert_eq!(code, 1);
    assert_eq!(
        err,
        "otterminal: Claude 계정 지정을 적용하지 못했습니다 (서버 응답을 읽을 수 없음)\n"
    );
    let srv = TestServer::fixed(404, "");
    let f = fixture(srv.port);
    assert_eq!(
        f.run(&[]).2,
        "otterminal: Claude 계정 지정을 적용하지 못했습니다 (HTTP 404)\n"
    );
}

#[test]
fn claude_shim_timeout_refuses() {
    let srv = TestServer::new(|_: &Req| {
        thread::sleep(Duration::from_millis(500));
        (200, NONE.as_bytes().to_vec())
    });
    let mut f = fixture(srv.port);
    f.env.shim_budget = Some(Duration::from_millis(50));
    let (code, _, err) = f.run(&[]);
    assert_eq!(code, 1);
    assert_eq!(
        err,
        "otterminal: Claude 계정 지정을 적용하지 못했습니다 (서버가 제때 답하지 않음)\n"
    );
    assert!(f.ran().is_none());
}

/// D-CAC-25: 서버가 꺼져 있으면(연결 거부) 기본 계정으로 실행한다.
#[test]
fn claude_shim_server_down_runs_default() {
    let f = fixture(closed_port());
    let (code, _, err) = f.run(&[]);
    assert_eq!((code, err.as_str()), (7, ""));
    assert_eq!(f.ran().unwrap().path, f.real);
}

// ---- 주입 메모리 (TC-AMI-2·3·4) ----

fn memory_fixture(srv: &TestServer, with_memory: bool) -> (Fixture, PathBuf) {
    let mut f = fixture(srv.port);
    let plugin = f.bin().join("agent-memory");
    fs::create_dir_all(&plugin).unwrap();
    if with_memory {
        fs::write(plugin.join("CLAUDE.md"), "# m\n").unwrap();
    }
    f.env.set(ADD_DIR_MEMORY_ENV, "");
    (f, plugin)
}

#[test]
fn claude_shim_injects_memory_prompt() {
    let srv = TestServer::fixed(200, NONE);
    let (f, plugin) = memory_fixture(&srv, true);
    f.run(&["질문"]);
    let ran = f.ran().unwrap();
    assert_eq!(
        ran.argv,
        vec![
            ran.path.clone(),
            "--append-system-prompt=# m\n".into(),
            "질문".into()
        ]
    );
    // D-AMI-1: 폴더를 열지 않는다 — 신뢰 확인창과 접근 권한이 따라온다 (FR-AMI-9).
    let plugin = plugin.to_str().unwrap();
    assert!(
        ran.argv
            .iter()
            .all(|a| !a.starts_with("--add-dir") && !a.contains(plugin))
    );
    assert!(env_value(&ran.env, ADD_DIR_MEMORY_ENV).is_none_or(|v| v.is_empty()));
}

#[test]
fn claude_shim_keeps_user_memory_env() {
    let srv = TestServer::fixed(200, NONE);
    let (mut f, _) = memory_fixture(&srv, true);
    f.env.set(ADD_DIR_MEMORY_ENV, "0");
    f.run(&[]);
    assert_eq!(
        env_value(&f.ran().unwrap().env, ADD_DIR_MEMORY_ENV).as_deref(),
        Some("0")
    );
}

#[test]
fn claude_shim_no_memory_no_prompt() {
    let srv = TestServer::fixed(200, NONE);
    let (f, _) = memory_fixture(&srv, false);
    f.run(&["x"]);
    assert!(
        f.ran()
            .unwrap()
            .argv
            .iter()
            .all(|a| !a.starts_with("--append-system-prompt") && !a.starts_with("--add-dir"))
    );
}

/// FR-AMI-4: 빈 파일은 붙이지 않는다.
#[test]
fn claude_shim_empty_memory_no_prompt() {
    let srv = TestServer::fixed(200, NONE);
    let (f, plugin) = memory_fixture(&srv, true);
    fs::write(plugin.join("CLAUDE.md"), "").unwrap();
    f.run(&["x"]);
    assert!(
        f.ran()
            .unwrap()
            .argv
            .iter()
            .all(|a| !a.starts_with("--append-system-prompt"))
    );
}

// ---- 채팅 MCP 주입 (TC-PCH-15) ----

fn listen_at(home: &Path) -> otter_shared_platform::IpcListener {
    let sock = chatwire::socket_path(home);
    fs::create_dir_all(sock.parent().unwrap()).unwrap();
    otter_shared_platform::current().ipc.listen(&sock).unwrap()
}

/// home 에 채팅 소켓을 연다. 받은 연결마다 serve 를 부른다.
fn listen_chat(home: &Path, serve: fn(otter_shared_platform::IpcStream)) {
    let ln = listen_at(home);
    thread::spawn(move || {
        while let Ok(c) = ln.accept() {
            thread::spawn(move || serve(c));
        }
    });
}

fn chat_shim_run(socket: bool) -> (Fixture, ShimRun) {
    let srv = TestServer::fixed(200, NONE);
    let f = fixture(srv.port);
    if socket {
        listen_chat(f.home(), |_| {});
    }
    f.run(&["--mcp-config", "user.json", "질문"]);
    let ran = f.ran().unwrap();
    (f, ran)
}

#[test]
fn claude_shim_injects_chat_mcp() {
    let (f, ran) = chat_shim_run(true);
    let home = f.home().to_str().unwrap();
    let n = ran.argv.len();
    assert!(n >= 5, "{:?}", ran.argv);
    assert_eq!(
        ran.argv[n - 3..].join("|"),
        "--mcp-config|user.json|질문",
        "사용자 인자가 끝에 그대로 있지 않다"
    );
    assert_eq!(ran.argv[n - 4], "--allowedTools=mcp__otterminal");
    assert_eq!(
        ran.argv[n - 5],
        format!(
            "--mcp-config={{\"mcpServers\":{{\"otterminal\":{{\"args\":[\"chat-mcp\"],\"command\":\"{home}/bin/otterctl\",\"env\":{{\"OTTERMINAL_HOME\":\"{home}\",\"OTTERMINAL_TOOL_ID\":\"tool-1\"}},\"type\":\"stdio\"}}}}}}"
        )
    );
}

#[test]
fn claude_shim_no_chat_without_socket() {
    let (_f, ran) = chat_shim_run(false);
    assert!(
        ran.argv
            .iter()
            .all(|a| !a.starts_with("--mcp-config=") && !a.starts_with("--allowedTools")),
        "소켓이 없는데 주입했다: {:?}",
        ran.argv
    );
}

#[test]
fn claude_shim_no_chat_without_tool() {
    let srv = TestServer::fixed(200, NONE);
    let mut f = fixture(srv.port);
    f.env.set(otterenv::ENV_TOOL_ID, "");
    listen_chat(f.home(), |_| {});
    f.run(&[]);
    assert!(
        f.ran()
            .unwrap()
            .argv
            .iter()
            .all(|a| !a.starts_with("--mcp-config=")),
        "도구 id 없이 주입했다"
    );
}

// ---- ctx-hook 의 안 읽은 글 줄 (FR-PCH-60) ----

fn chat_hook_run(verdict: &str, total: i64) -> String {
    let home = short_dir();
    let ln = listen_at(home.path());
    let asked = thread::spawn(move || {
        let mut c = ln.accept().unwrap();
        let mut line = String::new();
        BufReader::new(&mut c).read_line(&mut line).unwrap();
        let b = chatwire::encode(&chatwire::Frame {
            t: chatwire::TYPE_UNREAD.to_owned(),
            total,
            ..Default::default()
        })
        .unwrap();
        let _ = c.write_all(&b);
        line
    });
    let srv = TestServer::fixed(200, verdict);
    let mut env = srv.env(home.path());
    env.set(otterenv::ENV_HOME, home.path().to_str().unwrap());
    let (rc, out, _) = run_with(
        &env,
        run_otterctl_ctx_hook,
        &["claude"],
        br#"{"hook_event_name":"PostToolUse","session_id":"s-1"}"#,
    );
    assert_eq!(rc, 0);
    assert_eq!(
        asked.join().unwrap(),
        "{\"t\":\"unread\",\"session\":\"s-1\"}\n"
    );
    out
}

#[test]
fn ctx_hook_no_unread_no_line() {
    assert_eq!(chat_hook_run(r#"{"verdict":"none"}"#, 0), "");
}

#[test]
fn ctx_hook_joins_advice_and_unread() {
    let out = chat_hook_run(r#"{"verdict":"unknown"}"#, 2);
    let got: Value = serde_json::from_str(&out).unwrap();
    let ctx = got["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    let lines: Vec<&str> = ctx.split('\n').collect();
    assert_eq!(lines.len(), 2, "{ctx}");
    assert!(lines[0].contains("맥락 사용률을 읽을 수 없어"), "{ctx}");
    assert!(lines[1].contains("읽지 않은 글 2건"), "{ctx}");
}
