//! `dmctl` — dongminal 워크스페이스 원격 제어 CLI.

pub(crate) mod listworkspace;
pub(crate) mod notify;
pub(crate) mod order;
pub(crate) mod post;
pub(crate) mod rename;
pub(crate) mod rows;
pub(crate) mod run;
pub(crate) mod runhttp;
pub(crate) mod status;
pub(crate) mod toolio;
pub(crate) mod unported;
pub(crate) mod whoami;

use serde_json::{Map, Value};

use crate::argparse::{ArgError, ArgSpec, atoi, is_help_arg, unknown_arg};
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::DMCTL_HELP;
use crate::http::self_tool_id;
use order::{set_positive_int, set_uuid};
use post::dmctl_post;
use rename::{RenameWant, dmctl_rename_confirmed};

type Raw = fn(&mut Ctx<'_>, &str, &[String]) -> i32;
type Flagged = fn(&mut Ctx<'_>, &str, &mut DmctlParsed) -> i32;

/// dmctl 의 명령 하나다 (FR-RGS-43).
enum Command {
    /// 자기 인자를 스스로 읽는다.
    Raw(Raw),
    /// 레이아웃 플래그(parse_dmctl_flags)를 읽은 뒤 돈다.
    Flagged(Flagged),
    /// 플래그를 실어 그대로 보내는 원격 액션이다.
    Action(&'static str),
}

fn command(name: &str) -> Option<Command> {
    use Command::{Action, Flagged, Raw};
    Some(match name {
        "-h" | "--help" | "help" => Raw(|ctx, _, _| {
            outf!(ctx, "{DMCTL_HELP}");
            0
        }),
        "run" => Raw(|ctx, _, a| run::run_dmctl_run(ctx, a)),
        "send" => Raw(|ctx, _, a| post::dmctl_send(ctx, a)),
        "list-workspace" => Raw(|ctx, _, a| listworkspace::dmctl_list_workspace(ctx, a)),
        "who-am-i" => Raw(|ctx, _, a| whoami::dmctl_who_am_i(ctx, a)),
        "notify" => Raw(|ctx, _, a| notify::run_dmctl_notify(ctx, a)),
        "activity"
        | "agent-context"
        | "ctx-hook"
        | "chat-mcp"
        | "edges"
        | "edge"
        | "account"
        | "statusline"
        | "subagent-statusline" => Raw(unported::run),
        "read-screen" | "read-output" => Raw(toolio::run_dmctl_read),
        "send-input" => Raw(|ctx, _, a| toolio::run_dmctl_send_input(ctx, a)),
        "msg" => Raw(|ctx, _, a| toolio::run_dmctl_msg(ctx, a)),
        "open-editor" => Raw(|ctx, _, a| toolio::run_dmctl_open_editor(ctx, a)),
        "open-url" => Raw(|ctx, _, a| crate::openurl::run_open_url(ctx, a)),
        "status" => Raw(|ctx, _, a| status::run_dmctl_status(ctx, a)),
        "wait" => Raw(|ctx, _, a| status::run_dmctl_wait(ctx, a)),
        "move-tab" | "move-window" | "move-group" => Raw(order::run_dmctl_move),
        "new-group" | "rename-group" | "delete-group" => Raw(order::run_dmctl_group),
        "list-groups" => Raw(|ctx, _, a| order::run_dmctl_list_groups(ctx, a)),

        "split-h" | "split-v" => Flagged(run_dmctl_split),
        "focus" => Flagged(run_dmctl_focus),
        "rename-tab" | "rename-window" => Flagged(run_dmctl_rename),
        "close-tab" | "close-window" => Flagged(run_dmctl_close),

        "new-window" => Action("newWindow"),
        "new-tab" => Action("newTab"),
        "window-next" => Action("windowNext"),
        "window-prev" => Action("windowPrev"),
        "tab-next" => Action("tabNext"),
        "tab-prev" => Action("tabPrev"),
        "tool-up" => Action("paneUp"),
        "tool-down" => Action("paneDown"),
        "tool-left" => Action("paneLeft"),
        "tool-right" => Action("paneRight"),
        _ => return None,
    })
}

pub(crate) fn run_dmctl(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let Some(cmd) = args.first() else {
        outf!(ctx, "{DMCTL_HELP}");
        return 0;
    };
    let rest = &args[1..];
    let c = command(cmd);
    if let Some(Command::Raw(f)) = c {
        return f(ctx, cmd, rest);
    }
    // NFR-ORD-1: 도움말을 청한 레이아웃 명령은 서버에 아무것도 보내지 않는다.
    if rest.iter().any(|a| is_help_arg(a)) {
        outf!(ctx, "{DMCTL_HELP}");
        return 0;
    }
    let mut parsed = match parse_dmctl_flags(rest) {
        Ok(p) => p,
        Err(e) => {
            errf!(ctx, "{e}\n");
            return 2;
        }
    };
    if let Some(Command::Flagged(f)) = c {
        return f(ctx, cmd, &mut parsed);
    }
    // FR-M9-4: 두 플래그는 닫기의 것이다.
    if parsed.force || parsed.background {
        errf!(
            ctx,
            "--force·--background 는 close-tab·close-window 에만 쓴다 ({cmd})\n"
        );
        return 2;
    }
    let Some(Command::Action(action)) = c else {
        errf!(ctx, "unknown command: {cmd}\n");
        errf!(ctx, "{DMCTL_HELP}");
        return 2;
    };
    // FR-WBR-22: 새 창은 누가 열었든 홈에서 뜬다 — 호출자의 도구를 싣지 않는다.
    let args = parsed.build_args();
    dmctl_post(ctx, action, Value::Object(args))
}

fn run_dmctl_split(ctx: &mut Ctx<'_>, cmd: &str, parsed: &mut DmctlParsed) -> i32 {
    let action = if cmd == "split-v" { "splitV" } else { "splitH" };
    if !parsed.positional.is_empty() {
        let n = match atoi(&parsed.positional) {
            Some(n) if n >= 0 => n,
            _ => {
                errf!(
                    ctx,
                    "split count must be a positive integer: {}\n",
                    parsed.positional
                );
                return 2;
            }
        };
        if n < 2 {
            errf!(ctx, "split count must be >= 2\n");
            return 2;
        }
        parsed.count = Some(n);
    }
    dmctl_post(ctx, action, Value::Object(parsed.build_args()))
}

/// `close-tab`·`close-window` (FR-M9-4 / D-M9-4). 브라우저의 확인창에 답할 손이 없으므로 답을
/// 미리 싣는다: `--force` → `force:true`, `--background` → `force:true`+`keepTool:true`.
fn run_dmctl_close(ctx: &mut Ctx<'_>, cmd: &str, parsed: &mut DmctlParsed) -> i32 {
    if parsed.force && parsed.background {
        errf!(
            ctx,
            "--force 와 --background 는 함께 쓸 수 없다 (닫기의 답은 하나다)\n"
        );
        return 2;
    }
    let mut args = parsed.build_args();
    if parsed.force || parsed.background {
        args.insert("force".into(), Value::Bool(true));
    }
    if parsed.background {
        args.insert("keepTool".into(), Value::Bool(true));
    }
    let action = if cmd == "close-window" {
        "closeWindow"
    } else {
        "closeTab"
    };
    dmctl_post(ctx, action, Value::Object(args))
}

fn run_dmctl_focus(ctx: &mut Ctx<'_>, _cmd: &str, parsed: &mut DmctlParsed) -> i32 {
    if parsed.location.is_empty() && !parsed.positional.is_empty() {
        parsed.location = parsed.positional.clone();
    }
    if parsed.location.is_empty() {
        errf!(
            ctx,
            "usage: dmctl focus <uuid>  (list-workspace 의 uuid 컬럼 값)\n"
        );
        return 2;
    }
    let mut args = parsed.build_args();
    // 브라우저가 이 도구를 보이는 창에만 포커스를 보내게 한다 (다중 창).
    let pid = self_tool_id(ctx.env);
    if !pid.is_empty() {
        args.insert("sourcePane".into(), Value::from(pid));
    }
    dmctl_post(ctx, "focus", Value::Object(args))
}

fn run_dmctl_rename(ctx: &mut Ctx<'_>, cmd: &str, parsed: &mut DmctlParsed) -> i32 {
    let action = if cmd == "rename-window" {
        "renameWindow"
    } else {
        "renameTab"
    };
    if parsed.name.is_empty() && !parsed.positional.is_empty() {
        parsed.name = parsed.positional.clone();
    }
    // FR-TAN-22: --auto 는 이름의 출처를 되돌린다. 이름과 함께 오면 거부한다.
    if parsed.auto {
        if cmd != "rename-tab" {
            errf!(
                ctx,
                "--auto 는 rename-tab 에만 쓴다 (창 이름에는 출처가 없다)\n"
            );
            return 2;
        }
        if !parsed.name.is_empty() {
            errf!(ctx, "--auto 와 이름은 함께 쓸 수 없다\n");
            return 2;
        }
        if parsed.location.is_empty() {
            errf!(ctx, "usage: dmctl rename-tab --at <uuid> --auto\n");
            return 2;
        }
        let want = RenameWant {
            tab_id: parsed.location.clone(),
            auto: true,
            ..Default::default()
        };
        return dmctl_rename_confirmed(ctx, action, parsed.build_args(), want);
    }
    if parsed.location.is_empty() || parsed.name.is_empty() {
        errf!(
            ctx,
            "usage: dmctl {cmd} --at <uuid> <name>  (또는 --name <name>)\n"
        );
        return 2;
    }
    let want = RenameWant {
        tab_id: parsed.location.clone(),
        name: parsed.name.clone(),
        window: cmd == "rename-window",
        auto: false,
    };
    dmctl_rename_confirmed(ctx, action, parsed.build_args(), want)
}

/// 레이아웃 명령의 인자다.
#[derive(Default, Debug)]
pub(crate) struct DmctlParsed {
    pub location: String,
    pub count: Option<i64>,
    pub keep_focus: bool,
    pub name: String,
    pub auto: bool,
    pub sandbox: String,
    pub workdir: String,
    pub cwd: String,
    pub positional: String,
    /// M9_SRS FR-M9-4: 닫기의 답. 둘은 배타다.
    pub force: bool,
    pub background: bool,
    /// ISSUE_AGENT_TREE_SRS FR-WGR-33 · FR-ORD-11: 만들 때의 자리.
    pub group: String,
    pub after: String,
    pub index: Option<i64>,
}

impl DmctlParsed {
    pub fn build_args(&self) -> Map<String, Value> {
        let mut out = Map::new();
        let mut put_str = |k: &str, v: &str| {
            if !v.is_empty() {
                out.insert(k.into(), Value::from(v));
            }
        };
        put_str("location", &self.location);
        put_str("name", &self.name);
        // FR-SBX-11·40, FR-WBR-23: 빈 값이면 키 자체를 싣지 않는다.
        put_str("sandbox", &self.sandbox);
        put_str("workdir", &self.workdir);
        put_str("cwd", &self.cwd);
        put_str("group", &self.group);
        put_str("after", &self.after);
        if let Some(c) = self.count {
            out.insert("count".into(), Value::from(c));
        }
        if self.keep_focus {
            out.insert("keepFocus".into(), Value::Bool(true));
        }
        if self.auto {
            out.insert("auto".into(), Value::Bool(true));
        }
        if let Some(i) = self.index {
            out.insert("index".into(), Value::from(i));
        }
        out
    }
}

pub(crate) fn parse_dmctl_flags(args: &[String]) -> Result<DmctlParsed, String> {
    let mut p = DmctlParsed::default();
    let mut positional = Vec::new();
    let spec = ArgSpec {
        vals: &[
            "--at",
            "-l",
            "--name",
            "--sandbox",
            "--workdir",
            "--cwd",
            "--group",
            "--after",
            "--index",
        ],
        bools: &["--no-focus", "-n", "--auto", "--force", "--background"],
        // -h/--help 는 최상위 도움말의 몫이다 — 여기서는 건너뛴다.
        rest: true,
        strict_eq: true,
        ..Default::default()
    };
    let parsed = spec.parse(args, &mut positional, &mut |k, v| {
        let v = v.unwrap_or_default();
        match k {
            "--at" | "-l" => p.location = v.to_owned(),
            "--name" => p.name = v.to_owned(),
            "--sandbox" => p.sandbox = v.to_owned(),
            "--workdir" => p.workdir = v.to_owned(),
            "--cwd" => p.cwd = v.to_owned(),
            "--group" => p.group = set_uuid(v)?,
            "--after" => p.after = set_uuid(v)?,
            "--index" => p.index = Some(set_positive_int(v)?),
            "--no-focus" | "-n" => p.keep_focus = true,
            "--auto" => p.auto = true,
            "--force" => p.force = true,
            _ => p.background = true,
        }
        Ok(())
    });
    match parsed {
        Err(ArgError::NeedsValue(a)) => return Err(format!("flag {a} requires value")),
        Err(ArgError::Unknown(a) | ArgError::Invalid(a, _)) => return Err(unknown_arg(&a)),
        Ok(_) => {}
    }
    p.positional = positional.join(" ");
    Ok(p)
}
