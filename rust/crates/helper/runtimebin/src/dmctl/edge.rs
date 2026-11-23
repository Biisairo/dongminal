//! `dmctl edges`·`dmctl edge` (PEER_NETWORK_SRS FR-PNW-73·74, PEER_DAEMON_SRS FR-PDM-70,
//! EDGE_PAIRING_SRS FR-EPR-60) — 노드 간 통신의 간선 맺기.

use std::collections::{HashMap, HashSet};

use dm_gocompat::json;
use dm_gocompat::strconv::quote;
use dm_shared_apipath as apipath;
use dm_shared_termtext as termtext;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::argparse::{ArgSpec, unknown_arg};
use crate::budgets::EDGE_CALL_BUDGET;
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::{DMCTL_EDGE_HELP, DMCTL_EDGES_HELP};
use crate::http::{base_url, clean, code_rule, http_exit, http_get, http_json_within};

pub(crate) fn run_dmctl_edges(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let mut as_json = false;
    let spec = ArgSpec {
        help: DMCTL_EDGES_HELP,
        bools: &["--json"],
        ..Default::default()
    };
    if let Some(code) = spec.run(ctx, "dmctl edges", args, &mut Vec::new(), &mut |_, _| {
        as_json = true;
        Ok(())
    }) {
        return code;
    }
    let raw = match edge_api(ctx, "GET", apipath::EDGES, None) {
        Ok(r) => r,
        Err(rc) => return rc,
    };
    if as_json {
        let buf = json::compact(&raw).unwrap_or_else(|_| raw.clone());
        outf!(ctx, "{}\n", clean(&String::from_utf8_lossy(&buf)));
        return 0;
    }
    print_edges(ctx, &raw);
    0
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.edgesNode")]
struct EdgesNode {
    enabled: bool,
    port: i64,
    bind: String,
    name: String,
    tag: String,
    advertise: String,
    fingerprint: String,
    listening: bool,
    error: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.edgesEdge")]
struct EdgesEdge {
    name: String,
    tag: String,
    addr: String,
    port: i64,
    fp: String,
    pending: bool,
    outdated: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.edgesInvite")]
struct EdgesInvite {
    expires: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.edgesOut")]
struct EdgesOut {
    node: EdgesNode,
    edges: Option<Vec<EdgesEdge>>,
    invite: Option<EdgesInvite>,
}

/// Go `json.Unmarshal(raw, &v)` 에 null·빈 값을 0 값으로 읽는 것이다.
pub(crate) fn decode<T: DeserializeOwned + Default>(raw: &[u8]) -> Result<T, json::Error> {
    json::unmarshal::<Option<T>>(raw).map(Option::unwrap_or_default)
}

/// 화면에 보이는 지문이다 (FR-PNW-80).
fn short_fp(fp: &str) -> &str {
    termtext::cut(fp, termtext::FP_SHOWN)
}

/// `이름#번호` 다. 번호가 없으면(구버전 서버) 이름만이다 (PROFILE_NAME_SRS FR-PFN-23).
fn handle(name: &str, tag: &str) -> String {
    if tag.is_empty() {
        return name.to_owned();
    }
    format!("{name}#{tag}")
}

fn yes_no(b: bool) -> &'static str {
    if b { "yes" } else { "no" }
}

/// 주소:포트다. 주소를 모르는 간선(상대의 노드 포트가 닫혀 있었음)은 `-` 다.
fn host_port(addr: &str, port: i64) -> String {
    if addr.is_empty() {
        return "-".to_owned();
    }
    if addr.contains(':') {
        return format!("[{addr}]:{port}");
    }
    format!("{addr}:{port}")
}

fn print_edges(ctx: &mut Ctx<'_>, raw: &[u8]) {
    let Ok(v) = decode::<EdgesOut>(raw) else {
        outf!(ctx, "{}\n", clean(&String::from_utf8_lossy(raw)));
        return;
    };
    let n = &v.node;
    outf!(
        ctx,
        "node     name={}  enabled={}  bind={}  port={}  listening={}  fp={}",
        clean(&handle(&n.name, &n.tag)),
        yes_no(n.enabled),
        clean(&n.bind),
        n.port,
        yes_no(n.listening),
        clean(short_fp(&n.fingerprint))
    );
    if !n.advertise.is_empty() {
        outf!(ctx, "  advertise={}", clean(&n.advertise));
    }
    outf!(ctx, "\n");
    if !n.error.is_empty() {
        outf!(ctx, "         port error: {}\n", clean(&n.error));
    }
    for p in v.edges.iter().flatten() {
        outf!(
            ctx,
            "edge     fp={}  name={}  addr={}",
            clean(short_fp(&p.fp)),
            clean(&handle(&p.name, &p.tag)),
            clean(&host_port(&p.addr, p.port))
        );
        // EDGE_MESH_SRS FR-EGM-63
        if p.pending {
            outf!(ctx, "  알림 대기");
        }
        if p.outdated {
            outf!(ctx, "  옛 판");
        }
        outf!(ctx, "\n");
    }
    if let Some(inv) = &v.invite {
        outf!(ctx, "invite   expires={}\n", clean(&inv.expires));
    }
}

/// 위치 인자와 플래그들이다. 모르는 플래그·값이 빠진 플래그는 오류다.
#[derive(Default)]
pub(crate) struct SubArgs {
    pub pos: Vec<String>,
    pub flags: HashMap<String, String>,
    pub bools: HashSet<String>,
    pub help: bool,
}

impl SubArgs {
    pub fn flag(&self, name: &str) -> &str {
        self.flags.get(name).map_or("", String::as_str)
    }
    pub fn has(&self, name: &str) -> bool {
        self.bools.contains(name)
    }
}

/// Go `parseSubArgs`. 오류가 나도 그때까지 읽은 것(도움말 표시)을 함께 돌려준다.
pub(crate) fn parse_sub_args(
    args: &[String],
    allowed: &[&str],
    bools: &[&str],
) -> (SubArgs, Option<String>) {
    let mut out = SubArgs::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-h" || a == "--help" {
            out.help = true;
            i += 1;
            continue;
        }
        if a == "--" {
            out.pos.extend_from_slice(&args[i + 1..]);
            break;
        }
        let Some(stripped) = a.strip_prefix("--") else {
            out.pos.push(a.to_owned());
            i += 1;
            continue;
        };
        let (name, inline) = match stripped.split_once('=') {
            Some((n, v)) => (n, Some(v)),
            None => (stripped, None),
        };
        if bools.contains(&name) && inline.is_none() {
            out.bools.insert(name.to_owned());
            i += 1;
            continue;
        }
        if !allowed.contains(&name) {
            return (out, Some(unknown_arg(a)));
        }
        let value = match inline {
            Some(v) => v.to_owned(),
            None => {
                if i + 1 >= args.len() || args[i + 1].starts_with("--") {
                    return (out, Some(format!("{a} 에 값이 없습니다")));
                }
                i += 1;
                args[i].clone()
            }
        };
        out.flags.insert(name.to_owned(), value);
        i += 1;
    }
    (out, None)
}

pub(crate) type SubRun = fn(&mut Ctx<'_>, &SubArgs) -> i32;

pub(crate) struct SubSpec {
    pub positional: usize,
    /// 참이면 positional 은 최소 개수다.
    pub rest: bool,
    pub flags: &'static [&'static str],
    pub bools: &'static [&'static str],
    pub run: SubRun,
}

fn edge_sub(name: &str) -> Option<SubSpec> {
    let spec = |positional, flags, run| SubSpec {
        positional,
        rest: false,
        flags,
        bools: &[],
        run,
    };
    Some(match name {
        "invite" => spec(0, &["addr"], edge_invite),
        "add" => spec(1, &[], edge_add),
        "remove" => spec(1, &[], edge_remove),
        "notify" => spec(1, &[], edge_notify),
        _ => return None,
    })
}

pub(crate) fn run_dmctl_edge(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let Some((sub, rest)) = args.split_first() else {
        errf!(ctx, "{DMCTL_EDGE_HELP}");
        return 2;
    };
    if sub == "-h" || sub == "--help" || sub == "help" {
        outf!(ctx, "{DMCTL_EDGE_HELP}");
        return 0;
    }
    let Some(spec) = edge_sub(sub) else {
        errf!(ctx, "dmctl edge: 모르는 하위 명령 {}\n", quote(sub));
        errf!(ctx, "{DMCTL_EDGE_HELP}");
        return 2;
    };
    let (pa, mut err) = parse_sub_args(rest, spec.flags, spec.bools);
    if pa.help {
        outf!(ctx, "{DMCTL_EDGE_HELP}");
        return 0;
    }
    if err.is_none() {
        if spec.rest && pa.pos.len() < spec.positional {
            err = Some(format!("인자가 {} 개 이상이어야 합니다", spec.positional));
        } else if !spec.rest && pa.pos.len() != spec.positional {
            err = Some(format!("인자가 {} 개여야 합니다", spec.positional));
        }
    }
    if let Some(e) = err {
        errf!(ctx, "dmctl edge {sub}: {e}\n");
        return 2;
    }
    (spec.run)(ctx, &pa)
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct InviteResp {
    code: String,
    expires: String,
}

fn edge_invite(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let body = json!({"addr": pa.flag("addr")});
    let raw = match edge_api(ctx, "POST", apipath::EDGES_INVITE, Some(body)) {
        Ok(r) => r,
        Err(rc) => return rc,
    };
    let v: InviteResp = decode(&raw).unwrap_or_default();
    // stdout 은 코드 한 줄이다 — 파이프로 그대로 넘길 수 있게 한다.
    outf!(ctx, "{}\n", v.code);
    errf!(
        ctx,
        "초대 코드는 {} 까지 한 번 쓸 수 있습니다. 상대 노드에서 dmctl edge add <코드> 를 실행하세요.\n",
        clean(&v.expires)
    );
    0
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PeerResp {
    name: String,
    tag: String,
    fp: String,
    notified: bool,
}

fn edge_add(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let body = json!({"code": pa.pos[0]});
    let raw = match edge_api(ctx, "POST", apipath::EDGES_ADD, Some(body)) {
        Ok(r) => r,
        Err(rc) => return rc,
    };
    let v: PeerResp = decode(&raw).unwrap_or_default();
    outf!(
        ctx,
        "{}({})와 간선을 맺었습니다.\n",
        clean(&v.name),
        clean(short_fp(&v.fp))
    );
    0
}

fn edge_remove(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let body = json!({"fp": pa.pos[0]});
    let raw = match edge_api(ctx, "POST", apipath::EDGES_REMOVE, Some(body)) {
        Ok(r) => r,
        Err(rc) => return rc,
    };
    let v: PeerResp = decode(&raw).unwrap_or_default();
    outf!(
        ctx,
        "{}({}) 간선을 끊었습니다.\n",
        clean(&v.name),
        clean(short_fp(&v.fp))
    );
    if !v.notified {
        errf!(
            ctx,
            "상대에게 알리지 못했습니다. 다시 이어지면 상대 쪽에서도 지워집니다.\n"
        );
    }
    0
}

/// 간선 하나에 내 직접 정보를 지금 알린다 (EDGE_MESH_SRS FR-EGM-62).
fn edge_notify(ctx: &mut Ctx<'_>, pa: &SubArgs) -> i32 {
    let body = json!({"fp": pa.pos[0]});
    let raw = match edge_api(ctx, "POST", apipath::EDGES_NOTIFY, Some(body)) {
        Ok(r) => r,
        Err(rc) => return rc,
    };
    let v: PeerResp = decode(&raw).unwrap_or_default();
    outf!(ctx, "알렸습니다: {}\n", clean(&handle(&v.name, &v.tag)));
    0
}

/// 로컬 API 한 번이다. 거절이면 `{code,message}` 를 stderr 에 내고 1 이다 (FR-PNW-74).
fn edge_api(
    ctx: &mut Ctx<'_>,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Vec<u8>, i32> {
    let url = format!("{}{}", base_url(ctx.env), path);
    let r = match body {
        None => http_get(&url),
        Some(b) => http_json_within(method, &url, &b, EDGE_CALL_BUDGET),
    };
    http_exit(ctx, r, code_rule())
}
