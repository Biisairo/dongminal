//! 동작의 판정 함수 중 5.4.1 의 기반이 부르는 것 (Go `handlers_git_actions*.go` ·
//! `handlers_git_uncommitted.go` · `handlers_git_branch.go` 에서 당겨 온 것).
//!
//! 답 종단과 실행 종단의 거절이 같은 함수를 부른다 (SERVER_DRIVEN_ACTIONS_SRS D-SDA-6).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use dm_webserver_action::{self as action, Answer, allow, deny};
use dm_webserver_apierr::{self as apierr, Classify};
use dm_webserver_domain_git_core::Ctx;
use dm_webserver_domain_git_jobs::{self as jobs, Exclusion, Keys, SLOT_INDEX};
use dm_webserver_domain_git_query::{self as query, FileEntry, Status};
use dm_webserver_domain_git_store::Store;
use dm_webserver_domain_git_write as write;

use crate::GitServer;
use crate::reply::{Obj, obj};

const CONFLICT: u16 = 409;
const BAD_REQUEST: u16 = 400;

fn args1(k: &str, v: serde_json::Value) -> Option<BTreeMap<String, serde_json::Value>> {
    Some(BTreeMap::from([(k.to_owned(), v)]))
}

/// 칸을 쥔 잡을 묻는 자리다 — `Exclusion` 이 답한다.
pub(crate) trait SlotReader {
    fn index_busy(&self, top: &str) -> Option<String>;
    fn common_busy(&self, common: &str) -> Option<String>;
}

impl SlotReader for Exclusion {
    fn index_busy(&self, top: &str) -> Option<String> {
        Exclusion::index_busy(self, top)
    }
    fn common_busy(&self, common: &str) -> Option<String> {
        Exclusion::common_busy(self, common)
    }
}

/// 작업 칸의 판정이다 (GR-1a). 칸 중 하나라도 잡이 쥐면 409 job_busy.
pub(crate) fn slots_answer<S: AsRef<str>>(x: &impl SlotReader, k: &Keys, slots: &[S]) -> Answer {
    for slot in slots {
        let busy = if slot.as_ref() == SLOT_INDEX {
            x.index_busy(&k.top)
        } else {
            x.common_busy(&k.common)
        };
        if let Some(id) = busy {
            return deny(CONFLICT, apierr::CODE_JOB_BUSY, args1("job", id.into()));
        }
    }
    allow()
}

/// 1층에 싣는 작업 칸 동작과 그 칸이다 (GR-1b).
fn repo_slot_actions() -> Vec<(&'static str, Vec<String>)> {
    let one = |s: &str| vec![s.to_owned()];
    vec![
        (action::GIT_FETCH, jobs::slots_of("fetch")),
        (action::GIT_PULL, jobs::slots_of("pull")),
        (action::GIT_PUSH, jobs::slots_of("push")),
        (action::GIT_TAG_PUSH, jobs::slots_of("push")),
        (action::GIT_TAG_DELETE_REMOTE, jobs::slots_of("push")),
        (action::GIT_WRITE, one(SLOT_INDEX)),
        (
            action::GIT_LOCK_REMOVE,
            vec![SLOT_INDEX.to_owned(), jobs::SLOT_COMMON.to_owned()],
        ),
        (action::GIT_WORKTREE_CREATE, one(jobs::SLOT_COMMON)),
        (action::GIT_SUBMODULE_UPDATE, jobs::slots_of("submodule")),
    ]
}

/// 1층에 싣는 상태 사실 동작이다 (GR-2). 셋 다 index 칸을 쓰는 쓰기다.
type Judge = fn(&Status) -> Answer;

const REPO_FACT_ACTIONS: [(&str, Judge); 3] = [
    (action::GIT_STASH_NEW, stash_new_answer),
    (action::GIT_UNCOMMITTED_RESET, reset_answer),
    (action::GIT_UNCOMMITTED_CLEAN, clean_answer),
];

/// 생성 대화상자를 열 수 있는가다 (GR-2b).
fn stash_new_answer(st: &Status) -> Answer {
    stash_create_answer(st, true)
}

/// stash 만들기의 판정이다 (FR-SDA-24 · FR-GIT-167).
pub(crate) fn stash_create_answer(st: &Status, include_untracked: bool) -> Answer {
    if write::stashable_count(st, include_untracked) > 0 {
        return allow();
    }
    if !include_untracked && !st.untracked.is_empty() {
        return deny(
            CONFLICT,
            apierr::CODE_UNTRACKED_ONLY,
            args1("count", st.untracked.len().into()),
        );
    }
    deny(CONFLICT, apierr::CODE_NOTHING_TO_STASH, None)
}

fn groups(st: &Status) -> [&[FileEntry]; 3] {
    [&st.staged, &st.changes, &st.conflicts]
}

/// 경로들을 stage 할 수 있는가다 (FR-FR1-6). 모두 안쪽만 바뀐 서브모듈이면 409.
pub(crate) fn stage_answer<S: AsRef<str>>(st: &Status, paths: &[S]) -> Answer {
    if paths.is_empty() {
        return allow();
    }
    let inner: BTreeSet<&str> = groups(st)
        .iter()
        .flat_map(|g| g.iter())
        .filter(|e| e.submodule_inner_only())
        .map(|e| e.path.as_str())
        .collect();
    let all_inner = paths.iter().all(|p| {
        let p = p.as_ref();
        inner.contains(p.strip_suffix('/').unwrap_or(p))
    });
    if all_inner {
        deny(CONFLICT, apierr::CODE_SUBMODULE_INNER_ONLY, None)
    } else {
        allow()
    }
}

/// 변경 목록 행의 답이다 (FR-FR1-8). 서브모듈 행에만 싣는다.
pub(crate) fn row_actions(st: &Status) -> BTreeMap<String, BTreeMap<String, Answer>> {
    let mut out = BTreeMap::new();
    for e in groups(st).iter().flat_map(|g| g.iter()) {
        if e.dir && !e.sub.is_empty() {
            let a = stage_answer(st, &[e.path.as_str()]);
            out.insert(
                e.path.clone(),
                BTreeMap::from([(action::GIT_STAGE.to_owned(), a)]),
            );
        }
    }
    out
}

/// Reset 의 판정이다 (FR-SDA-25). 커밋이 없으면 HEAD 로 되돌릴 수 없다.
pub(crate) fn reset_answer(st: &Status) -> Answer {
    if st.initial {
        return deny(CONFLICT, apierr::CODE_NO_HEAD, None);
    }
    allow()
}

/// Clean 의 판정이다 — 지울 것이 없으면 실행하지 않는다.
pub(crate) fn clean_answer(st: &Status) -> Answer {
    if st.untracked.is_empty() {
        return deny(CONFLICT, apierr::CODE_NOTHING_TO_CLEAN, None);
    }
    allow()
}

/// 도메인 검사의 오류를 답으로 옮긴다 (GV-b). 표에 없는 오류는 400 bad_request 다.
pub(crate) fn err_answer<E: Classify + ?Sized>(err: Option<&E>) -> Answer {
    let Some(err) = err else {
        return allow();
    };
    match apierr::GIT.lookup(err) {
        Some((status, code)) => deny(status, code, None),
        None => deny(BAD_REQUEST, apierr::CODE_BAD_REQUEST, None),
    }
}

pub(crate) fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

/// 이름 충돌 409 의 표면 고유 필드다.
pub(crate) fn branch_exists_body(name: &str, track: &str) -> Obj {
    obj! {"branch" => name, "track" => track, "options" => write::BRANCH_CONFLICT_OPTIONS}
}

/// `origin/x` 를 원격과 브랜치로 가른다. 가장 긴 원격 이름이 이긴다 (GT-e · G-B8).
pub(crate) fn split_remote_ref(remotes: &mut [String], short: &str) -> Option<(String, String)> {
    remotes.sort_by_key(|r| std::cmp::Reverse(r.len()));
    remotes.iter().find_map(|rm| {
        let rest = short.strip_prefix(rm.as_str())?.strip_prefix('/')?;
        (!rest.is_empty()).then(|| (rm.clone(), rest.to_owned()))
    })
}

impl GitServer {
    /// 저장소 하나의 1층 답이다 (FR-SDA-4·20). 칸 상태는 요청마다 읽는다.
    pub(crate) async fn repo_actions(
        &self,
        git: &Arc<Store>,
        ctx: &Ctx,
        root: &str,
        st: &Status,
    ) -> Result<BTreeMap<String, Answer>, query::Error> {
        let keys = self.git_keys(git, ctx, root).await?;
        let x = self.exclusion();
        let mut out = BTreeMap::new();
        for (id, slots) in repo_slot_actions() {
            out.insert(id.to_owned(), slots_answer(&x, &keys, &slots));
        }
        let index = slots_answer(&x, &keys, &[SLOT_INDEX]);
        for (id, judge) in REPO_FACT_ACTIONS {
            out.insert(id.to_owned(), action::first([index.clone(), judge(st)]));
        }
        Ok(out)
    }

    /// 저장소 추가의 판정이다 (GV-c · G-B7). 4xx 판정은 답이고 5xx 는 오류다. 참이면 핀할 루트다.
    pub(crate) async fn repo_add_answer(
        &self,
        git: &Arc<Store>,
        ctx: &Ctx,
        path: &str,
    ) -> Result<(Answer, String), query::Error> {
        if blank(path) {
            return Ok((
                deny(BAD_REQUEST, apierr::CODE_EMPTY_PATH, None),
                String::new(),
            ));
        }
        if !dm_gocompat::filepath::is_abs(path) {
            return Ok((
                deny(BAD_REQUEST, apierr::CODE_ABS_PATH_NEEDED, None),
                String::new(),
            ));
        }
        match git.repo_root(ctx, path).await {
            Ok(root) => Ok((allow(), root)),
            Err(e) => match apierr::GIT.lookup(&e) {
                Some((status, _)) if status < 500 => Ok((err_answer(Some(&e)), String::new())),
                _ => Err(e),
            },
        }
    }

    /// 저장소의 원격 이름들이다.
    pub(crate) async fn remote_names(
        &self,
        git: &Arc<Store>,
        ctx: &Ctx,
        root: &str,
    ) -> Result<Vec<String>, query::Error> {
        let remotes = query::remotes(git.service(), ctx, root).await?;
        Ok(remotes.into_iter().map(|r| r.name).collect())
    }
}
