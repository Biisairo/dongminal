//! VIEWER_URL_OPEN_SRS — 셸이 띄우려는 URL 을 보고 있는 기기에서 연다. 서버에게 어디서 열지만
//! 묻고, "local" 이면 이 셸이 직접 연다 (FR-VUO-2).

use std::io::Write;

use dm_gocompat::json;
use dm_shared_apipath as apipath;
use serde::Deserialize;
use serde_json::json;

use crate::ctx::{Ctx, errf, outf};
use crate::helptext::OPEN_URL_HELP;
use crate::http::{ExitRule, base_url, http_exit, http_post_json};

pub(crate) fn run_open_url(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    if args.len() == 1 && (args[0] == "-h" || args[0] == "--help") {
        outf!(ctx, "{OPEN_URL_HELP}");
        return 0;
    }
    if args.len() != 1 || args[0].is_empty() {
        errf!(ctx, "{OPEN_URL_HELP}");
        return 2;
    }
    let target = args[0].as_str();
    let r = http_post_json(
        &format!("{}{}", base_url(ctx.env), apipath::COMMANDS),
        &json!({"action": "openUrl", "args": {"url": target}}),
    );
    let body = http_exit(
        ctx,
        r,
        ExitRule {
            prefix: "",
            // FR-VUO-4: 서버에 닿지 못해도 열기 요청은 소실되지 않는다.
            on_err: Some(Box::new(|ctx: &mut Ctx<'_>, _e: &str| {
                open_here(ctx, target)
            })),
            ok: Some(|s| s == 200),
            refuse: Box::new(|ctx: &mut Ctx<'_>, s, b| {
                if s != 400 {
                    return open_here(ctx, target);
                }
                // 서버가 거절한 URL 은 열어서는 안 되는 것이다 (FR-VUO-18).
                errf!(ctx, "open-url: {}\n", String::from_utf8_lossy(b).trim());
                1
            }),
        },
    );
    let body = match body {
        Ok(b) => b,
        Err(code) => return code,
    };

    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Resp {
        #[serde(rename = "where")]
        where_: String,
    }
    match json::unmarshal::<Resp>(&body) {
        Ok(r) if r.where_ == "local" || r.where_.is_empty() => open_here(ctx, target),
        Err(_) => open_here(ctx, target),
        // 뷰어가 연다. 여기서 열면 두 곳에서 열린다.
        Ok(_) => 0,
    }
}

fn open_here(ctx: &mut Ctx<'_>, target: &str) -> i32 {
    let opener = ctx.env.open_local.unwrap_or(system_open_url);
    if let Err(e) = opener(ctx.out, target) {
        errf!(ctx, "open-url: {e}\n");
        return 1;
    }
    0
}

/// 이 컴퓨터의 기본 브라우저를 평범한 창으로 연다.
fn system_open_url(_out: &mut dyn Write, target: &str) -> Result<(), String> {
    let (name, args) = dm_shared_platform::current()
        .opener
        .open_command(target)
        .map_err(|e| dm_gocompat::oserr::go_error_string(&e))?;
    std::process::Command::new(&name)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| {
            format!(
                "fork/exec {name}: {}",
                dm_gocompat::oserr::go_error_string(&e)
            )
        })
}
