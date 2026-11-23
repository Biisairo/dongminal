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

/// 진행 중인 작업(merge·rebase 등)이 새 작업을 막는가다 (FR-SDA-32).
pub(crate) fn op_answer(st: &Status) -> Answer {
    let k = &st.operation.kind;
    if !k.is_empty() {
        return deny(
            CONFLICT,
            apierr::CODE_OPERATION_IN_PROGRESS,
            args1("kind", k.clone().into()),
        );
    }
    allow()
}

/// 커밋 메시지의 판정이다 (GR-3b ①). 실행 종단은 이것을 잠금보다 먼저 본다.
pub(crate) fn commit_message_answer(msg: &str) -> Answer {
    if blank(msg) {
        return deny(BAD_REQUEST, apierr::CODE_EMPTY_MESSAGE, None);
    }
    allow()
}

/// 저장소 상태로 본 커밋의 판정이다 (GR-3b ③④ · FR-GIT-84·86). `amend_unchanged` 는 git 을
/// 부르므로 필요할 때만 부른다.
pub(crate) async fn commit_state_answer<F, Fut>(
    st: &Status,
    pf: &query::Preflight,
    all: bool,
    amend: bool,
    amend_unchanged: F,
) -> Answer
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    if !pf.blocks.is_empty() {
        let blocks = serde_json::to_value(&pf.blocks).unwrap_or_default();
        return deny(
            CONFLICT,
            apierr::CODE_PREFLIGHT_BLOCKED,
            args1("blocks", blocks),
        );
    }
    if st.staged.is_empty() && !all && (!amend || amend_unchanged().await) {
        return deny(BAD_REQUEST, apierr::CODE_NOTHING_STAGED, None);
    }
    allow()
}

/// 판정에 쓰는 저장소의 사실이다 (GT-d). 요청의 이름은 실제 ref 에 대 본다.
#[derive(Clone, Debug, Default)]
pub(crate) struct BranchFacts {
    pub(crate) refs: Vec<query::Ref>,
    pub(crate) st: Status,
}

impl BranchFacts {
    pub(crate) fn find(&self, kind: &str, short: &str) -> Option<&query::Ref> {
        self.refs.iter().find(|r| r.kind == kind && r.short == short)
    }

    /// 그 종류의 ref 다. 없으면 이름만 든 빈 종류의 ref 다 — 판정이 "그 종류가 아니다" 로 답한다.
    pub(crate) fn ref_or(&self, kind: &str, short: &str) -> query::Ref {
        self.find(kind, short).cloned().unwrap_or_else(|| query::Ref {
            short: short.to_owned(),
            ..query::Ref::default()
        })
    }

    /// 로컬 → 원격 순으로 찾은 ref 다. 둘 다 없으면 `None`(oid·태그 등).
    pub(crate) fn any_ref(&self, short: &str) -> Option<query::Ref> {
        self.find(query::REF_KIND_LOCAL, short)
            .or_else(|| self.find(query::REF_KIND_REMOTE, short))
            .cloned()
    }
}

/// 양쪽 삭제의 짝이다 (FR-SDA-35). git 이 짝이라고 적어 둔 추적 관계만 짝이다.
fn branch_pair(r: &query::Ref, f: &BranchFacts) -> (query::Ref, String, Answer) {
    if r.kind == query::REF_KIND_LOCAL {
        if r.upstream.is_empty() {
            return (
                query::Ref::default(),
                String::new(),
                deny(CONFLICT, apierr::CODE_NO_UPSTREAM, None),
            );
        }
        return (r.clone(), r.upstream.clone(), allow());
    }
    let hits: Vec<&query::Ref> = f
        .refs
        .iter()
        .filter(|l| l.kind == query::REF_KIND_LOCAL && l.upstream == r.short)
        .collect();
    match hits.as_slice() {
        [] => (
            query::Ref::default(),
            String::new(),
            deny(CONFLICT, apierr::CODE_NO_TRACKING_BRANCH, None),
        ),
        [one] => ((*one).clone(), r.short.clone(), allow()),
        _ => (
            query::Ref::default(),
            String::new(),
            deny(CONFLICT, apierr::CODE_MANY_TRACKING_BRANCH, None),
        ),
    }
}

fn not_kind(kind: &str, r: &query::Ref) -> Answer {
    if r.kind == kind {
        return allow();
    }
    if kind == query::REF_KIND_LOCAL {
        return deny(BAD_REQUEST, apierr::CODE_NOT_LOCAL_BRANCH, None);
    }
    deny(BAD_REQUEST, apierr::CODE_NOT_REMOTE_BRANCH, None)
}

fn current() -> Answer {
    deny(CONFLICT, apierr::CODE_BRANCH_CURRENT, None)
}

/// 원격 ref 를 가를 수 없다.
pub(crate) fn not_remote() -> Answer {
    deny(BAD_REQUEST, apierr::CODE_NOT_REMOTE_BRANCH, None)
}

/// 브랜치 동작 하나의 판정이다 — 칸은 보지 않는다.
pub(crate) fn branch_answer(id: &str, r: &query::Ref, f: &BranchFacts) -> Answer {
    let local = r.kind == query::REF_KIND_LOCAL;
    match id {
        action::GIT_BRANCH_CHECKOUT | action::GIT_BRANCH_DELETE => {
            let a = not_kind(query::REF_KIND_LOCAL, r);
            if !a.ok {
                return a;
            }
            if r.is_head {
                return current();
            }
        }
        action::GIT_BRANCH_CHECKOUT_LOCAL
        | action::GIT_BRANCH_FETCH
        | action::GIT_BRANCH_DELETE_REMOTE => return not_kind(query::REF_KIND_REMOTE, r),
        action::GIT_BRANCH_RENAME | action::GIT_BRANCH_UPSTREAM_SET | action::GIT_BRANCH_PUSH => {
            return not_kind(query::REF_KIND_LOCAL, r);
        }
        action::GIT_BRANCH_UPSTREAM_UNSET => {
            let a = not_kind(query::REF_KIND_LOCAL, r);
            if !a.ok {
                return a;
            }
            if r.upstream.is_empty() {
                return deny(CONFLICT, apierr::CODE_NO_UPSTREAM, None);
            }
        }
        action::GIT_BRANCH_MERGE | action::GIT_BRANCH_REBASE => {
            let a = op_answer(&f.st);
            if !a.ok {
                return a;
            }
            if local && r.is_head {
                return deny(CONFLICT, apierr::CODE_TARGET_IS_HEAD, None);
            }
        }
        action::GIT_BRANCH_DELETE_BOTH => {
            let (loc, _, a) = branch_pair(r, f);
            if !a.ok {
                return a;
            }
            if loc.is_head {
                return current();
            }
        }
        _ => {}
    }
    allow()
}

/// upstream 설정의 판정이다 (GV-f · FR-SDA-41). 브랜치는 로컬이어야 하고, upstream 은 이
/// 저장소가 아는 원격 ref 여야 한다.
pub(crate) fn upstream_answer(f: &BranchFacts, branch: &str, upstream: &str) -> Answer {
    let a = branch_answer(
        action::GIT_BRANCH_UPSTREAM_SET,
        &f.ref_or(query::REF_KIND_LOCAL, branch),
        f,
    );
    if !a.ok {
        return a;
    }
    if blank(upstream) {
        return deny(BAD_REQUEST, apierr::CODE_EMPTY_REF, None);
    }
    if f.find(query::REF_KIND_REMOTE, upstream).is_none() {
        return deny(BAD_REQUEST, apierr::CODE_UPSTREAM_UNKNOWN, None);
    }
    allow()
}

impl GitServer {
    pub(crate) async fn branch_facts(
        &self,
        git: &Arc<Store>,
        ctx: &Ctx,
        root: &str,
        st: Status,
    ) -> Result<BranchFacts, query::Error> {
        let refs = query::refs(git.service(), ctx, root).await?;
        Ok(BranchFacts { refs, st })
    }

    /// 원격 추가의 판정이다 (GV-c · G-B4). 실행(`write::remote_add`)도 같은 검사를 지난다.
    pub(crate) async fn remote_add_answer(
        &self,
        git: &Arc<Store>,
        ctx: &Ctx,
        root: &str,
        name: &str,
        url: &str,
    ) -> Result<Answer, query::Error> {
        if blank(name) {
            return Ok(deny(BAD_REQUEST, apierr::CODE_EMPTY_NAME, None));
        }
        if let Err(e) = write::check_remote_name(name) {
            return Ok(err_answer(Some(&e)));
        }
        if blank(url) {
            return Ok(deny(BAD_REQUEST, apierr::CODE_EMPTY_URL, None));
        }
        if let Err(e) = write::check_remote_url(url) {
            return Ok(err_answer(Some(&e)));
        }
        let list = query::remotes(git.service(), ctx, root).await?;
        if list.iter().any(|r| r.name == name) {
            return Ok(deny(CONFLICT, apierr::CODE_REMOTE_EXISTS, None));
        }
        Ok(allow())
    }
}
