//! CLAUDE_ACCOUNTS_SRS FR-CAC-83 — claude shim. 셸 훅이 `agent-shims` 를 PATH 맨 앞에 두므로 탭에서
//! `claude` 를 치면 이것이 먼저 돈다. 훅 인자와 계정 프로필을 넣고 진짜 claude 를 실행한다.

use std::fs;
use std::io;
use std::path::Path;

use otter_gocompat::filepath;
use otter_gocompat::json;
use otter_shared_chatwire as chatwire;
use otter_shared_otterenv as otterenv;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::RunFn;
use crate::budgets::{SHIM_BUDGET, SHIM_CHAT_DIAL_WAIT};
use crate::ctx::{Ctx, Env, errf};
use crate::http::{base_url, http_json_within, self_tool_id};

pub(crate) const CLAUDE_CONFIG_DIR_ENV: &str = "CLAUDE_CONFIG_DIR";
/// 주입하는 MCP 서버 이름이다. 도구는 `mcp__otterminal__chat_*` 로 보인다.
pub(crate) const CHAT_MCP_SERVER: &str = "otterminal";

#[cfg(windows)]
const PATH_FOLD_CASE: bool = true;
#[cfg(not(windows))]
const PATH_FOLD_CASE: bool = false;

/// 등록부가 shim 으로 선언한 명령 이름의 진입점이다. 계정 지정(CLAUDE_CONFIG_DIR)은 Claude Code 의
/// 규약이다 — shim 을 선언한 에이전트는 claude 하나다.
///
/// `RunFn` 은 함수 포인터라 명령 이름을 붙잡지 못한다. 등록부 순서의 자리마다 진입점을 하나씩
/// 두고, 자리 번호로 이름을 다시 읽는다 (Go 판은 클로저로 이름을 붙잡았다).
pub(crate) fn runner(name: &str) -> Option<RunFn> {
    let i = otter_shared_agentadapter::shim_commands()
        .iter()
        .position(|c| *c == name)?;
    SHIM_RUNNERS.get(i).copied()
}

/// 등록부의 shim 명령 자리 수의 상한이다. 넘으면 시험 `helper_name_strips_executable_extension_only` 의
/// "shim 마다 helper 가 있다" 가 깨진다.
pub(crate) const SHIM_RUNNERS: [RunFn; 4] =
    [run_shim::<0>, run_shim::<1>, run_shim::<2>, run_shim::<3>];

fn run_shim<const I: usize>(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    match otter_shared_agentadapter::shim_commands().get(I) {
        Some(cmd) => run_agent_shim(ctx, cmd, args),
        None => 127,
    }
}

pub(crate) fn run_agent_shim(ctx: &mut Ctx<'_>, cmd: &str, args: &[String]) -> i32 {
    let env = ctx.env;
    let home = env.get(otterenv::ENV_HOME);
    let real = find_real_command(env, cmd, &env.get("PATH"), &shim_dir_of(&home));
    if real.is_empty() {
        errf!(ctx, "{cmd} 를 찾을 수 없습니다\n");
        return 127;
    }
    let mut argv = vec![real.clone()];
    argv.extend(shim_hook_args(cmd, &home));
    let mut environ = env.environ();
    let memory = shim_memory_prompt(&home);
    if !memory.is_empty() {
        // FR-AMI-2: 한 토큰으로 붙인다 — 공백 구분이면 값이 사용자 인자와 섞인다. `--add-dir` 는
        // 쓰지 않는다: 처음 보는 폴더마다 신뢰 확인창이 뜨고 접근 권한이 따라온다 (D-AMI-1).
        argv.push(format!("--append-system-prompt={memory}"));
    }
    argv.extend(shim_chat_args(&home, &self_tool_id(env)));
    argv.extend(args.iter().cloned());
    if env.get(CLAUDE_CONFIG_DIR_ENV).is_empty() {
        let (dir, reason) = claude_launch_dir(env);
        if !reason.is_empty() {
            errf!(
                ctx,
                "otterminal: Claude 계정 지정을 적용하지 못했습니다 ({reason})\n"
            );
            return 1;
        }
        if !dir.is_empty() {
            environ.push(format!("{CLAUDE_CONFIG_DIR_ENV}={dir}"));
        }
    }
    match &env.shim_exec {
        Some(f) => f(&real, &argv, &environ),
        None => exec_shim(ctx, &real, &argv, &environ),
    }
}

fn bin_of(home: &str) -> String {
    filepath::join(&[home, otterenv::BIN_DIR])
}

fn shim_dir_of(home: &str) -> String {
    if home.is_empty() {
        return String::new();
    }
    otterenv::agent_shims_dir_in(Path::new(&bin_of(home)))
        .to_string_lossy()
        .into_owned()
}

/// 기존 셸 래퍼와 같은 규칙으로, 있을 때만 붙이는 훅 인자다.
fn shim_hook_args(cmd: &str, home: &str) -> Vec<String> {
    if home.is_empty() {
        return Vec::new();
    }
    let bin = bin_of(home);
    let hooks = otterenv::agent_hooks_dir_in(Path::new(&bin));
    let settings = filepath::join(&[&*hooks.to_string_lossy(), &format!("{cmd}.json")]);
    let mut out = Vec::new();
    if fs::metadata(&settings).is_ok_and(|m| m.is_file()) {
        out.push("--settings".to_owned());
        out.push(settings);
    }
    let plugin = filepath::join(&[&bin, "agent-plugin"]);
    if fs::metadata(&plugin).is_ok_and(|m| m.is_dir()) {
        out.push("--plugin-dir".to_owned());
        out.push(plugin);
    }
    out
}

/// 채팅 MCP 주입 인자다 (PEER_CHAT_SRS FR-PCH-50, §3.10). 데몬의 채팅 소켓에 붙을 때만 붙인다 —
/// 옛 데몬·꺼진 데몬에서는 주입하지 않는다 (NFR-PCH-5). `=` 꼴 한 토큰이어야 가변 인자 옵션이
/// 사용자 인자를 삼키지 않는다. 도구 여덟 개는 허락 없이 쓴다 (D-PCH-36).
fn shim_chat_args(home: &str, tool: &str) -> Vec<String> {
    if home.is_empty() || tool.is_empty() {
        return Vec::new();
    }
    let p = otter_shared_platform::current();
    if p.ipc
        .dial(&chatwire::socket_path(Path::new(home)), SHIM_CHAT_DIAL_WAIT)
        .is_err()
    {
        return Vec::new();
    }
    let command = filepath::join(&[
        home,
        otterenv::BIN_DIR,
        &format!("otterctl{}", p.paths.exe_suffix()),
    ]);
    let mut env = Map::new();
    env.insert(otterenv::ENV_HOME.to_owned(), json!(home));
    env.insert(otterenv::ENV_TOOL_ID.to_owned(), json!(tool));
    let mut servers = Map::new();
    servers.insert(
        CHAT_MCP_SERVER.to_owned(),
        json!({"type": "stdio", "command": command, "args": ["chat-mcp"], "env": env}),
    );
    let Ok(blob) = json::marshal(&json!({ "mcpServers": servers })) else {
        return Vec::new();
    };
    vec![
        format!("--mcp-config={}", String::from_utf8_lossy(&blob)),
        format!("--allowedTools=mcp__{CHAT_MCP_SERVER}"),
    ]
}

/// 주입 메모리(agent-memory/CLAUDE.md)의 내용이다. 없거나 읽지 못하면 빈 값이다 — 그때는 주입
/// 없이 claude 를 띄운다 (FR-AMI-4).
fn shim_memory_prompt(home: &str) -> String {
    if home.is_empty() {
        return String::new();
    }
    let path = filepath::join(&[home, otterenv::BIN_DIR, "agent-memory", "CLAUDE.md"]);
    if !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
        return String::new();
    }
    fs::read(&path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

/// 서버에 이 실행의 계정을 묻는다. 서버가 꺼져 있으면(연결 거부) 기본 계정이다. reason 이 비지
/// 않으면 실행하지 않는다 (D-CAC-25).
fn claude_launch_dir(env: &Env) -> (String, String) {
    let mut body = Map::new();
    let id = self_tool_id(env);
    if !id.is_empty() {
        body.insert("toolId".to_owned(), json!(id));
    }
    let Ok(cwd) = std::env::current_dir() else {
        return (String::new(), "현재 폴더를 알 수 없음".to_owned());
    };
    body.insert("cwd".to_owned(), json!(cwd.to_string_lossy()));
    let url = format!(
        "{}{}",
        base_url(env),
        otter_shared_apipath::CLAUDE_ACCOUNTS_LAUNCH
    );
    let budget = env.shim_budget.unwrap_or(SHIM_BUDGET);
    let r = http_json_within("POST", &url, &Value::Object(body), budget);
    if r.err.is_some() {
        if r.refused {
            return (String::new(), String::new());
        }
        if r.timeout {
            return (String::new(), "서버가 제때 답하지 않음".to_owned());
        }
        return (String::new(), "서버에 연결하지 못함".to_owned());
    }
    if r.status != 200 {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct E {
            code: String,
        }
        let e = json::unmarshal::<E>(&r.body).unwrap_or_default();
        return (
            String::new(),
            format!("HTTP {} {}", r.status, e.code).trim().to_owned(),
        );
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Res {
        #[serde(rename = "configDir")]
        config_dir: String,
    }
    match json::unmarshal::<Res>(&r.body) {
        Ok(res) => (res.config_dir, String::new()),
        Err(_) => (String::new(), "서버 응답을 읽을 수 없음".to_owned()),
    }
}

/// PATH 에서 shim 폴더와, shim 자신과 같은 파일을 빼고 진짜 명령을 찾는다.
fn find_real_command(env: &Env, cmd: &str, path_env: &str, shim_dir: &str) -> String {
    let me = std::env::current_exe().ok();
    for dir in std::env::split_paths(path_env) {
        let dir = dir.to_string_lossy();
        if dir.is_empty() || same_path_dir(&dir, shim_dir) {
            continue;
        }
        for c in command_candidates(env, &dir, cmd) {
            let Ok(st) = fs::metadata(&c) else { continue };
            if !st.is_file() || !is_executable(&st) {
                continue;
            }
            if me.as_deref().is_some_and(|me| same_file(me, Path::new(&c))) {
                continue;
            }
            return c;
        }
    }
    String::new()
}

fn same_path_dir(a: &str, b: &str) -> bool {
    if b.is_empty() {
        return false;
    }
    let (a, b) = (filepath::clean(a), filepath::clean(b));
    if PATH_FOLD_CASE {
        return a.to_lowercase() == b.to_lowercase();
    }
    a == b
}

#[cfg(not(windows))]
fn command_candidates(_env: &Env, dir: &str, cmd: &str) -> Vec<String> {
    vec![filepath::join(&[dir, cmd])]
}

#[cfg(windows)]
fn command_candidates(env: &Env, dir: &str, cmd: &str) -> Vec<String> {
    let mut exts = env.get("PATHEXT");
    if exts.is_empty() {
        exts = ".COM;.EXE;.BAT;.CMD".to_owned();
    }
    exts.split(';')
        .filter(|e| !e.is_empty())
        .map(|e| filepath::join(&[dir, &format!("{cmd}{}", e.to_lowercase())]))
        .collect()
}

#[cfg(unix)]
fn is_executable(st: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    st.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_: &fs::Metadata) -> bool {
    true
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(a), fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn exec_error(e: &io::Error) -> String {
    e.raw_os_error()
        .map_or_else(|| e.to_string(), otter_gocompat::oserr::errno_string)
}

fn command_of(path: &str, argv: &[String], environ: &[String]) -> std::process::Command {
    let mut c = std::process::Command::new(path);
    c.args(argv.iter().skip(1)).env_clear();
    for kv in environ {
        if let Some((k, v)) = kv.split_once('=') {
            c.env(k, v);
        }
    }
    c
}

/// 자기 자신을 진짜 명령으로 바꾼다. 신호와 종료 코드가 그대로 간다 (FR-CAC-83 ⑥).
#[cfg(unix)]
fn exec_shim(ctx: &mut Ctx<'_>, path: &str, argv: &[String], environ: &[String]) -> i32 {
    use std::os::unix::process::CommandExt;
    let mut c = command_of(path, argv, environ);
    if let Some(a0) = argv.first() {
        c.arg0(a0);
    }
    otter_shared_platform::restore_nofile_on_exec(&mut c);
    let e = c.exec();
    errf!(
        ctx,
        "{} 를 실행하지 못했습니다: {}\n",
        filepath::base(path),
        exec_error(&e)
    );
    126
}

/// 진짜 claude 를 자식으로 띄우고 종료 코드를 그대로 돌려준다 (FR-CAC-83 ⑥).
#[cfg(not(unix))]
fn exec_shim(ctx: &mut Ctx<'_>, path: &str, argv: &[String], environ: &[String]) -> i32 {
    match command_of(path, argv, environ).status() {
        Ok(st) => st.code().unwrap_or(-1),
        Err(e) => {
            errf!(
                ctx,
                "{} 를 실행하지 못했습니다: {}\n",
                filepath::base(path),
                exec_error(&e)
            );
            126
        }
    }
}
