//! 충돌을 한쪽으로 해결한다 (FR-GIT-111~115). 경로마다 결과를 돌려준다.

use std::collections::{HashMap, HashSet};

use dm_gocompat::strconv::quote;
use dm_webserver_domain_git_core::{self as core, Ctx, Hint, Service};
use serde::Serialize;

use crate::commit::{argv, spec};
use crate::error::{Error, exec, exec_write};
use crate::stage::{MAX_PATHS_PER_CALL, PATHS_SEP, check_paths};

pub const RESOLVE_OURS: &str = "ours";
pub const RESOLVE_THEIRS: &str = "theirs";

const STAGE_OURS: &str = "2";
const STAGE_THEIRS: &str = "3";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename = "write.ResolveResult")]
pub struct ResolveResult {
    pub path: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(skip)]
    pub err: Option<Error>,
}

pub async fn resolve(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    side: &str,
    paths: &[String],
) -> Result<Vec<ResolveResult>, Error> {
    if side != RESOLVE_OURS && side != RESOLVE_THEIRS {
        return Err(Error::unsafe_argument(format!(
            "알 수 없는 side: {}",
            quote(side)
        )));
    }
    let cp = check_paths(paths)?;
    let stages = unmerged_stages(s, ctx, repo, &cp).await?;
    s.add_hint(resolve_hint(repo, side, &cp));
    let want = if side == RESOLVE_THEIRS {
        STAGE_THEIRS
    } else {
        STAGE_OURS
    };
    let (mut checkout, mut remove) = (Vec::new(), Vec::new());
    for (i, p) in cp.iter().enumerate() {
        match stages.get(p) {
            Some(st) if !st.contains(want) => remove.push(i),
            _ => checkout.push(i),
        }
    }
    let mut results: Vec<ResolveResult> = cp
        .iter()
        .map(|p| ResolveResult {
            path: p.clone(),
            ..ResolveResult::default()
        })
        .collect();
    let r = Resolver {
        s,
        ctx,
        repo,
        side,
        paths: &cp,
    };
    r.run(&mut results, &checkout, Mode::Checkout).await;
    r.run(&mut results, &remove, Mode::Remove).await;
    Ok(results)
}

#[derive(Clone, Copy)]
enum Mode {
    Checkout,
    Remove,
}

struct Resolver<'a> {
    s: &'a Service,
    ctx: &'a Ctx,
    repo: &'a str,
    side: &'a str,
    paths: &'a [String],
}

impl Resolver<'_> {
    /// 묶음으로 실행하고, 평범한 실패면 한 경로씩 다시 해 어느 경로가 실패했는지 가린다.
    async fn run(&self, results: &mut [ResolveResult], idx: &[usize], mode: Mode) {
        for chunk in idx.chunks(MAX_PATHS_PER_CALL) {
            if self.ctx.err().is_some() {
                for &i in chunk {
                    results[i].skipped = true;
                    results[i].error = "시간 초과로 실행하지 않음".to_owned();
                }
                continue;
            }
            let ps: Vec<String> = chunk.iter().map(|&i| self.paths[i].clone()).collect();
            let res = self.batch(&ps, mode).await;
            let plain = res.as_ref().err().is_some_and(|e| e.plain_exit().is_some());
            if plain && chunk.len() > 1 && self.ctx.err().is_none() {
                for &i in chunk {
                    let single = self.batch(std::slice::from_ref(&self.paths[i]), mode).await;
                    set(&mut results[i], single.err());
                }
                continue;
            }
            for &i in chunk {
                set(&mut results[i], res.as_ref().err().cloned());
            }
        }
    }

    async fn batch(&self, ps: &[String], mode: Mode) -> Result<(), Error> {
        let (s, ctx, repo) = (self.s, self.ctx, self.repo);
        match mode {
            Mode::Checkout => {
                let mut av = vec![
                    "checkout".to_owned(),
                    format!("--{}", self.side),
                    PATHS_SEP.to_owned(),
                ];
                av.extend(ps.iter().cloned());
                exec_write(s, ctx, repo, spec(av, true)).await?;
                let mut av = argv(&["add", PATHS_SEP]);
                av.extend(ps.iter().cloned());
                exec_write(s, ctx, repo, spec(av, false)).await?;
            }
            Mode::Remove => {
                let mut av = argv(&["rm", "-q", PATHS_SEP]);
                av.extend(ps.iter().cloned());
                exec_write(s, ctx, repo, spec(av, true)).await?;
            }
        }
        Ok(())
    }
}

fn set(r: &mut ResolveResult, err: Option<Error>) {
    r.ok = err.is_none();
    if let Some(e) = &err {
        r.error = e.to_string();
    }
    r.err = err;
}

/// 경로별로 index 에 남은 단계(1·2·3) 집합이다.
async fn unmerged_stages(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
    paths: &[String],
) -> Result<HashMap<String, HashSet<String>>, Error> {
    let mut av = argv(&["ls-files", "-u", "-z", PATHS_SEP]);
    av.extend(paths.iter().cloned());
    let out = exec(s, ctx, repo, &av).await?;
    let mut stages: HashMap<String, HashSet<String>> = HashMap::new();
    for rec in out.stdout_str().split('\0') {
        let Some((meta, path)) = rec.split_once('\t') else {
            continue;
        };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        if fields.len() != 3 {
            continue;
        }
        stages
            .entry(path.to_owned())
            .or_default()
            .insert(fields[2].to_owned());
    }
    Ok(stages)
}

fn resolve_hint(repo: &str, side: &str, paths: &[String]) -> Hint {
    Hint {
        repo: repo.to_owned(),
        action: core::ACTION_RESOLVE_SIDE.to_owned(),
        targets: Some(paths.to_vec()),
        note: format!(
            "{side} 쪽 내용으로 덮고 해결됨으로 표시한다. 충돌 표식과 손대던 내용은 git 에 저장된 적이 없어 되살릴 값이 없다. 충돌 상태로 되돌리려면 `git checkout -m -- <경로>` 다."
        ),
        ..Hint::default()
    }
}
