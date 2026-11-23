//! `dmctl statusline`·`subagent-statusline` — Claude Code 의 statusLine 프록시 (FR-SLP-1~8,
//! FR-SAU-6~8). 받은 값을 서버에 남기고, 같은 입력을 원래 등록된 하위 명령에 그대로 넘긴다.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use dm_gocompat::json::{self, RawMessage};
use dm_shared_agentrec::{self as agentrec, ReportAccount};
use dm_shared_apipath as apipath;
use dm_shared_dmenv as dmenv;
use dm_shared_statusline::{self as statusline, Subagent, Usage};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::budgets::SL_REPORT_BUDGET;
use crate::ctx::{Ctx, Env};
use crate::report::post_report;

/// dongminal 자신의 statusLine·subagentStatusLine 명령이다 — 하위 명령으로 고르면 재귀다.
static SL_SELF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"dmctl["']?\s+(subagent-)?statusline\b"#).expect("고정된 정규식")
});

/// 하위 명령을 찾는 설정 키다 (D-SAU-5).
pub(crate) const STATUS_LINE_KEY: &str = "statusLine";
pub(crate) const SUBAGENT_STATUS_LINE_KEY: &str = "subagentStatusLine";
const ENV_CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";

/// 두 프록시가 설정을 찾고 보고 대상을 정하는 데 쓰는 환경 값이다.
#[derive(Clone, Debug, Default)]
pub(crate) struct SlEnv {
    pub home: String,
    pub config_dir: String,
    pub tool_id: String,
}

impl SlEnv {
    fn from(env: &Env) -> Self {
        let mut home = env.get("HOME");
        if home.is_empty() {
            home = env.get("USERPROFILE");
        }
        Self {
            home,
            config_dir: env.get(ENV_CLAUDE_CONFIG_DIR),
            tool_id: env.get(dmenv::ENV_TOOL_ID),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct SlCommand {
    #[serde(rename = "type")]
    kind: String,
    command: String,
}

/// dongminal 이 없을 때 Claude Code 가 실행했을 key 의 명령이다 (FR-SLP-4·FR-SAU-7).
/// 우선순위: 프로젝트 local → 프로젝트 → 사용자.
pub(crate) fn statusline_downstream(project_dir: &str, env: &SlEnv, key: &str) -> String {
    let user_dir = if env.config_dir.is_empty() {
        Path::new(&env.home).join(".claude")
    } else {
        PathBuf::from(&env.config_dir)
    };
    let mut files = Vec::new();
    if !project_dir.is_empty() {
        let p = Path::new(project_dir).join(".claude");
        files.push(p.join("settings.local.json"));
        files.push(p.join("settings.json"));
    }
    files.push(user_dir.join("settings.json"));
    let mut cmds = Vec::new();
    for f in files {
        let Ok(blob) = std::fs::read(&f) else {
            continue;
        };
        let Ok(s) = json::unmarshal::<BTreeMap<String, RawMessage>>(&blob) else {
            continue;
        };
        // 어느 설정이든 훅을 모두 끄라고 했으면 Claude Code 가 실행하지 않았을 명령이다.
        if s.get("disableAllHooks")
            .is_some_and(|raw| json::unmarshal::<bool>(&raw.0).unwrap_or(false))
        {
            return String::new();
        }
        if let Some(c) = s
            .get(key)
            .and_then(|raw| json::unmarshal::<SlCommand>(&raw.0).ok())
        {
            cmds.push(c);
        }
    }
    cmds.into_iter()
        .map(|c| (c.kind, c.command.trim().to_owned()))
        .find(|(kind, cmd)| kind == "command" && !cmd.is_empty() && !SL_SELF.is_match(cmd))
        .map(|(_, cmd)| cmd)
        .unwrap_or_default()
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Workspace {
    project_dir: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ProjectIn {
    workspace: Workspace,
}

/// 프로젝트 설정을 찾는 기준이다. `workspace.project_dir` 만 쓰고, 없으면 이 프로세스의
/// 작업 폴더다 (TC-SLP-5).
pub(crate) fn statusline_project_dir(raw: &[u8]) -> String {
    if let Ok(v) = json::unmarshal::<ProjectIn>(raw)
        && !v.workspace.project_dir.is_empty()
    {
        return v.workspace.project_dir;
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 보고 본문이다. Go 의 map 과 같은 키 순서(정렬)로 둔다.
#[derive(Serialize)]
struct UsageBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<ReportAccount>,
    #[serde(rename = "toolId")]
    tool_id: &'a str,
    usage: Usage,
}

#[derive(Serialize)]
struct SubagentsBody<'a> {
    tasks: Vec<Subagent>,
    #[serde(rename = "toolId")]
    tool_id: &'a str,
}

fn read_all(ctx: &mut Ctx<'_>) -> Vec<u8> {
    let mut raw = Vec::new();
    let _ = ctx.inp.read_to_end(&mut raw);
    raw
}

pub(crate) fn run_dmctl_statusline(ctx: &mut Ctx<'_>, _args: &[String]) -> i32 {
    let raw = read_all(ctx);
    let env = SlEnv::from(ctx.env);
    if !env.tool_id.is_empty()
        && let Some(u) = statusline::from_input(&raw)
    {
        let body = UsageBody {
            account: statusline_account(&env),
            tool_id: &env.tool_id,
            usage: u,
        };
        let _ = post_report(
            ctx.env,
            agentrec::METHOD_USAGE,
            apipath::TOOLS_USAGE,
            &body,
            SL_REPORT_BUDGET,
        );
    }
    let cmd = statusline_downstream(&statusline_project_dir(&raw), &env, STATUS_LINE_KEY);
    sl_pass_through(ctx, &raw, &cmd)
}

/// 하위 명령이 없으면 아무것도 출력하지 않는다 (FR-SAU-8).
pub(crate) fn run_dmctl_subagent_statusline(ctx: &mut Ctx<'_>, _args: &[String]) -> i32 {
    let raw = read_all(ctx);
    let env = SlEnv::from(ctx.env);
    if !env.tool_id.is_empty()
        && let Some(tasks) = statusline::subagents_from_input(&raw)
    {
        let body = SubagentsBody {
            tasks,
            tool_id: &env.tool_id,
        };
        let _ = post_report(
            ctx.env,
            agentrec::METHOD_SUBAGENTS,
            apipath::TOOLS_SUBAGENTS,
            &body,
            SL_REPORT_BUDGET,
        );
    }
    let cmd = statusline_downstream(
        &statusline_project_dir(&raw),
        &env,
        SUBAGENT_STATUS_LINE_KEY,
    );
    sl_pass_through(ctx, &raw, &cmd)
}

/// 하위 명령에 받은 입력을 그대로 넘기고 그 종료 코드를 돌려준다. 명령이 없으면 0 이다.
/// 셸 고르기는 platform 이 진다 (FR-SLP-8).
fn sl_pass_through(ctx: &mut Ctx<'_>, raw: &[u8], cmd: &str) -> i32 {
    if cmd.is_empty() {
        return 0;
    }
    let argv = dm_shared_platform::current().shell.run_command(cmd);
    let Some((prog, rest)) = argv.split_first() else {
        return 1;
    };
    let Ok(prog) = dm_shared_platform::command_path(prog) else {
        return 1;
    };
    let Ok(mut child) = Command::new(prog)
        .args(rest)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    else {
        return 1;
    };
    let feeder = child.stdin.take().map(|mut w| {
        let raw = raw.to_vec();
        std::thread::spawn(move || {
            let _ = w.write_all(&raw);
        })
    });
    let Ok(out) = child.wait_with_output() else {
        return 1;
    };
    if let Some(f) = feeder {
        let _ = f.join();
    }
    let _ = ctx.out.write_all(&out.stdout);
    let _ = ctx.err.write_all(&out.stderr);
    out.status.code().unwrap_or(-1)
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct OAuthAccount {
    #[serde(rename = "emailAddress")]
    email: String,
    #[serde(rename = "organizationUuid")]
    org: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct ClaudeJson {
    #[serde(rename = "oauthAccount")]
    oauth_account: OAuthAccount,
}

/// 그 세션의 설정 폴더(`CLAUDE_CONFIG_DIR`, 없으면 홈)의 `.claude.json` 에서 로그인한 계정을
/// 읽는다 (FR-CAC-78). 읽지 못하면 `None` 이다.
pub(crate) fn statusline_account(env: &SlEnv) -> Option<ReportAccount> {
    let dir = if env.config_dir.is_empty() {
        &env.home
    } else {
        &env.config_dir
    };
    if dir.is_empty() {
        return None;
    }
    let b = std::fs::read(Path::new(dir).join(".claude.json")).ok()?;
    let v = json::unmarshal::<ClaudeJson>(&b).ok()?;
    if v.oauth_account.email.is_empty() {
        return None;
    }
    Some(ReportAccount {
        email: v.oauth_account.email,
        org_uuid: v.oauth_account.org,
    })
}
