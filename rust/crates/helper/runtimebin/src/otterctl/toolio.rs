//! 에이전트 접합면의 CLI 절반이다 (SKILL_INJECTION_SRS 묶음 A): read-screen·read-output·
//! send-input·msg·open-editor.

use otter_gocompat::json;
use otter_shared_apipath as apipath;
use serde::Deserialize;
use serde_json::{Value, json};

use super::notify::go_string_bytes;
use super::parse_otterctl_flags;
use super::post::otterctl_post;
use super::whoami::encode_query;
use crate::argparse::{ArgSpec, atoi, is_help_arg};
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::{
    OTTERCTL_MSG_HELP, OTTERCTL_OPEN_EDITOR_HELP, OTTERCTL_READ_HELP, OTTERCTL_SEND_INPUT_HELP,
};
use crate::http::{api_result, base_url, http_get, http_post_json, self_tool_id};

const READ_SCREEN_DEFAULT_BYTES: i64 = 16384;
const READ_OUTPUT_DEFAULT_BYTES: i64 = 8192;

pub(crate) fn run_otterctl_read(ctx: &mut Ctx<'_>, cmd: &str, args: &[String]) -> i32 {
    let strip = cmd == "read-screen";
    let mut bytes_n = if strip {
        READ_SCREEN_DEFAULT_BYTES
    } else {
        READ_OUTPUT_DEFAULT_BYTES
    };
    let mut target = String::new();
    let spec = ArgSpec {
        help: OTTERCTL_READ_HELP,
        vals: &["--at", "-l", "--bytes"],
        ..Default::default()
    };
    let stop = spec.run(ctx, cmd, args, &mut Vec::new(), &mut |k, v| {
        let v = v.unwrap_or_default();
        if k == "--bytes" {
            match atoi(v) {
                Some(n) if n >= 0 => bytes_n = n,
                _ => return Err(format!("--bytes 는 0 이상의 정수여야 한다: {v}")),
            }
        } else {
            target = v.to_owned();
        }
        Ok(())
    });
    if let Some(code) = stop {
        return code;
    }
    if target.is_empty() {
        target = self_tool_id(ctx.env);
    }
    if target.is_empty() {
        errf!(
            ctx,
            "{cmd}: 대상 도구를 알 수 없다 — --at <uuid> 를 지정하라\n"
        );
        return 2;
    }
    let n = bytes_n.to_string();
    let mut q = vec![("id", target.as_str()), ("bytes", n.as_str())];
    if strip {
        q.push(("strip", "1"));
    }
    let url = format!(
        "{}{}?{}",
        base_url(ctx.env),
        apipath::TOOLS_OUTPUT,
        encode_query(&q)
    );
    let body = match api_result(ctx, apipath::TOOLS_OUTPUT, http_get(&url)) {
        Ok(b) => b,
        Err(code) => return code,
    };
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Rec {
        text: String,
        dropped: i64,
    }
    let rec = match json::unmarshal::<Rec>(&body) {
        Ok(r) => r,
        Err(e) => {
            errf!(ctx, "otterctl: invalid /api/tools/output response: {e}\n");
            return 1;
        }
    };
    // FR-DMA-3: read-screen·read-output 의 표시 규약.
    if rec.dropped > 0 {
        outf!(ctx, "dropped_bytes: {}\n", rec.dropped);
    }
    let mut text = rec.text;
    if text.is_empty() && strip {
        text = "(출력 없음)".to_owned();
    }
    outf!(ctx, "{text}");
    if !text.is_empty() && !text.ends_with('\n') {
        outf!(ctx, "\n");
    }
    0
}

#[derive(Default, Debug)]
pub(crate) struct SendInputFlags {
    pub target: String,
    pub execute: bool,
    pub positional: Vec<String>,
}

pub(crate) fn parse_send_input_flags(
    ctx: &mut Ctx<'_>,
    args: &[String],
) -> (SendInputFlags, Option<i32>) {
    let mut f = SendInputFlags::default();
    let spec = ArgSpec {
        help: OTTERCTL_SEND_INPUT_HELP,
        vals: &["--at", "-l"],
        bools: &["--execute", "-x"],
        rest: true,
        rest_help: true,
        dash: true,
        ..Default::default()
    };
    let (mut target, mut execute) = (String::new(), false);
    let stop = spec.run(ctx, "send-input", args, &mut f.positional, &mut |_, v| {
        match v {
            Some(v) => target = v.to_owned(),
            None => execute = true,
        }
        Ok(())
    });
    f.target = target;
    f.execute = execute;
    (f, stop)
}

pub(crate) fn run_otterctl_send_input(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let (f, stop) = parse_send_input_flags(ctx, args);
    if let Some(code) = stop {
        return code;
    }
    let mut target = f.target;
    if target.is_empty() {
        target = self_tool_id(ctx.env);
    }
    if target.is_empty() {
        errf!(
            ctx,
            "send-input: 대상 도구를 알 수 없다 — --at <uuid> 를 지정하라\n"
        );
        return 2;
    }
    let text = match read_body(ctx, &f.positional, "send-input") {
        Ok(t) => t,
        Err(code) => return code,
    };
    let r = http_post_json(
        &format!("{}{}", base_url(ctx.env), apipath::TOOLS_INPUT),
        &json!({"id": target, "text": go_string_bytes(&text), "execute": f.execute}),
    );
    if let Err(code) = api_result(ctx, apipath::TOOLS_INPUT, r) {
        return code;
    }
    let mode = if f.execute {
        "paste + 자동 엔터"
    } else {
        "타이핑만 (엔터 대기)"
    };
    outf!(
        ctx,
        "입력 주입 완료: target={target} textLen={} 모드={mode}\n",
        text.len()
    );
    0
}

#[derive(Default, Debug)]
pub(crate) struct MsgFlags {
    pub to: String,
    pub from: String,
    pub positional: Vec<String>,
}

pub(crate) fn parse_msg_flags(ctx: &mut Ctx<'_>, args: &[String]) -> (MsgFlags, Option<i32>) {
    let mut f = MsgFlags::default();
    let spec = ArgSpec {
        help: OTTERCTL_MSG_HELP,
        vals: &["--to", "--from"],
        rest: true,
        rest_help: true,
        dash: true,
        ..Default::default()
    };
    let (mut to, mut from) = (String::new(), String::new());
    let stop = spec.run(ctx, "msg", args, &mut f.positional, &mut |k, v| {
        let v = v.unwrap_or_default().to_owned();
        if k == "--to" {
            to = v;
        } else {
            from = v;
        }
        Ok(())
    });
    f.to = to;
    f.from = from;
    (f, stop)
}

pub(crate) fn run_otterctl_msg(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let (f, stop) = parse_msg_flags(ctx, args);
    if let Some(code) = stop {
        return code;
    }
    if f.to.is_empty() {
        errf!(
            ctx,
            "usage: otterctl msg --to <uuid> [--from <uuid>] <메시지>\n"
        );
        return 2;
    }
    let mut from = f.from;
    if from.is_empty() {
        from = self_tool_id(ctx.env);
    }
    let message = match read_body(ctx, &f.positional, "msg") {
        Ok(t) => t,
        Err(code) => return code,
    };
    let r = http_post_json(
        &format!("{}{}", base_url(ctx.env), apipath::TOOLS_MESSAGE),
        &json!({"to": f.to, "from": from, "message": go_string_bytes(&message)}),
    );
    let body = match api_result(ctx, apipath::TOOLS_MESSAGE, r) {
        Ok(b) => b,
        Err(code) => return code,
    };
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Rec {
        #[serde(rename = "toolId")]
        tool_id: String,
        from: String,
        to: String,
        len: i64,
        delivery: String,
    }
    let rec = match json::unmarshal::<Rec>(&body) {
        Ok(r) => r,
        Err(e) => {
            errf!(ctx, "otterctl: invalid /api/tools/message response: {e}\n");
            return 1;
        }
    };
    let _ = rec.tool_id;
    outf!(
        ctx,
        "에이전트 메시지 전송 완료: from={} → to={}, 본문 {} 자\n",
        rec.from,
        rec.to,
        rec.len
    );
    // AGENT_MSG_REWAKE_SRS FR-AMW-8.
    if rec.delivery == DELIVERY_QUEUED {
        outf!(
            ctx,
            "전달 대기: 받는 claude 가 쉬고 있으면 곧바로, 일하는 중이면 그 턴이 끝난 뒤 깨움 훅이 건넨다\n"
        );
    }
    0
}

/// `POST /api/tools/message` 응답의 `delivery` 중 대기열에 들어간 값이다 (FR-AMW-7).
const DELIVERY_QUEUED: &str = "queued";

pub(crate) fn run_otterctl_open_editor(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let parsed = match parse_otterctl_flags(args) {
        Ok(p) => p,
        Err(e) => {
            errf!(ctx, "open-editor: {e}\n");
            return 2;
        }
    };
    if args.iter().any(|a| is_help_arg(a)) {
        outf!(ctx, "{OTTERCTL_OPEN_EDITOR_HELP}");
        return 0;
    }
    if parsed.location.is_empty() || parsed.positional.is_empty() {
        errf!(
            ctx,
            "usage: otterctl open-editor --at <uuid> [--name <이름>] <파일 절대경로>\n"
        );
        return 2;
    }
    let mut cmd_args = parsed.build_args();
    cmd_args.insert("filePath".into(), Value::from(parsed.positional.as_str()));
    if parsed.name.is_empty() {
        cmd_args.insert("name".into(), Value::from(base_name(&parsed.positional)));
    }
    otterctl_post(ctx, "openEditorTab", Value::Object(cmd_args))
}

fn base_name(p: &str) -> &str {
    match p.rfind('/') {
        Some(i) if i + 1 < p.len() => &p[i + 1..],
        _ => p,
    }
}

/// 하위 명령의 본문: 위치 인자를 이은 것, 없거나 `-` 하나면 stdin (FR-DMA-4/5).
fn read_body(ctx: &mut Ctx<'_>, positional: &[String], cmd: &str) -> Result<Vec<u8>, i32> {
    let positional = if positional.len() == 1 && positional[0] == "-" {
        &[][..]
    } else {
        positional
    };
    if !positional.is_empty() {
        return Ok(positional.join(" ").into_bytes());
    }
    let mut data = Vec::new();
    if let Err(e) = ctx.inp.read_to_end(&mut data) {
        errf!(
            ctx,
            "{cmd}: stdin 읽기 실패: {}\n",
            otter_gocompat::oserr::go_error_string(&e)
        );
        return Err(1);
    }
    if data.is_empty() {
        errf!(
            ctx,
            "{cmd}: 본문이 비었다 — 인자로 주거나 stdin 으로 넘겨라\n"
        );
        return Err(2);
    }
    Ok(data)
}
