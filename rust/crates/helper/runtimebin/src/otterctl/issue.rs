//! `otterctl issue <sub>` — 로컬 이슈 폴더 (ISSUE_TREE_CHAT_SRS FR-LIS-6~8). 파일 규칙은 issuefile crate 한 벌이다.
//! 명령은 원본 폴더만 고친다 (FR-LIS-7). 폴더는 `--dir` 로 받고, 없으면 부르는 탭의 Run 이 기록한 원본 폴더다.

use std::path::PathBuf;

use otter_shared_issuefile::{self as issuefile, Change, Dir, Status};

use otter_gocompat::json;
use otter_shared_apipath as apipath;
use serde::Deserialize;

use super::runhttp::run_get;
use super::whoami::encode_query;
use crate::ctx::{Ctx, errf, outf};
use crate::helptext::OTTERCTL_ISSUE_HELP;
use crate::http::self_tool_id;

/// 새 폴더의 안내 파일 (FR-LIS-6 `init`).
const README: &str = "# 이슈

이 폴더의 파일 하나가 이슈 하나다. `otterctl issue` 로 만들고 고친다.

## 이슈 파일 형식

경로는 `<ID>-<짧은 이름>.md` 다. ID 는 점으로 이은 트리 경로이고, 부모는 마지막 조각을 뗀 ID 다(예: `2.3` 의 부모는 `2`).
머리말(YAML):

```yaml
id: \"2.1\"
title: 제목
status: todo | ready | in-progress | review | done | blocked | split
deps: [\"1\"]          # 먼저 done 이어야 하는 이슈
owner: \"\"            # 맡은 탭 uuid
branch: \"\"
```

본문은 「목표」「완료 조건」「진행 기록」이다.

## 상태 흐름

`todo` → `ready`(deps 가 모두 done) → `in-progress` → `review` → `done`. 옆길로 `blocked`(이유를 적는다)와
`blocked → ready | in-progress`, `in-progress → split`(하위 이슈로 나눔)이 있다. 그 밖의 전이는 거절한다.

상태 원본은 이 폴더 하나다. worktree 안의 사본은 고치지 않는다.
";

#[derive(Default)]
struct Flags {
    dir: String,
    deps: String,
    status: String,
    owner: Option<String>,
    branch: Option<String>,
    reason: Option<String>,
    pos: Vec<String>,
}

const VALS: &[&str] = &[
    "--dir", "--deps", "--status", "--owner", "--branch", "--reason",
];

fn parse(args: &[String]) -> Result<Flags, String> {
    let mut f = Flags::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if VALS.contains(&a.as_str()) {
            let v = it
                .next()
                .ok_or_else(|| format!("{a} 에 값이 없다"))?
                .clone();
            match a.as_str() {
                "--dir" => f.dir = v,
                "--deps" => f.deps = v,
                "--status" => f.status = v,
                "--owner" => f.owner = Some(v),
                "--branch" => f.branch = Some(v),
                _ => f.reason = Some(v),
            }
        } else if a.starts_with("--") {
            return Err(format!("모르는 플래그: {a}"));
        } else {
            f.pos.push(a.clone());
        }
    }
    Ok(f)
}

fn today() -> String {
    let t = otter_gocompat::time::now_local();
    format!("{:04}-{:02}-{:02}", t.year(), u8::from(t.month()), t.day())
}

pub(crate) fn run_otterctl_issue(ctx: &mut Ctx<'_>, args: &[String]) -> i32 {
    let Some(sub) = args.first() else {
        outf!(ctx, "{OTTERCTL_ISSUE_HELP}");
        return 2;
    };
    if args.iter().any(|a| a == "-h" || a == "--help") || sub == "help" {
        outf!(ctx, "{OTTERCTL_ISSUE_HELP}");
        return 0;
    }
    let f = match parse(&args[1..]) {
        Ok(f) => f,
        Err(e) => {
            errf!(ctx, "issue: {e}\n");
            return 2;
        }
    };
    if sub == "init" {
        let Some(p) = f.pos.first() else {
            errf!(ctx, "issue init: 폴더를 준다\n");
            return 2;
        };
        return done(
            ctx,
            Dir::new(PathBuf::from(p))
                .init(README)
                .map(|()| String::new()),
        );
    }
    if sub == "resolve" {
        return resolve(ctx, &f.pos);
    }
    let dir = if f.dir.is_empty() {
        match run_issue_dir(ctx) {
            Ok(d) => d,
            Err(code) => return code,
        }
    } else {
        f.dir.clone()
    };
    let d = Dir::new(PathBuf::from(&dir));
    match sub.as_str() {
        "tree" => {
            if let Some(s) = f.pos.iter().find(|s| Status::parse(s).is_none()) {
                errf!(ctx, "issue tree: 모르는 상태: {s}\n");
                return 2;
            }
            done(ctx, d.tree(&f.pos))
        }
        "show" => {
            let [id] = f.pos.as_slice() else {
                errf!(ctx, "issue show: <ID> 하나를 준다\n");
                return 2;
            };
            done(
                ctx,
                d.get(id)
                    .and_then(|(p, _)| std::fs::read_to_string(p).map_err(issuefile::Error::from)),
            )
        }
        "new" => {
            if f.pos.len() < 2 {
                errf!(ctx, "issue new: <ID> <제목> 을 준다\n");
                return 2;
            }
            let deps: Vec<String> = f
                .deps
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            let title = f.pos[1..].join(" ");
            done(
                ctx,
                d.create(&f.pos[0], &title, &deps)
                    .map(|p| format!("{}\n", p.display())),
            )
        }
        "set" => {
            let [id] = f.pos.as_slice() else {
                errf!(ctx, "issue set: <ID> 하나를 준다\n");
                return 2;
            };
            let status = if f.status.is_empty() {
                None
            } else {
                let Some(s) = Status::parse(&f.status) else {
                    errf!(ctx, "issue set: 모르는 상태: {}\n", f.status);
                    return 2;
                };
                Some(s)
            };
            if status.is_none() && f.owner.is_none() && f.branch.is_none() {
                errf!(
                    ctx,
                    "issue set: --status·--owner·--branch 가운데 하나를 준다\n"
                );
                return 2;
            }
            let c = Change {
                status,
                owner: f.owner.clone(),
                branch: f.branch.clone(),
                reason: f.reason.clone(),
            };
            done(
                ctx,
                d.set(id, &c, &today())
                    .map(|i| format!("{} {}\n", i.id, i.status.as_str())),
            )
        }
        "log" => {
            let [id] = f.pos.as_slice() else {
                errf!(ctx, "issue log: <ID> 하나를 준다\n");
                return 2;
            };
            let mut text = String::new();
            if ctx.inp.read_to_string(&mut text).is_err() || text.trim().is_empty() {
                errf!(ctx, "issue log: 덧붙일 글을 stdin 으로 준다\n");
                return 2;
            }
            done(ctx, d.log(id, &today(), &text).map(|()| String::new()))
        }
        _ => {
            errf!(ctx, "issue: 모르는 하위 명령: {sub}\n");
            2
        }
    }
}

/// `<폴더>#<ID>` 를 판정한다 (FR-LIS-2). 로컬이면 `local\t<폴더>\t<ID>\t<별칭>:<ID>`, 아니면 `github\t<인자>`.
fn resolve(ctx: &mut Ctx<'_>, pos: &[String]) -> i32 {
    let [arg] = pos else {
        errf!(ctx, "issue resolve: <폴더>#<ID> 하나를 준다\n");
        return 2;
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    match issuefile::resolve_arg(arg, &cwd) {
        Some((dir, id)) => {
            let tree = issuefile::local_tree_ref(&dir, &id);
            outf!(ctx, "local\t{}\t{id}\t{tree}\n", dir.display());
        }
        None => outf!(ctx, "github\t{arg}\n"),
    }
    0
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RunIssues {
    issue_dir: String,
}

/// 부르는 탭의 Run 이 기록한 원본 이슈 폴더 (FR-LIS-7).
fn run_issue_dir(ctx: &mut Ctx<'_>) -> Result<String, i32> {
    let id = self_tool_id(ctx.env);
    let mut path = apipath::RUNS_ISSUES.to_owned();
    if !id.is_empty() {
        path += &format!("?{}", encode_query(&[("toolId", &id)]));
    }
    let raw = run_get(ctx, &path)?;
    let got: RunIssues = json::unmarshal(&raw).unwrap_or_default();
    if got.issue_dir.is_empty() {
        errf!(
            ctx,
            "issue: 이 Run 은 로컬 이슈 트리가 아니다 — --dir <폴더> 를 준다\n"
        );
        return Err(2);
    }
    Ok(got.issue_dir)
}

fn done(ctx: &mut Ctx<'_>, r: Result<String, issuefile::Error>) -> i32 {
    match r {
        Ok(s) => {
            outf!(ctx, "{s}");
            0
        }
        Err(e) => {
            errf!(ctx, "issue: {e}\n");
            1
        }
    }
}
