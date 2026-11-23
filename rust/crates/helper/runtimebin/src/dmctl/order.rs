//! ISSUE_AGENT_TREE_SRS 묶음 G·O — window 그룹과 순서 명령. 대상 uuid 는 `location` 이 아니라
//! 자기 이름의 키(`window`·`group`·`tab`)로 싣는다 — 서버는 `location` 을 탭 좌표로 번역한다.

use std::sync::LazyLock;

use dm_gocompat::json::{self, Encoder};
use dm_gocompat::strconv;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::post::{dmctl_post, dmctl_post_capture};
use super::rows::{WINDOW_CONTAINER_TOP, build_group_rows, fetch_workspace_tree};
use crate::argparse::{ArgSpec, atoi};
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::DMCTL_ORDER_HELP;

/// 좌표·라벨의 모양이다 (_parseLocation 과 같은 모양). uuid 자리에 오면 거부한다.
static COORD_LIKE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[Ww]?[0-9]+(?:[.\t\n\x0C\r ]+[Pp]?[0-9]+)?(?:[.\t\n\x0C\r ]+[Tt]?[0-9]+)?$")
        .expect("정규식 상수")
});

static REPO_ISSUE_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+)#([0-9]+)$").expect("정규식 상수")
});

const ERR_NOT_UUID: &str =
    "uuid 만 받는다 — 좌표·라벨은 거부한다 (list-workspace 의 uuid 컬럼 값을 쓴다)";

pub(crate) fn set_uuid(v: &str) -> Result<String, String> {
    if v.is_empty() || COORD_LIKE.is_match(v) {
        return Err(ERR_NOT_UUID.to_owned());
    }
    Ok(v.to_owned())
}

pub(crate) fn set_positive_int(v: &str) -> Result<i64, String> {
    atoi(v).ok_or_else(|| format!("--index 는 정수다: {v}"))
}

#[derive(Default, Debug)]
pub(crate) struct OrderFlags {
    pub at: String,
    pub before: String,
    pub after: String,
    pub to: String,
    pub index: Option<i64>,
    pub prev: bool,
    pub next: bool,
    pub ungroup: bool,
}

impl OrderFlags {
    fn position_count(&self) -> usize {
        [
            self.index.is_some(),
            self.prev,
            self.next,
            !self.before.is_empty(),
            !self.after.is_empty(),
        ]
        .iter()
        .filter(|b| **b)
        .count()
    }

    /// FR-ORD-1·5 의 위치 지정을 확인하고 원격 인자로 옮긴다.
    pub fn spec(&self, allow_to: bool) -> Result<Map<String, Value>, &'static str> {
        if self.at.is_empty() {
            return Err("--at <uuid> 가 필요하다");
        }
        let n = self.position_count();
        let has_to = !self.to.is_empty() || self.ungroup;
        if !allow_to && has_to {
            return Err("이 명령은 --to·--ungroup 을 받지 않는다");
        }
        if !self.to.is_empty() && self.ungroup {
            return Err("--to 와 --ungroup 은 함께 쓸 수 없다");
        }
        if has_to {
            if n > 1 || self.prev || self.next || !self.before.is_empty() || !self.after.is_empty()
            {
                return Err("--to 와 함께 쓰는 위치는 --index 하나뿐이다");
            }
        } else if n != 1 {
            return Err(
                "위치 지정이 정확히 하나 필요하다: --index · --prev · --next · --before · --after",
            );
        }
        let mut args = Map::new();
        if let Some(i) = self.index {
            args.insert("index".into(), Value::from(i));
        }
        if self.prev {
            args.insert("prev".into(), Value::Bool(true));
        }
        if self.next {
            args.insert("next".into(), Value::Bool(true));
        }
        if !self.before.is_empty() {
            args.insert("before".into(), Value::from(self.before.as_str()));
        }
        if !self.after.is_empty() {
            args.insert("after".into(), Value::from(self.after.as_str()));
        }
        if !self.to.is_empty() {
            args.insert("to".into(), Value::from(self.to.as_str()));
        }
        if self.ungroup {
            args.insert("to".into(), Value::from(WINDOW_CONTAINER_TOP));
        }
        Ok(args)
    }
}

pub(crate) fn run_dmctl_move(ctx: &mut Ctx<'_>, cmd: &str, args: &[String]) -> i32 {
    let mut f = OrderFlags::default();
    let spec = ArgSpec {
        help: DMCTL_ORDER_HELP,
        vals: &["--at", "-l", "--before", "--after", "--to", "--index"],
        bools: &["--prev", "--next", "--ungroup"],
        ..Default::default()
    };
    let stop = spec.run(ctx, cmd, args, &mut Vec::new(), &mut |k, v| {
        let v = v.unwrap_or_default();
        match k {
            "--at" | "-l" => f.at = set_uuid(v)?,
            "--before" => f.before = set_uuid(v)?,
            "--after" => f.after = set_uuid(v)?,
            "--to" => f.to = set_uuid(v)?,
            "--index" => f.index = Some(set_positive_int(v)?),
            "--prev" => f.prev = true,
            "--next" => f.next = true,
            _ => f.ungroup = true,
        }
        Ok(())
    });
    if let Some(code) = stop {
        return code;
    }
    let (action, key, allow_to) = match cmd {
        "move-window" => ("moveWindow", "window", true),
        "move-group" => ("moveGroup", "group", false),
        _ => ("moveTab", "tab", true),
    };
    if cmd == "move-tab" && f.ungroup {
        errf!(ctx, "{cmd}: --ungroup 은 move-window 의 것이다\n");
        return 2;
    }
    let mut payload = match f.spec(allow_to) {
        Ok(p) => p,
        Err(e) => {
            errf!(ctx, "{cmd}: {e}\n");
            return 2;
        }
    };
    payload.insert(key.into(), Value::from(f.at.as_str()));
    dmctl_post_result(ctx, action, Value::Object(payload))
}

/// 결과를 돌려받는 명령의 전송이다 — 회신의 `error` 를 exit 1 로 옮긴다 (FR-ORD-6).
fn dmctl_post_result(ctx: &mut Ctx<'_>, action: &str, args: Value) -> i32 {
    let (code, resp) = dmctl_post_capture(ctx, action, args, true);
    if code != 0 {
        return code;
    }
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct Got {
        error: String,
    }
    if let Ok(got) = json::unmarshal::<Got>(&resp)
        && !got.error.is_empty()
    {
        errf!(ctx, "dmctl: {action} 실패: {}\n", got.error);
        return 1;
    }
    0
}

pub(crate) fn run_dmctl_group(ctx: &mut Ctx<'_>, cmd: &str, args: &[String]) -> i32 {
    let (mut at, mut name, mut tree) = (String::new(), String::new(), String::new());
    let mut positional = Vec::new();
    let spec = ArgSpec {
        help: DMCTL_ORDER_HELP,
        vals: &["--at", "-l", "--name", "--tree"],
        rest: true,
        ..Default::default()
    };
    let stop = spec.run(ctx, cmd, args, &mut positional, &mut |k, v| {
        let v = v.unwrap_or_default();
        match k {
            "--at" | "-l" => at = set_uuid(v)?,
            "--name" => name = v.to_owned(),
            _ => tree = v.to_owned(),
        }
        Ok(())
    });
    if let Some(code) = stop {
        return code;
    }
    if name.is_empty() && !positional.is_empty() {
        name = positional.join(" ");
    }
    match cmd {
        "new-group" => {
            if name.trim().is_empty() {
                errf!(
                    ctx,
                    "usage: dmctl new-group --name <이름> [--tree <owner/repo#N>]\n"
                );
                return 2;
            }
            let mut payload = Map::new();
            payload.insert("name".into(), Value::from(name));
            if !tree.is_empty() {
                let Some(m) = REPO_ISSUE_REF.captures(&tree) else {
                    errf!(ctx, "new-group: --tree 는 owner/repo#N 꼴이다: {tree}\n");
                    return 2;
                };
                let root = atoi(&m[2]).unwrap_or(0);
                payload.insert("tree".into(), json!({"repo": &m[1], "root": root}));
            }
            dmctl_post_result(ctx, "newGroup", Value::Object(payload))
        }
        "rename-group" => {
            if at.is_empty() || name.trim().is_empty() {
                errf!(ctx, "usage: dmctl rename-group --at <그룹 uuid> <이름>\n");
                return 2;
            }
            dmctl_post(ctx, "renameGroup", json!({"group": at, "name": name}))
        }
        _ => {
            if at.is_empty() {
                errf!(ctx, "usage: dmctl delete-group --at <그룹 uuid>\n");
                return 2;
            }
            dmctl_post(ctx, "deleteGroup", json!({"group": at}))
        }
    }
}

pub(crate) fn run_dmctl_list_groups(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let mut json_out = false;
    let spec = ArgSpec {
        help: DMCTL_ORDER_HELP,
        bools: &["--json"],
        ..Default::default()
    };
    let stop = spec.run(ctx, "list-groups", args, &mut Vec::new(), &mut |_, _| {
        json_out = true;
        Ok(())
    });
    if let Some(code) = stop {
        return code;
    }
    let ws = match fetch_workspace_tree(ctx) {
        Ok(ws) => ws,
        Err(code) => return code,
    };
    let rows = build_group_rows(ws.as_ref());
    if json_out {
        let rows = rows.unwrap_or_default();
        let _ = Encoder::new().encode_to(&mut ctx.out, &rows);
        return 0;
    }
    let rows = rows.unwrap_or_default();
    if rows.is_empty() {
        outf!(ctx, "(no groups)\n");
        return 0;
    }
    for r in &rows {
        let mut line = format!(
            "uuid={}  name={}  index={}  windows={}",
            r.uuid,
            strconv::quote(&r.name),
            r.index,
            r.windows
        );
        if let Some(t) = &r.tree {
            line += &format!("  tree={}#{}", t.repo, t.root);
        }
        outf!(ctx, "{line}\n");
    }
    0
}
