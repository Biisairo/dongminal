//! Go 기준선 `dongminal/internal/webserver/action` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 화면의 동작 하나가 지금 가능한가(`Answer`)와, 그 동작이 줄 수 있는 거절 사유의 목록(`CATALOG`)이다.

use std::collections::{BTreeMap, BTreeSet};

use dm_webserver_apierr as apierr;
use regex::Regex;
use serde::Serialize;

/// 동작 하나의 판정. `status` 는 와이어에 실리지 않는다.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename = "action.Answer")]
pub struct Answer {
    pub ok: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub why: String,
    #[serde(skip_serializing_if = "dm_gocompat::json::is_empty")]
    pub args: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(skip)]
    pub status: u16,
}

pub fn allow() -> Answer {
    Answer {
        ok: true,
        ..Answer::default()
    }
}

pub fn deny(status: u16, why: &str, args: Option<BTreeMap<String, serde_json::Value>>) -> Answer {
    Answer {
        ok: false,
        why: why.to_owned(),
        args,
        status,
    }
}

/// 처음으로 거절한 판정, 모두 허용이면 허용.
pub fn first(answers: impl IntoIterator<Item = Answer>) -> Answer {
    answers.into_iter().find(|a| !a.ok).unwrap_or_else(allow)
}

/// 판정을 아직 할 수 없다 (관측 대기).
pub const WHY_LOADING: &str = "loading";

pub const GIT_STASH_CREATE: &str = "git.stash.create";
pub const GIT_STAGE: &str = "git.stage";
pub const GIT_FETCH: &str = "git.fetch";
pub const GIT_PULL: &str = "git.pull";
pub const GIT_PUSH: &str = "git.push";
pub const GIT_TAG_PUSH: &str = "git.tag.push";
pub const GIT_TAG_DELETE_REMOTE: &str = "git.tag.delete_remote";
pub const GIT_WRITE: &str = "git.write";
pub const GIT_COMMIT: &str = "git.commit";
pub const GIT_LOCK_REMOVE: &str = "git.lock.remove";
pub const GIT_WORKTREE_CREATE: &str = "git.worktree.create";
pub const GIT_SUBMODULE_UPDATE: &str = "git.submodule.update";
pub const GIT_WORKTREE_REMOVE: &str = "git.worktree.remove";
pub const GIT_STASH_NEW: &str = "git.stash.new";
pub const GIT_UNCOMMITTED_RESET: &str = "git.uncommitted.reset";
pub const GIT_UNCOMMITTED_CLEAN: &str = "git.uncommitted.clean";
pub const GIT_COMMIT_CHERRY_PICK: &str = "git.commit.cherry_pick";
pub const GIT_COMMIT_REVERT: &str = "git.commit.revert";
pub const GIT_COMMIT_RESET: &str = "git.commit.reset";
pub const GIT_COMMIT_DROP: &str = "git.commit.drop";
pub const GIT_BRANCH_CHECKOUT: &str = "git.branch.checkout";
pub const GIT_BRANCH_CHECKOUT_LOCAL: &str = "git.branch.checkout_local";
pub const GIT_BRANCH_RENAME: &str = "git.branch.rename";
pub const GIT_BRANCH_MERGE: &str = "git.branch.merge";
pub const GIT_BRANCH_REBASE: &str = "git.branch.rebase";
pub const GIT_BRANCH_UPSTREAM_SET: &str = "git.branch.upstream_set";
pub const GIT_BRANCH_UPSTREAM_UNSET: &str = "git.branch.upstream_unset";
pub const GIT_BRANCH_PUSH: &str = "git.branch.push";
pub const GIT_BRANCH_FETCH: &str = "git.branch.fetch";
pub const GIT_BRANCH_DELETE: &str = "git.branch.delete";
pub const GIT_BRANCH_DELETE_REMOTE: &str = "git.branch.delete_remote";
pub const GIT_BRANCH_DELETE_BOTH: &str = "git.branch.delete_both";
pub const GIT_TAG_CREATE: &str = "git.tag.create";
pub const GIT_STASH_BRANCH: &str = "git.stash.branch";
pub const GIT_REMOTE_ADD: &str = "git.remote.add";
pub const GIT_COMPARE: &str = "git.compare";
pub const GIT_REPO_ADD: &str = "git.repo.add";
pub const FS_RENAME: &str = "fs.rename";
pub const FS_MOVE: &str = "fs.move";
pub const FS_COPY: &str = "fs.copy";
pub const FS_DELETE: &str = "fs.delete";
pub const FS_NAME: &str = "fs.name";
pub const EDITOR_ADD: &str = "editor.add";
pub const ENTITY_NAME: &str = "entity.name";
pub const RUN_CLOSE: &str = "run.close";
pub const RUN_DELETE: &str = "run.delete";
pub const RUN_MEMBER_DETACH: &str = "run.member.detach";
pub const SANDBOX_RUNTIME_START: &str = "sandbox.runtime.start";
pub const TERM_UPLOAD: &str = "term.upload";
pub const ACCESS_SAVE: &str = "access.save";
pub const FILE_CONVERT_UTF8: &str = "file.convert_utf8";

const FS_MISSING: &[&str] = &[
    apierr::CODE_NOT_FOUND,
    apierr::CODE_PERMISSION,
    apierr::CODE_IO,
];
const FS_PROTECTED: &[&str] = &[
    apierr::CODE_EDITOR_ROOT_PROTECTED,
    apierr::CODE_HOME_PROTECTED,
    apierr::CODE_FILESYSTEM_ROOT_PROTECTED,
];

/// 동작 id → 줄 수 있는 거절 사유. Go `Catalog`.
pub fn catalog() -> BTreeMap<&'static str, Vec<&'static str>> {
    let fs_protected = |more: &[&'static str]| [FS_PROTECTED, more].concat();
    let mut fs_delete = FS_MISSING.to_vec();
    fs_delete.push(apierr::CODE_TOO_MANY_ENTRIES);
    BTreeMap::from([
        (
            GIT_STASH_CREATE,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_NOTHING_TO_STASH,
                apierr::CODE_UNTRACKED_ONLY,
            ],
        ),
        (GIT_STAGE, vec![apierr::CODE_SUBMODULE_INNER_ONLY]),
        (GIT_FETCH, vec![apierr::CODE_JOB_BUSY]),
        (GIT_PULL, vec![apierr::CODE_JOB_BUSY]),
        (GIT_PUSH, vec![apierr::CODE_JOB_BUSY]),
        (GIT_TAG_PUSH, vec![apierr::CODE_JOB_BUSY]),
        (GIT_TAG_DELETE_REMOTE, vec![apierr::CODE_JOB_BUSY]),
        (GIT_WRITE, vec![apierr::CODE_JOB_BUSY]),
        (
            GIT_COMMIT,
            vec![
                apierr::CODE_EMPTY_MESSAGE,
                apierr::CODE_JOB_BUSY,
                apierr::CODE_PREFLIGHT_BLOCKED,
                apierr::CODE_NOTHING_STAGED,
            ],
        ),
        (GIT_LOCK_REMOVE, vec![apierr::CODE_JOB_BUSY]),
        (
            GIT_WORKTREE_CREATE,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_EMPTY_NAME,
                apierr::CODE_REF_NAME,
                apierr::CODE_EMPTY_REF,
                apierr::CODE_WORKTREE_EXISTS,
                apierr::CODE_BRANCH_EXISTS,
            ],
        ),
        (GIT_SUBMODULE_UPDATE, vec![apierr::CODE_JOB_BUSY]),
        (GIT_WORKTREE_REMOVE, vec![apierr::CODE_JOB_BUSY]),
        (
            GIT_STASH_NEW,
            vec![apierr::CODE_JOB_BUSY, apierr::CODE_NOTHING_TO_STASH],
        ),
        (
            GIT_UNCOMMITTED_RESET,
            vec![apierr::CODE_JOB_BUSY, apierr::CODE_NO_HEAD],
        ),
        (
            GIT_UNCOMMITTED_CLEAN,
            vec![apierr::CODE_JOB_BUSY, apierr::CODE_NOTHING_TO_CLEAN],
        ),
        (
            GIT_COMMIT_CHERRY_PICK,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_OPERATION_IN_PROGRESS,
                apierr::CODE_TARGET_IS_HEAD,
            ],
        ),
        (
            GIT_COMMIT_REVERT,
            vec![apierr::CODE_JOB_BUSY, apierr::CODE_OPERATION_IN_PROGRESS],
        ),
        (
            GIT_COMMIT_RESET,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_OPERATION_IN_PROGRESS,
                apierr::CODE_TARGET_IS_HEAD,
            ],
        ),
        (
            GIT_COMMIT_DROP,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_OPERATION_IN_PROGRESS,
                apierr::CODE_ROOT_COMMIT,
                apierr::CODE_MERGE_COMMIT,
            ],
        ),
        (
            GIT_BRANCH_CHECKOUT,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_NOT_LOCAL_BRANCH,
                apierr::CODE_BRANCH_CURRENT,
            ],
        ),
        (
            GIT_BRANCH_CHECKOUT_LOCAL,
            vec![apierr::CODE_JOB_BUSY, apierr::CODE_NOT_REMOTE_BRANCH],
        ),
        (
            GIT_BRANCH_RENAME,
            vec![apierr::CODE_JOB_BUSY, apierr::CODE_NOT_LOCAL_BRANCH],
        ),
        (
            GIT_BRANCH_MERGE,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_OPERATION_IN_PROGRESS,
                apierr::CODE_TARGET_IS_HEAD,
            ],
        ),
        (
            GIT_BRANCH_REBASE,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_OPERATION_IN_PROGRESS,
                apierr::CODE_TARGET_IS_HEAD,
            ],
        ),
        (
            GIT_BRANCH_UPSTREAM_SET,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_NOT_LOCAL_BRANCH,
                apierr::CODE_EMPTY_REF,
                apierr::CODE_UPSTREAM_UNKNOWN,
            ],
        ),
        (
            GIT_BRANCH_UPSTREAM_UNSET,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_NOT_LOCAL_BRANCH,
                apierr::CODE_NO_UPSTREAM,
            ],
        ),
        (
            GIT_BRANCH_PUSH,
            vec![apierr::CODE_JOB_BUSY, apierr::CODE_NOT_LOCAL_BRANCH],
        ),
        (
            GIT_BRANCH_FETCH,
            vec![apierr::CODE_JOB_BUSY, apierr::CODE_NOT_REMOTE_BRANCH],
        ),
        (
            GIT_BRANCH_DELETE,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_NOT_LOCAL_BRANCH,
                apierr::CODE_BRANCH_CURRENT,
            ],
        ),
        (
            GIT_BRANCH_DELETE_REMOTE,
            vec![apierr::CODE_JOB_BUSY, apierr::CODE_NOT_REMOTE_BRANCH],
        ),
        (
            GIT_BRANCH_DELETE_BOTH,
            vec![
                apierr::CODE_JOB_BUSY,
                apierr::CODE_NO_UPSTREAM,
                apierr::CODE_NO_TRACKING_BRANCH,
                apierr::CODE_MANY_TRACKING_BRANCH,
                apierr::CODE_BRANCH_CURRENT,
            ],
        ),
        (
            GIT_TAG_CREATE,
            vec![
                apierr::CODE_TAG_KIND_INVALID,
                apierr::CODE_TAG_MESSAGE_REQUIRED,
            ],
        ),
        (
            GIT_STASH_BRANCH,
            vec![
                apierr::CODE_EMPTY_NAME,
                apierr::CODE_REF_NAME,
                apierr::CODE_BRANCH_EXISTS,
            ],
        ),
        (
            GIT_REMOTE_ADD,
            vec![
                apierr::CODE_EMPTY_NAME,
                apierr::CODE_REMOTE_NAME_INVALID,
                apierr::CODE_EMPTY_URL,
                apierr::CODE_REMOTE_URL_INVALID,
                apierr::CODE_REMOTE_EXISTS,
            ],
        ),
        (
            GIT_COMPARE,
            vec![apierr::CODE_EMPTY_REV, apierr::CODE_EMPTY_PATH],
        ),
        (
            GIT_REPO_ADD,
            vec![
                apierr::CODE_EMPTY_PATH,
                apierr::CODE_ABS_PATH_NEEDED,
                apierr::CODE_NOT_REPO,
                apierr::CODE_REPO_MISSING,
            ],
        ),
        (FS_RENAME, fs_protected(FS_MISSING)),
        (FS_MOVE, fs_protected(FS_MISSING)),
        (FS_COPY, FS_MISSING.to_vec()),
        (FS_DELETE, fs_protected(&fs_delete)),
        (
            FS_NAME,
            vec![
                apierr::CODE_EMPTY_NAME,
                apierr::CODE_NAME_HAS_SEPARATOR,
                apierr::CODE_NAME_RESERVED,
            ],
        ),
        (ENTITY_NAME, vec![apierr::CODE_NAME_TOO_LONG]),
        (RUN_CLOSE, vec![apierr::CODE_RUN_CLOSED]),
        (RUN_DELETE, vec![]),
        (RUN_MEMBER_DETACH, vec![apierr::CODE_MEMBER_NOT_ATTACHED]),
        (
            EDITOR_ADD,
            vec![
                apierr::CODE_EMPTY_PATH,
                apierr::CODE_ABS_PATH_NEEDED,
                apierr::CODE_NOT_FOUND,
                apierr::CODE_NOT_A_DIRECTORY,
                apierr::CODE_FILESYSTEM_ROOT_PROTECTED,
            ],
        ),
        (
            SANDBOX_RUNTIME_START,
            vec![
                apierr::CODE_RUNTIME_MISSING,
                apierr::CODE_RUNTIME_START_MANUAL,
            ],
        ),
        (TERM_UPLOAD, vec![apierr::CODE_UPLOAD_NO_TOOL_CWD]),
        (ACCESS_SAVE, vec![apierr::CODE_LOCKS_YOU_OUT]),
        (
            FILE_CONVERT_UTF8,
            vec![apierr::CODE_ENCODING_UNDECODABLE, apierr::CODE_ALREADY_UTF8],
        ),
    ])
}

/// 그 동작이 그 사유를 줄 수 있는가.
pub fn may_give(table: &BTreeMap<&str, Vec<&str>>, id: &str, why: &str) -> bool {
    table.get(id).is_some_and(|ws| ws.contains(&why))
}

/// 로캘 원문(`src`: 로캘 → 파일 내용)에 `why.<사유>` 문구가 없는 것들. `로캘: 키` 꼴, 정렬돼 있다.
pub fn missing_phrases(
    table: &BTreeMap<&str, Vec<&str>>,
    src: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut codes: BTreeSet<String> = BTreeSet::from([format!("why.{WHY_LOADING}")]);
    for whys in table.values() {
        codes.extend(whys.iter().map(|w| format!("why.{w}")));
    }
    let mut out = Vec::new();
    for (l, text) in src {
        for k in &codes {
            if !has_key(text, k) {
                out.push(format!("{l}: {k}"));
            }
        }
    }
    out
}

fn has_key(src: &str, key: &str) -> bool {
    Regex::new(&format!(r#"['"]{}['"]\s*:"#, regex::escape(key))).is_ok_and(|re| re.is_match(src))
}

#[cfg(test)]
mod tests;
