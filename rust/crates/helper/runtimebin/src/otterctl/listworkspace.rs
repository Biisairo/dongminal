//! `otterctl list-workspace` — /api/state 의 워크스페이스 트리를 toolline 줄로 렌더링한다
//! (OTTERCTL_WHO_AM_I_SRS FR-DMC-LP-1). MCP `list_workspace` 와 바이트 단위로 같은 형식이다.

use otter_gocompat::json::Encoder;
use otter_helper_toolline::Line;

use super::rows::{ListWorkspaceRow, fetch_list_workspace_rows, match_fold};
use crate::argparse::ArgSpec;
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::OTTERCTL_LIST_WORKSPACE_HELP;

#[derive(Default, Debug)]
pub(crate) struct ListWorkspaceFlags {
    pub json_out: bool,
    pub window_filter: String,
    pub tab_filter: String,
}

pub(crate) fn parse_list_workspace_flags(
    ctx: &mut Ctx<'_>,
    args: &[String],
) -> (ListWorkspaceFlags, Option<i32>) {
    let mut f = ListWorkspaceFlags::default();
    let spec = ArgSpec {
        help: OTTERCTL_LIST_WORKSPACE_HELP,
        vals: &["--window", "--tab"],
        bools: &["--json"],
        ..Default::default()
    };
    let stop = spec.run(ctx, "list-workspace", args, &mut Vec::new(), &mut |k, v| {
        match k {
            "--window" => f.window_filter = v.unwrap_or_default().to_owned(),
            "--tab" => f.tab_filter = v.unwrap_or_default().to_owned(),
            _ => f.json_out = true,
        }
        Ok(())
    });
    (f, stop)
}

pub(crate) fn otterctl_list_workspace(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let (f, stop) = parse_list_workspace_flags(ctx, args);
    if let Some(code) = stop {
        return code;
    }
    let mut rows = match fetch_list_workspace_rows(ctx) {
        Ok(r) => r.unwrap_or_default(),
        Err(code) => return code,
    };
    // LIST_PANES_NAME_FILTER_SRS FR-LPF-1/2: 부분 일치, 대소문자 무시, AND.
    if !f.window_filter.is_empty() || !f.tab_filter.is_empty() {
        rows.retain(|r| {
            match_fold(&r.window, &f.window_filter) && match_fold(&r.tab, &f.tab_filter)
        });
        if rows.is_empty() {
            if f.json_out {
                outf!(ctx, "[]\n");
            } else {
                errf!(ctx, "(no match)\n");
            }
            return 1;
        }
    }
    if f.json_out {
        if rows.is_empty() {
            outf!(ctx, "[]\n");
            return 0;
        }
        let _ = Encoder::new().encode_to(&mut ctx.out, &rows);
        return 0;
    }
    if rows.is_empty() {
        outf!(ctx, "(no tools)\n");
        return 0;
    }
    for r in &rows {
        outf!(ctx, "{}\n", list_workspace_line(r).render());
    }
    0
}

/// 행 하나를 사람용 한 줄로 옮긴다 (toolline 의 형식).
pub(crate) fn list_workspace_line(r: &ListWorkspaceRow) -> Line {
    Line {
        focus_marker: r.focused,
        label: r.label.clone(),
        uuid: r.uuid.clone(),
        short: r.short.clone(),
        tool_id: r.tool_id.clone(),
        shell_pid: r.shell_pid,
        size_cols: r.size_cols,
        size_rows: r.size_rows,
        window: r.window.clone(),
        tab: r.tab.clone(),
        window_uuid: r.window_uuid.clone(),
        pane_uuid: r.pane_uuid.clone(),
        group: r.group.clone(),
        win_index: r.window_index,
        win_count: r.window_count,
        tab_index: r.tab_index,
        tab_count: r.tab_count,
    }
}
