//! `dmctl who-am-i` (DMCTL_WHO_AM_I_SRS FR-DMC-WAI-1~3). `/api/whoami` JSON → toolline 한 줄,
//! 또는 --json 이면 그대로.

use dm_gocompat::json;
use dm_helper_toolline::Line;
use dm_shared_apipath as apipath;
use serde::Deserialize;

use crate::argparse::ArgSpec;
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::DMCTL_WHO_AM_I_HELP;
use crate::http::{api_result, base_url, http_get, self_tool_id};

#[derive(Default, Deserialize)]
#[serde(default)]
struct Member {
    id: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.whoAmIResp")]
struct WhoAmIResp {
    #[serde(rename = "toolId")]
    tool_id: String,
    #[serde(rename = "shellPid")]
    shell_pid: i64,
    label: String,
    uuid: String,
    short: String,
    #[serde(rename = "sizeCols")]
    size_cols: i64,
    #[serde(rename = "sizeRows")]
    size_rows: i64,
    window: String,
    tab: String,
    #[serde(rename = "windowUuid")]
    window_uuid: String,
    #[serde(rename = "paneUuid")]
    pane_uuid: String,
    focused: bool,
    member: Option<Member>,
}

pub(crate) fn dmctl_who_am_i(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let mut json_out = false;
    let spec = ArgSpec {
        help: DMCTL_WHO_AM_I_HELP,
        bools: &["--json"],
        ..Default::default()
    };
    let stop = spec.run(ctx, "who-am-i", args, &mut Vec::new(), &mut |_, _| {
        json_out = true;
        Ok(())
    });
    if let Some(code) = stop {
        return code;
    }
    // FR-RDG-26: toolId 는 질의 문자열로 이스케이프한다.
    let url = format!(
        "{}{}?toolId={}",
        base_url(ctx.env),
        apipath::WHOAMI,
        query_escape(&self_tool_id(ctx.env))
    );
    let body = match api_result(ctx, apipath::WHOAMI, http_get(&url)) {
        Ok(b) => b,
        Err(code) => return code,
    };
    if json_out {
        let mut out: &[u8] = &body;
        while let [rest @ .., b'\n' | b'\r'] = out {
            out = rest;
        }
        let _ = ctx.out.write_all(out);
        outf!(ctx, "\n");
        return 0;
    }
    let rec = match json::unmarshal::<WhoAmIResp>(&body) {
        Ok(r) => r,
        Err(e) => {
            errf!(ctx, "dmctl: invalid /api/whoami response: {e}\n");
            return 1;
        }
    };
    let line = Line {
        focus_marker: rec.focused,
        label: rec.label,
        uuid: rec.uuid,
        short: rec.short,
        tool_id: rec.tool_id,
        shell_pid: rec.shell_pid,
        size_cols: rec.size_cols,
        size_rows: rec.size_rows,
        window: rec.window,
        tab: rec.tab,
        window_uuid: rec.window_uuid,
        pane_uuid: rec.pane_uuid,
        ..Default::default()
    };
    let mut out = line.render().trim_end_matches('\n').to_owned();
    if let Some(m) = rec.member.filter(|m| !m.id.is_empty()) {
        out += &format!("  member={}", m.id);
    }
    outf!(ctx, "{out}\n");
    0
}

/// Go `url.QueryEscape`.
pub(crate) fn query_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Go `url.Values.Encode` — 키 순으로 `k=v&…`.
pub(crate) fn encode_query(pairs: &[(&str, &str)]) -> String {
    let mut sorted: Vec<&(&str, &str)> = pairs.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    sorted
        .iter()
        .map(|(k, v)| format!("{}={}", query_escape(k), query_escape(v)))
        .collect::<Vec<_>>()
        .join("&")
}
