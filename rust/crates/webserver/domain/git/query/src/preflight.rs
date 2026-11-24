//! 커밋 전 검사 (FR-GIT-76·85·86).

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use otter_gocompat::filepath;
use otter_webserver_domain_git_core::{Ctx, Service};
use serde::Serialize;

use crate::diff::DIFF_MAX_BYTES;
use crate::error::Error;
use crate::operation::{
    OP_AM, OP_BISECT, OP_CHERRY_PICK, OP_MERGE, OP_REBASE, OP_REVERT, markers_of,
};
use crate::signature::{HEAD_FILE, SYMREF_PREFIX};

pub const BLOCK_IDENTITY_MISSING: &str = "identity_missing";
pub const BLOCK_MERGE_IN_PROGRESS: &str = "merge_in_progress";
pub const BLOCK_REBASE_IN_PROGRESS: &str = "rebase_in_progress";
pub const BLOCK_CHERRY_PICK_IN_PROGRESS: &str = "cherry_pick_in_progress";
pub const BLOCK_REVERT_IN_PROGRESS: &str = "revert_in_progress";
pub const BLOCK_AM_IN_PROGRESS: &str = "am_in_progress";
pub const BLOCK_BISECT_IN_PROGRESS: &str = "bisect_in_progress";
pub const WARN_DETACHED_HEAD: &str = "detached_head";

const CONFIG_USER_NAME: &str = "user.name";
const CONFIG_USER_EMAIL: &str = "user.email";
const CONFIG_GPG_SIGN: &str = "commit.gpgsign";
const CONFIG_COMMIT_TEMPLATE: &str = "commit.template";

pub(crate) const MERGE_HEAD_FILE: &str = "MERGE_HEAD";
pub(crate) const REBASE_MERGE_DIR: &str = "rebase-merge";
pub(crate) const REBASE_APPLY_DIR: &str = "rebase-apply";
pub(crate) const REBASE_APPLYING: &str = "applying";
pub(crate) const BISECT_LOG_FILE: &str = "BISECT_LOG";
pub(crate) const CHERRY_PICK_HEAD_FILE: &str = "CHERRY_PICK_HEAD";
pub(crate) const REVERT_HEAD_FILE: &str = "REVERT_HEAD";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Block {
    pub code: String,
    pub reason: String,
    pub fix: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Warning {
    pub code: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Preflight {
    pub blocks: Vec<Block>,
    pub warnings: Vec<Warning>,
    #[serde(rename = "gpgSign")]
    pub gpg_sign: bool,
    pub template: String,
}

const IN_PROGRESS_CHECKS: [(&str, &str, &str, &str); 6] = [
    (
        BLOCK_MERGE_IN_PROGRESS,
        OP_MERGE,
        "머지가 진행 중입니다 — 지금 커밋하면 머지 커밋이 됩니다",
        "충돌을 해결한 뒤 커밋하거나, `git merge --abort` 로 머지를 되돌리세요",
    ),
    (
        BLOCK_REBASE_IN_PROGRESS,
        OP_REBASE,
        "리베이스가 진행 중입니다 — 이 상태의 커밋은 리베이스의 일부가 됩니다",
        "`git rebase --continue` 로 진행하거나 `git rebase --abort` 로 되돌리세요",
    ),
    (
        BLOCK_CHERRY_PICK_IN_PROGRESS,
        OP_CHERRY_PICK,
        "체리픽이 진행 중입니다",
        "`git cherry-pick --continue` 로 진행하거나 `git cherry-pick --abort` 로 되돌리세요",
    ),
    (
        BLOCK_REVERT_IN_PROGRESS,
        OP_REVERT,
        "리버트가 진행 중입니다",
        "`git revert --continue` 로 진행하거나 `git revert --abort` 로 되돌리세요",
    ),
    (
        BLOCK_AM_IN_PROGRESS,
        OP_AM,
        "패치 적용(git am)이 진행 중입니다",
        "충돌을 해결한 뒤 `git am --continue` 로 진행하거나 `git am --abort` 로 되돌리세요",
    ),
    (
        BLOCK_BISECT_IN_PROGRESS,
        OP_BISECT,
        "bisect 탐색이 진행 중입니다 — 지금 커밋하면 탐색 결과를 믿을 수 없습니다",
        "`git bisect reset` 으로 탐색을 끝내고 원래 자리로 돌아가세요",
    ),
];

/// 커밋 전 검사다.
pub async fn preflight_of(s: &Service, ctx: &Ctx, repo: &str) -> Result<Preflight, Error> {
    let mut pf = Preflight::default();
    let cfg = preflight_config(s, ctx, repo).await?;
    let get = |k: &str| cfg.get(k).map(String::as_str).unwrap_or("");
    if let Some(b) = identity_block(get(CONFIG_USER_NAME), get(CONFIG_USER_EMAIL)) {
        pf.blocks.push(b);
    }
    let (git_dir, _) = s.git_dirs(ctx, repo).await?;
    for (code, kind, reason, fix) in IN_PROGRESS_CHECKS {
        if any_exists(&git_dir, &markers_of(kind)) {
            pf.blocks.push(Block {
                code: code.into(),
                reason: reason.into(),
                fix: fix.into(),
            });
        }
    }
    let head_path = filepath::join(&[git_dir.as_str(), HEAD_FILE]);
    let head = std::fs::read(&head_path).map_err(|e| Error::io("open", &head_path, e))?;
    if !String::from_utf8_lossy(&head)
        .trim()
        .starts_with(SYMREF_PREFIX)
    {
        pf.warnings.push(Warning {
            code: WARN_DETACHED_HEAD.into(),
            reason: "HEAD 가 브랜치를 가리키지 않습니다 (detached) — 여기서 만든 커밋은 어느 브랜치에도 속하지 않습니다"
                .into(),
        });
    }
    pf.gpg_sign = git_bool(get(CONFIG_GPG_SIGN));
    pf.template = read_commit_template(repo, get(CONFIG_COMMIT_TEMPLATE));
    Ok(pf)
}

async fn preflight_config(
    s: &Service,
    ctx: &Ctx,
    repo: &str,
) -> Result<HashMap<String, String>, Error> {
    let out = s.exec(ctx, repo, &["config", "--null", "--list"]).await?;
    let keys = [
        CONFIG_USER_NAME,
        CONFIG_USER_EMAIL,
        CONFIG_GPG_SIGN,
        CONFIG_COMMIT_TEMPLATE,
    ];
    let mut cfg = HashMap::new();
    for rec in out.stdout_str().split('\0') {
        let (key, val) = rec.split_once('\n').unwrap_or((rec, ""));
        let key = key.to_lowercase();
        if keys.contains(&key.as_str()) {
            cfg.insert(key, val.trim().to_owned());
        }
    }
    Ok(cfg)
}

fn identity_block(name: &str, email: &str) -> Option<Block> {
    let mut missing = Vec::new();
    if name.trim().is_empty() {
        missing.push(CONFIG_USER_NAME);
    }
    if email.trim().is_empty() {
        missing.push(CONFIG_USER_EMAIL);
    }
    if missing.is_empty() {
        return None;
    }
    let fix: Vec<String> = missing
        .iter()
        .map(|k| format!("git config --global {k} \"…\""))
        .collect();
    Some(Block {
        code: BLOCK_IDENTITY_MISSING.into(),
        reason: missing.join(" · ") + " 이 설정되지 않아 커밋의 작성자를 정할 수 없습니다",
        fix: fix.join(" && "),
    })
}

pub(crate) fn any_exists<S: AsRef<str>>(git_dir: &str, names: &[S]) -> bool {
    names
        .iter()
        .any(|n| std::fs::symlink_metadata(Path::new(git_dir).join(n.as_ref())).is_ok())
}

fn git_bool(v: &str) -> bool {
    matches!(
        v.trim().to_lowercase().as_str(),
        "true" | "yes" | "on" | "1"
    )
}

fn home_dir() -> Option<String> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).ok().filter(|h| !h.is_empty())
}

fn read_commit_template(repo: &str, p: &str) -> String {
    if p.trim().is_empty() {
        return String::new();
    }
    let mut abs = p.to_owned();
    if let Some(rest) = abs.strip_prefix("~/") {
        let Some(home) = home_dir() else {
            return String::new();
        };
        abs = filepath::join(&[home.as_str(), rest]);
    }
    if !filepath::is_abs(&abs) {
        abs = filepath::join(&[repo, abs.as_str()]);
    }
    let Ok(f) = std::fs::File::open(&abs) else {
        return String::new();
    };
    let mut body = Vec::new();
    if f.take(DIFF_MAX_BYTES as u64)
        .read_to_end(&mut body)
        .is_err()
    {
        return String::new();
    }
    String::from_utf8_lossy(&body).into_owned()
}
