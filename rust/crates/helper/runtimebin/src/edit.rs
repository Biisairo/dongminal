//! `edit <경로>` — 편집기 탭으로 파일을 연다.

use dm_shared_apipath as apipath;
use serde_json::json;

use crate::ctx::{Ctx, errf, outf};
use crate::dmctl::post::{command_rule, dmctl_http_result};
use crate::helptext::EDIT_HELP;
use crate::http::{base_url, current_port, http_post_json};

pub(crate) fn run_edit(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let Some(target) = args.first() else {
        outf!(ctx, "{EDIT_HELP}");
        return 0;
    };
    if target == "-h" || target == "--help" {
        outf!(ctx, "{EDIT_HELP}");
        return 0;
    }
    if !std::fs::metadata(target).is_ok_and(|m| !m.is_dir()) {
        errf!(ctx, "edit: 파일 없음: {target}\n");
        return 1;
    }
    let abs = match dm_gocompat::filepath::abs(target) {
        Ok(a) => a,
        Err(e) => {
            errf!(
                ctx,
                "edit: 경로 변환 실패: {}\n",
                dm_gocompat::oserr::go_error_string(&e)
            );
            return 1;
        }
    };
    let name = dm_gocompat::filepath::base(&abs);
    let body = json!({
        "action": "openEditorTab",
        "args": {"name": name, "filePath": abs},
    });
    let r = http_post_json(
        &format!("{}{}", base_url(ctx.env), apipath::COMMANDS),
        &body,
    );
    let port = current_port(ctx.env);
    let mut rule = command_rule("edit");
    rule.on_err = Some(Box::new(move |ctx: &mut Ctx<'_>, _e: &str| {
        errf!(ctx, "edit: 서버 연결 실패 (port={port})\n");
        1
    }));
    // REFACTOR3_DEFECTS_SRS FR-RD3-60: 4xx·5xx 는 실패다.
    dmctl_http_result(ctx, rule, r, true)
}
