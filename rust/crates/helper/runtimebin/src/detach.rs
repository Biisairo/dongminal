//! `detach` — 현재 도구를 백그라운드로 보내고 탭을 닫는다 (FR-BG-2/6/7, FR-BGR-3, FR-BGP-3).

use std::io::Write;

use dm_gocompat::{json, strconv};
use dm_shared_apipath as apipath;
use dm_shared_dmenv as dmenv;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::argparse::{ArgError, ArgSpec, unknown_arg};
use crate::ctx::{Ctx, errf, outf};
use crate::dmctl::post::dmctl_delivery;
use crate::helptext::DETACH_HELP;
use crate::http::{
    ExitRule, HttpOut, base_url, http_exit, http_get, http_post_json, refuse_with, self_tool_id,
};

const DETACH_RESTORE_NEEDS_ID: &str = "--restore 는 도구 id 가 필요합니다 (detach --list 로 확인)";
const DETACH_AT_NEEDS_UUID: &str = "--at 은 탭 uuid 가 필요합니다 (dmctl list-workspace 로 확인)";

#[derive(Default, Debug)]
pub(crate) struct DetachFlags {
    pub do_list: bool,
    pub restore_id: String,
    pub at: String,
    /// 빈 문자열과 "주지 않았다" 를 가른다 — `--run ''` 는 오류이지 무동작이 아니다.
    pub run_cmd: String,
    pub has_run: bool,
    pub cwd: String,
}

fn detach_needs_value(flag: &str) -> &'static str {
    match flag {
        "--run" => "--run 은 실행할 명령이 필요합니다",
        "--cwd" => "--cwd 는 경로가 필요합니다",
        "--restore" | "-r" => DETACH_RESTORE_NEEDS_ID,
        "--at" => DETACH_AT_NEEDS_UUID,
        _ => "",
    }
}

/// `None` 이면 계속, `Some(code)` 이면 이미 답했다.
pub(crate) fn parse_detach_flags(ctx: &mut Ctx<'_>, args: &[String]) -> (DetachFlags, Option<i32>) {
    let mut f = DetachFlags::default();
    let spec = ArgSpec {
        help: DETACH_HELP,
        vals: &["--run", "--cwd", "--restore", "-r", "--at"],
        bools: &["--list", "-l"],
        ..Default::default()
    };
    let parsed = spec.parse(args, &mut Vec::new(), &mut |k, v| {
        let v = v.unwrap_or_default();
        match k {
            "--run" => {
                f.run_cmd = v.to_owned();
                f.has_run = true;
            }
            "--cwd" => f.cwd = v.to_owned(),
            "--restore" | "-r" => f.restore_id = v.to_owned(),
            "--at" => {
                if v.is_empty() {
                    return Err(DETACH_AT_NEEDS_UUID.to_owned());
                }
                f.at = v.to_owned();
            }
            _ => f.do_list = true,
        }
        Ok(())
    });
    let code = match parsed {
        Ok(true) => {
            outf!(ctx, "{DETACH_HELP}");
            Some(0)
        }
        Ok(false) => None,
        Err(e) => {
            match e {
                ArgError::NeedsValue(a) => errf!(ctx, "detach: {}\n", detach_needs_value(&a)),
                ArgError::Invalid(_, msg) => errf!(ctx, "detach: {msg}\n"),
                ArgError::Unknown(a) => {
                    errf!(ctx, "detach: {}\n", unknown_arg(&a));
                    errf!(ctx, "{DETACH_HELP}");
                }
            }
            Some(2)
        }
    };
    (f, code)
}

pub(crate) fn run_detach(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let (f, code) = parse_detach_flags(ctx, args);
    if let Some(code) = code {
        return code;
    }
    if f.has_run {
        if f.run_cmd.trim().is_empty() {
            errf!(ctx, "detach: --run 은 실행할 명령이 필요합니다\n");
            return 2;
        }
        if f.do_list || !f.restore_id.is_empty() || !f.at.is_empty() {
            errf!(
                ctx,
                "detach: --run 은 --list·--restore·--at 과 함께 쓸 수 없습니다\n"
            );
            return 2;
        }
        return detach_run(ctx, &f.run_cmd, &f.cwd);
    }
    if !f.cwd.is_empty() {
        errf!(ctx, "detach: --cwd 는 --run 과 함께만 씁니다\n");
        return 2;
    }
    if f.do_list {
        return detach_list(ctx);
    }
    if !f.restore_id.is_empty() {
        let mut args = Map::new();
        args.insert("toolId".into(), Value::from(f.restore_id.as_str()));
        if !f.at.is_empty() {
            args.insert("location".into(), Value::from(f.at.as_str()));
        }
        return detach_post(ctx, "restoreTool", Value::Object(args));
    }
    if !f.at.is_empty() {
        errf!(ctx, "detach: --at 은 --restore 와 함께만 씁니다\n");
        return 2;
    }
    let tool_id = self_tool_id(ctx.env);
    if tool_id.is_empty() {
        errf!(
            ctx,
            "detach: {} 미설정 (dongminal 터미널 안에서 실행해야 합니다)\n",
            dmenv::ENV_TOOL_ID
        );
        return 1;
    }
    detach_post(ctx, "detachTab", json!({"toolId": tool_id}))
}

fn detach_post(ctx: &mut Ctx<'_>, action: &str, args: Value) -> i32 {
    let r = http_post_json(
        &format!("{}{}", base_url(ctx.env), apipath::COMMANDS),
        &json!({"action": action, "args": args}),
    );
    match http_exit(ctx, r, detach_rule(true)) {
        Ok(body) => dmctl_delivery(ctx, "detach", &body),
        Err(code) => code,
    }
}

/// detach 의 응답 해석이다. with_body 면 거절 줄에 서버 본문을 싣는다.
fn detach_rule(with_body: bool) -> ExitRule<'static> {
    ExitRule {
        prefix: "detach",
        on_err: None,
        ok: None,
        refuse: refuse_with(move |w: &mut dyn Write, status, body: &[u8]| {
            if with_body {
                let _ = write!(w, "detach: 서버 오류 {status}: ");
                let _ = w.write_all(body);
                let _ = w.write_all(b"\n");
                return;
            }
            let _ = writeln!(w, "detach: 서버 오류 {status}");
        }),
    }
}

/// 백그라운드에 도구를 만들어 명령 하나를 돌린다 (FR-BGP-3). 브라우저를 거치지 않는다.
fn detach_run(ctx: &mut Ctx<'_>, cmdline: &str, cwd: &str) -> i32 {
    let mut body = Map::new();
    body.insert("command".into(), Value::from(cmdline));
    if !cwd.is_empty() {
        body.insert("cwd".into(), Value::from(cwd));
    }
    let r: HttpOut = http_post_json(
        &format!("{}{}", base_url(ctx.env), apipath::TOOLS_HEADLESS),
        &Value::Object(body),
    );
    let raw = match http_exit(ctx, r, detach_rule(true)) {
        Ok(b) => b,
        Err(code) => return code,
    };
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Resp {
        #[serde(rename = "toolId")]
        tool_id: String,
    }
    let tool_id = json::unmarshal::<Resp>(&raw).unwrap_or_default().tool_id;
    outf!(ctx, "background  toolId={tool_id}  cmd={cmdline}\n");
    outf!(
        ctx,
        "  명령이 끝나면 이 도구는 스스로 사라진다 — detach --list 로 확인\n"
    );
    0
}

fn detach_list(ctx: &mut Ctx<'_>) -> i32 {
    let r = http_get(&format!(
        "{}{}",
        base_url(ctx.env),
        apipath::TOOLS_BACKGROUND
    ));
    let body = match http_exit(ctx, r, detach_rule(false)) {
        Ok(b) => b,
        Err(code) => return code,
    };
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Item {
        #[serde(rename = "toolId")]
        tool_id: String,
        name: String,
        cwd: String,
        since: i64,
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Resp {
        background: Vec<Item>,
    }
    let resp = match json::unmarshal::<Resp>(&body) {
        Ok(r) => r,
        Err(e) => {
            errf!(ctx, "detach: 응답 파싱 실패: {e}\n");
            return 1;
        }
    };
    if resp.background.is_empty() {
        outf!(ctx, "백그라운드 도구 없음\n");
        return 0;
    }
    for b in &resp.background {
        let _ = b.since;
        outf!(
            ctx,
            "  toolId={}  name={}  cwd={}\n",
            b.tool_id,
            strconv::quote(&b.name),
            b.cwd
        );
    }
    0
}
