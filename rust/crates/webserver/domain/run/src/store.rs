//! runs.json 저장소 (FR-RUN-8). 최근 Run 이 앞이다.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};

use otter_gocompat::json;
use otter_gocompat::oserr::{go_error_string, path_error};
use otter_gocompat::strconv::quote;
use otter_shared_pollwait::{Changed, Signal};
use serde::{Deserialize, Serialize};

use crate::assign::Assignment;
use crate::{
    CLOSED, DONE, Error, FAILED, MODE_COORD, MODE_TREE, Member, MsgEvent, OPEN, OUTCOME_FAILED,
    OUTCOME_SUCCEEDED, Record, STARTING, Worktree, valid_isolation, valid_projection,
};

const SCHEMA_VERSION: i64 = 1;
const FILE_NAME: &str = otter_shared_runfile::FILE_NAME;
const FILE_PERM: u32 = 0o644;

/// Run 하나에 남기는 메시지 메타데이터의 상한.
pub const MAX_MESSAGES: usize = 500;
/// 조정자를 가리키는 발신자 이름.
pub const COORDINATOR_PARTY: &str = "coordinator";
pub const MSG_KIND_AGENT: &str = "agent";

#[derive(Serialize)]
struct FileOut<'a> {
    #[serde(rename = "schemaVersion")]
    schema_version: i64,
    runs: &'a [Record],
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "run.fileBody")]
struct FileIn {
    #[serde(rename = "schemaVersion")]
    _schema_version: i64,
    runs: Vec<Record>,
}

type Clock = Box<dyn Fn() -> i64 + Send + Sync>;
type IdGen = Box<dyn Fn() -> String + Send + Sync>;
type Writer = Box<dyn Fn(&Path, &[u8], u32) -> io::Result<()> + Send + Sync>;

pub(crate) struct Inner {
    pub(crate) runs: Vec<Record>,
    save_gen: u64,
}

/// Run 기록 저장소. 변경은 runs.json 에 바로 쓰고, 쓰지 못하면 마지막으로 쓴 상태로 되돌린다.
pub struct Store {
    dir: PathBuf,
    now: Clock,
    new_id: IdGen,
    write: Writer,
    inner: Mutex<Inner>,
    /// 마지막으로 쓴 runs.json 바이트. 쓰기 잠금(Go `writeMu`)을 겸한다 — 쓰기는 이 잠금 아래에서
    /// 상태 잠금을 풀고 한다. 조회가 디스크 쓰기를 기다리지 않는다 (NFR-RSP-3).
    persisted: Mutex<Vec<u8>>,
    done_gen: AtomicU64,
    ok_gen: AtomicU64,
    written: Condvar,
    changed: Signal,
}

/// Run 을 여는 값 (FR-RUN-3).
#[derive(Debug, Clone, Default)]
pub struct StartOptions {
    pub id: String,
    pub objective: String,
    pub projection: String,
    pub isolation: String,
    pub coordinator_tool_id: String,
    pub window_id: String,
    pub repo: String,
    pub base: String,
    pub merge_into: String,
    pub worktree: Option<Worktree>,
    pub tree: String,
    pub tree_branch: bool,
    /// 로컬 이슈 트리의 원본 이슈 폴더. 트리와 함께만 받는다. 가지 Run 은 비워 두면 루트의 것을 잇는다 (FR-LIS-7).
    pub issue_dir: String,
    /// 트리 실행 방식(`tree`·`coord`, 비면 tree). 트리와 함께만 받는다 (FR-LIS-1).
    pub mode: String,
}

/// 멤버를 더하는 값.
#[derive(Debug, Clone, Default)]
pub struct MemberSpec {
    pub id: String,
    pub role: String,
    pub agent: String,
    pub brief: String,
    pub tool_id: String,
    pub tab_id: String,
    pub worktree: Option<Worktree>,
    pub headless: bool,
    pub assign: Option<Assignment>,
}

/// 멤버의 보고 (FR-RUN-6).
#[derive(Debug, Clone, Default)]
pub struct ReportSpec {
    pub run_id: String,
    pub member_id: String,
    pub outcome: String,
    pub summary: String,
    pub files_modified: Vec<String>,
}

/// 작업 트리 정리 결과 하나.
#[derive(Debug, Clone, Default)]
pub struct WorktreeMark {
    pub path: String,
    pub removed: bool,
    pub residue: String,
    pub detail: String,
}

impl Store {
    /// dir 의 runs.json 을 쓰는 저장소. 시계는 Unix 초, id 는 uuid 다.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            now: Box::new(time_now),
            new_id: Box::new(otter_shared_uuid::new_string),
            write: Box::new(otter_shared_platform::write_state_file),
            inner: Mutex::new(Inner {
                runs: Vec::new(),
                save_gen: 0,
            }),
            persisted: Mutex::new(Vec::new()),
            done_gen: AtomicU64::new(0),
            ok_gen: AtomicU64::new(0),
            written: Condvar::new(),
            changed: Signal::default(),
        }
    }

    /// 시계를 바꾼다 (Go `WithClock`).
    pub fn with_clock(mut self, now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        self.now = Box::new(now);
        self
    }

    /// id 생성기를 바꾼다 (Go `WithIDGen`).
    pub fn with_id_gen(mut self, f: impl Fn() -> String + Send + Sync + 'static) -> Self {
        self.new_id = Box::new(f);
        self
    }

    /// runs.json 쓰기를 바꾼다. 쓰기 실패와 되돌림을 시험할 때 쓴다.
    pub fn with_writer(
        mut self,
        f: impl Fn(&Path, &[u8], u32) -> io::Result<()> + Send + Sync + 'static,
    ) -> Self {
        self.write = Box::new(f);
        self
    }

    fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn persisted(&self) -> MutexGuard<'_, Vec<u8>> {
        self.persisted.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn now(&self) -> i64 {
        (self.now)()
    }

    pub(crate) fn new_id(&self) -> String {
        (self.new_id)()
    }

    /// runs.json 을 읽는다. 없거나 깨졌으면 빈 상태로 시작한다 — 오류를 내지 않는다.
    pub fn load(&self) {
        let mut g = self.lock();
        let path = self.path();
        let blob = match fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    let e = go_error_string(&path_error("open", &path.to_string_lossy(), e));
                    otter_shared_otterlog::errorf!(
                        None,
                        "[run] runs.json 읽기 실패 — 빈 상태로 시작한다: {e}"
                    );
                }
                g.runs.clear();
                self.persisted().clear();
                return;
            }
        };
        match json::unmarshal::<FileIn>(&blob) {
            Ok(body) => {
                g.runs = body.runs;
                *self.persisted() = blob;
            }
            Err(e) => {
                otter_shared_otterlog::errorf!(
                    None,
                    "[run] runs.json 파싱 실패 — 빈 상태로 시작한다: {e}"
                );
                g.runs.clear();
                self.persisted().clear();
            }
        }
    }

    /// 지금 상태를 쓴다. 상태 잠금은 쓰는 동안 풀린다. 실패하면, 뒤의 저장이 성공해 덮지 않는 한
    /// 마지막으로 쓴 상태로 되돌린다. 변경 알림은 언제나 낸다.
    pub(crate) fn save(&self, g: MutexGuard<'_, Inner>) -> Result<(), Error> {
        let r = self.save_inner(g);
        self.changed.notify();
        r
    }

    fn save_inner(&self, mut g: MutexGuard<'_, Inner>) -> Result<(), Error> {
        let blob = json::marshal(&FileOut {
            schema_version: SCHEMA_VERSION,
            runs: &g.runs,
        })
        .map_err(|e| Error::Write(e.to_string()))?;
        g.save_gen += 1;
        let seq = g.save_gen;
        let mut persisted = self.persisted();
        drop(g);
        let res = (self.write)(&self.path(), &blob, FILE_PERM);
        if res.is_ok() {
            *persisted = blob;
            self.ok_gen.store(seq, Ordering::SeqCst);
        }
        self.done_gen.store(seq, Ordering::SeqCst);
        drop(persisted);
        let mut g = self.lock();
        self.written.notify_all();
        let Err(e) = res else {
            return Ok(());
        };
        let err = Error::Write(go_error_string(&e));
        // 뒤에 시작한 저장이 있으면 그 결과를 기다린다. 성공했으면 이 실패는 덮였다.
        while seq != g.save_gen {
            if self.ok_gen.load(Ordering::SeqCst) > seq {
                return Ok(());
            }
            if self.done_gen.load(Ordering::SeqCst) == g.save_gen {
                return Err(err);
            }
            g = self.written.wait(g).unwrap_or_else(|e| e.into_inner());
        }
        let persisted = self.persisted();
        let current = std::mem::take(&mut g.runs);
        g.runs = rollback_runs(&persisted, current);
        Err(err)
    }

    // ── 조회 ──

    pub fn get(&self, run_id: &str) -> Option<Record> {
        let g = self.lock();
        index_of(&g.runs, run_id).map(|i| g.runs[i].clone())
    }

    pub fn list(&self) -> Vec<Record> {
        self.lock().runs.clone()
    }

    /// 저장할 때마다 울리는 신호.
    pub fn changes(&self) -> Changed {
        self.changed.c()
    }

    pub fn has_open(&self) -> bool {
        self.lock().runs.iter().any(|r| r.state == OPEN)
    }

    /// 열린 Run 에서 그 도구의 멤버.
    pub fn member_by_tool(&self, tool_id: &str) -> Option<Member> {
        let g = self.lock();
        find_by_tool(&g.runs, tool_id).map(|(ri, mi)| g.runs[ri].members[mi].clone())
    }

    pub fn find_member(&self, member_id: &str) -> Option<(Record, Member)> {
        let g = self.lock();
        if member_id.is_empty() {
            return None;
        }
        index_of_member(&g.runs, member_id)
            .map(|(ri, mi)| (g.runs[ri].clone(), g.runs[ri].members[mi].clone()))
    }

    // ── 쓰기 ──

    /// Run 을 연다 (FR-RUN-3). 트리 Run 은 같은 트리의 열린 Run 과 겹치지 않는다.
    pub fn start(&self, opt: StartOptions) -> Result<Record, Error> {
        if opt.objective.trim().is_empty() {
            return Err(Error::invalid("objective 는 비어 있을 수 없다"));
        }
        if !valid_projection(&opt.projection) {
            return Err(Error::invalid(format!(
                "알 수 없는 projection: {}",
                quote(&opt.projection)
            )));
        }
        if !valid_isolation(&opt.isolation) {
            return Err(Error::invalid(format!(
                "알 수 없는 isolation: {}",
                quote(&opt.isolation)
            )));
        }
        let mut g = self.lock();
        let tree = opt.tree.trim().to_owned();
        if !tree.is_empty() {
            check_tree(&g.runs, &tree, opt.tree_branch)?;
        }
        let mut issue_dir = opt.issue_dir.trim().to_owned();
        if tree.is_empty() && !issue_dir.is_empty() {
            return Err(Error::invalid("issueDir 는 tree 와 함께 쓴다"));
        }
        let mode = match opt.mode.trim() {
            "" | MODE_TREE => String::new(),
            MODE_COORD if !tree.is_empty() => MODE_COORD.to_owned(),
            MODE_COORD => return Err(Error::invalid("mode 는 tree 와 함께 쓴다")),
            m => {
                return Err(Error::invalid(format!("알 수 없는 mode: {}", quote(m))));
            }
        };
        if issue_dir.is_empty() && opt.tree_branch {
            issue_dir = open_tree_runs(&g.runs, &tree)
                .find(|r| !r.tree_branch)
                .map(|r| r.issue_dir.clone())
                .unwrap_or_default();
        }
        let mut id = opt.id.trim().to_owned();
        if id.is_empty() {
            id = self.new_id();
        }
        let rec = Record {
            short: short(&id),
            id,
            objective: opt.objective.trim().to_owned(),
            projection: opt.projection,
            isolation: opt.isolation,
            state: OPEN.to_owned(),
            coordinator_tool_id: opt.coordinator_tool_id,
            window_id: opt.window_id,
            repo: opt.repo,
            base: opt.base,
            merge_into: opt.merge_into,
            worktree: opt.worktree,
            tree_branch: !tree.is_empty() && opt.tree_branch,
            tree,
            issue_dir,
            mode,
            created_at: self.now(),
            ..Record::default()
        };
        g.runs.insert(0, rec.clone());
        self.save(g)?;
        Ok(rec)
    }

    /// 멤버를 더한다. 도구 하나는 열린 Run 에서 한 멤버만 된다.
    pub fn add_member(&self, run_id: &str, spec: MemberSpec) -> Result<Member, Error> {
        if spec.role.trim().is_empty()
            || spec.agent.trim().is_empty()
            || spec.tool_id.trim().is_empty()
        {
            return Err(Error::invalid("role·agent·toolId 는 모두 필요하다"));
        }
        if let Err(e) = otter_shared_agentadapter::get(spec.agent.trim()) {
            return Err(Error::invalid(e.to_string()));
        }
        let mut g = self.lock();
        let idx = index_of(&g.runs, run_id).ok_or(Error::UnknownRun)?;
        if g.runs[idx].state != OPEN {
            return Err(Error::RunClosed);
        }
        if find_by_tool(&g.runs, &spec.tool_id).is_some() {
            return Err(Error::ToolAlreadyMember);
        }
        crate::assign::check_assign(&g.runs, &g.runs[idx], spec.assign.as_ref())?;
        let tree = g.runs[idx].tree.clone();
        if !tree.is_empty() {
            let role = spec.role.trim();
            for r in open_tree_runs(&g.runs, &tree) {
                if let Some(m) = r.members.iter().find(|m| m.role == role && !m.settled()) {
                    return Err(Error::NodeTaken {
                        member_id: m.id.clone(),
                    });
                }
            }
        }
        let mut id = spec.id.trim().to_owned();
        if id.is_empty() {
            id = self.new_id();
        }
        let m = Member {
            id,
            run_id: run_id.to_owned(),
            role: spec.role.trim().to_owned(),
            agent: spec.agent.trim().to_owned(),
            brief: spec.brief.trim().to_owned(),
            tool_id: spec.tool_id,
            tab_id: spec.tab_id,
            worktree: spec.worktree,
            headless: spec.headless,
            assign: spec.assign,
            state: STARTING.to_owned(),
            created_at: self.now(),
            ..Member::default()
        };
        g.runs[idx].members.push(m.clone());
        self.save(g)?;
        Ok(m)
    }

    /// 멤버의 보고. 발신자의 도구로 멤버를 찾고, 실려 온 id 가 다르면 거절한다 (FR-RUN-6).
    pub fn report(&self, sender_tool_id: &str, spec: ReportSpec) -> Result<Member, Error> {
        if spec.outcome != OUTCOME_SUCCEEDED && spec.outcome != OUTCOME_FAILED {
            return Err(Error::invalid(format!(
                "outcome 은 succeeded 또는 failed 여야 한다: {}",
                quote(&spec.outcome)
            )));
        }
        if spec.summary.trim().is_empty() {
            return Err(Error::invalid(
                "summary 는 비어 있을 수 없다 — 조정자가 먼저 읽는 것이다",
            ));
        }
        let mut g = self.lock();
        let (ri, mi) = sender_member(&g.runs, sender_tool_id)?;
        let rec_id = g.runs[ri].id.clone();
        let m = &mut g.runs[ri].members[mi];
        if (!spec.run_id.is_empty() && spec.run_id != rec_id)
            || (!spec.member_id.is_empty() && spec.member_id != m.id)
        {
            return Err(Error::RunMemberMismatch);
        }
        if m.reported() {
            return Err(Error::AlreadyReported);
        }
        m.state = if spec.outcome == OUTCOME_SUCCEEDED {
            DONE
        } else {
            FAILED
        }
        .to_owned();
        m.outcome = spec.outcome;
        m.summary = spec.summary.trim().to_owned();
        m.files_modified = spec.files_modified;
        m.reported_at = self.now();
        let out = m.clone();
        self.save(g)?;
        Ok(out)
    }

    /// Run 을 닫는다. 보고하지 않은 멤버가 있으면 force 일 때만 닫는다.
    /// 두 번째 값은 보고하지 않은 멤버다(거절됐을 때도 싣는다).
    pub fn close(&self, run_id: &str, force: bool) -> (Result<Record, Error>, Vec<Member>) {
        let mut g = self.lock();
        let Some(idx) = index_of(&g.runs, run_id) else {
            return (Err(Error::UnknownRun), Vec::new());
        };
        let pending = match check_close(&g.runs[idx], force) {
            Ok(p) => p,
            Err((e, p)) => return (Err(e), p),
        };
        let now = self.now();
        let rec = &mut g.runs[idx];
        rec.state = CLOSED.to_owned();
        rec.closed_at = now;
        let out = rec.clone();
        match self.save(g) {
            Ok(()) => (Ok(out), pending),
            Err(e) => (Err(e), Vec::new()),
        }
    }

    /// 닫힌 Run 의 정리 대상. 열린 Run 은 거절한다.
    pub fn sweep(&self, run_id: &str) -> Result<Record, Error> {
        let g = self.lock();
        let idx = index_of(&g.runs, run_id).ok_or(Error::UnknownRun)?;
        if g.runs[idx].state == OPEN {
            return Err(Error::RunOpen);
        }
        Ok(g.runs[idx].clone())
    }

    pub fn delete(&self, run_id: &str) -> Result<Record, Error> {
        let mut g = self.lock();
        let idx = index_of(&g.runs, run_id).ok_or(Error::UnknownRun)?;
        let rec = g.runs.remove(idx);
        self.save(g)?;
        Ok(rec)
    }

    /// 거둘 Run: 닫힌 것 전부와, 조정자 도구가 죽은 열린 것.
    pub fn reap_targets(&self, dead: Option<&dyn Fn(&str) -> bool>) -> Vec<Record> {
        let g = self.lock();
        g.runs
            .iter()
            .filter(|r| {
                r.state != OPEN
                    || (!r.coordinator_tool_id.is_empty()
                        && dead.is_some_and(|d| d(&r.coordinator_tool_id)))
            })
            .cloned()
            .collect()
    }

    /// 작업 트리 정리 결과를 기록한다.
    pub fn mark_worktrees(&self, run_id: &str, marks: &[WorktreeMark]) -> Result<(), Error> {
        let mut g = self.lock();
        let idx = index_of(&g.runs, run_id).ok_or(Error::UnknownRun)?;
        let rec = &mut g.runs[idx];
        for mk in marks.iter().filter(|m| !m.path.is_empty()) {
            let apply = |w: &mut Option<Worktree>| {
                if let Some(w) = w.as_mut().filter(|w| w.path == mk.path) {
                    w.removed = mk.removed;
                    w.residue.clone_from(&mk.residue);
                    w.detail.clone_from(&mk.detail);
                }
            };
            apply(&mut rec.worktree);
            for m in &mut rec.members {
                apply(&mut m.worktree);
            }
        }
        self.save(g)
    }

    /// 조정자 도구가 바뀌었다. 옮긴 열린 Run 들을 돌려준다.
    pub fn move_coordinator(&self, from: &str, to: &str) -> Result<Vec<Record>, Error> {
        let mut g = self.lock();
        let mut moved = Vec::new();
        for rec in g
            .runs
            .iter_mut()
            .filter(|r| r.state == OPEN && r.coordinator_tool_id == from)
        {
            rec.coordinator_tool_id = to.to_owned();
            moved.push(rec.clone());
        }
        if moved.is_empty() {
            return Ok(moved);
        }
        self.save(g)?;
        Ok(moved)
    }

    /// 메시지 메타데이터를 남긴다. 발신·수신 중 하나는 그 Run 의 멤버여야 한다.
    pub fn append_message(&self, run_id: &str, mut ev: MsgEvent) -> Result<(), Error> {
        if ev.from.is_empty() || ev.to.is_empty() {
            return Err(Error::invalid(""));
        }
        let mut g = self.lock();
        let idx = index_of(&g.runs, run_id).ok_or(Error::UnknownRun)?;
        if !g.runs[idx].has_member(&ev.from) && !g.runs[idx].has_member(&ev.to) {
            return Err(Error::NotRunParticipant);
        }
        if ev.at == 0 {
            ev.at = self.now();
        }
        let msgs = &mut g.runs[idx].messages;
        msgs.push(ev);
        if msgs.len() > MAX_MESSAGES {
            let cut = msgs.len() - MAX_MESSAGES;
            msgs.drain(..cut);
        }
        self.save(g)
    }

    /// headless 멤버를 탭에 붙인다.
    pub fn attach(&self, member_id: &str, tab_id: &str) -> Result<(Record, Member), Error> {
        if tab_id.is_empty() {
            return Err(Error::invalid(""));
        }
        self.mutate_member(member_id, |m| {
            if !m.tab_id.is_empty() {
                return Err(Error::MemberAttached);
            }
            m.tab_id = tab_id.to_owned();
            m.headless = false;
            Ok(())
        })
    }

    /// 멤버를 탭에서 떼어 headless 로 둔다.
    pub fn detach(&self, member_id: &str) -> Result<(Record, Member), Error> {
        self.mutate_member(member_id, |m| {
            if m.tab_id.is_empty() {
                return Err(Error::MemberNotAttached);
            }
            m.tab_id.clear();
            m.headless = true;
            Ok(())
        })
    }

    fn mutate_member(
        &self,
        member_id: &str,
        f: impl FnOnce(&mut Member) -> Result<(), Error>,
    ) -> Result<(Record, Member), Error> {
        let mut g = self.lock();
        if member_id.is_empty() {
            return Err(Error::UnknownMember);
        }
        let (ri, mi) = index_of_member(&g.runs, member_id).ok_or(Error::UnknownMember)?;
        let mut m = g.runs[ri].members[mi].clone();
        f(&mut m)?;
        g.runs[ri].members[mi] = m.clone();
        let rec = g.runs[ri].clone();
        self.save(g)?;
        Ok((rec, m))
    }
}

fn time_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// 마지막으로 쓴 스냅숏의 Run 들. 스냅숏이 없으면 빈 상태, 해석하지 못하면 지금 것을 둔다.
fn rollback_runs(persisted: &[u8], current: Vec<Record>) -> Vec<Record> {
    if persisted.is_empty() {
        return Vec::new();
    }
    match json::unmarshal::<FileIn>(persisted) {
        Ok(b) => b.runs,
        Err(e) => {
            otter_shared_otterlog::errorf!(
                None,
                "[run] 되돌림 스냅샷 해석 실패 — 메모리를 그대로 둔다: {e}"
            );
            current
        }
    }
}

/// 닫을 수 있는가. 보고하지 않은 멤버를 함께 돌려준다.
pub fn check_close(rec: &Record, force: bool) -> Result<Vec<Member>, (Error, Vec<Member>)> {
    if rec.state != OPEN {
        return Err((Error::RunClosed, Vec::new()));
    }
    let pending: Vec<Member> = rec
        .members
        .iter()
        .filter(|m| !m.settled())
        .cloned()
        .collect();
    if !pending.is_empty() && !force {
        return Err((Error::UnreportedMembers, pending));
    }
    Ok(pending)
}

pub(crate) fn index_of(runs: &[Record], run_id: &str) -> Option<usize> {
    runs.iter().position(|r| r.id == run_id)
}

pub(crate) fn index_of_member(runs: &[Record], member_id: &str) -> Option<(usize, usize)> {
    runs.iter().enumerate().find_map(|(ri, r)| {
        r.members
            .iter()
            .position(|m| m.id == member_id)
            .map(|mi| (ri, mi))
    })
}

/// 열린 Run 에서 그 도구의 멤버 자리.
pub(crate) fn find_by_tool(runs: &[Record], tool_id: &str) -> Option<(usize, usize)> {
    if tool_id.is_empty() {
        return None;
    }
    runs.iter().enumerate().find_map(|(ri, r)| {
        (r.state == OPEN)
            .then(|| r.members.iter().position(|m| m.tool_id == tool_id))
            .flatten()
            .map(|mi| (ri, mi))
    })
}

fn was_member_of_closed_run(runs: &[Record], tool_id: &str) -> bool {
    !tool_id.is_empty()
        && runs
            .iter()
            .filter(|r| r.state != OPEN)
            .any(|r| r.members.iter().any(|m| m.tool_id == tool_id))
}

/// 보고·인수인계의 발신자 멤버. 닫힌 Run 의 멤버였으면 run_closed 다.
pub(crate) fn sender_member(runs: &[Record], tool_id: &str) -> Result<(usize, usize), Error> {
    find_by_tool(runs, tool_id).ok_or_else(|| {
        if was_member_of_closed_run(runs, tool_id) {
            Error::RunClosed
        } else {
            Error::SenderNotMember
        }
    })
}

pub(crate) fn open_tree_runs<'a>(
    runs: &'a [Record],
    tree: &'a str,
) -> impl Iterator<Item = &'a Record> {
    runs.iter()
        .filter(move |r| r.state == OPEN && r.tree == tree)
}

fn check_tree(runs: &[Record], tree: &str, branch: bool) -> Result<(), Error> {
    let mut open = open_tree_runs(runs, tree).peekable();
    if !branch {
        return match open.peek() {
            Some(r) => Err(Error::TreeOpen {
                run_id: r.id.clone(),
            }),
            None => Ok(()),
        };
    }
    if open.any(|r| !r.tree_branch) {
        return Ok(());
    }
    Err(Error::TreeNotOpen)
}

/// id 의 앞 8바이트.
pub fn short(id: &str) -> String {
    if id.len() <= 8 {
        return id.to_owned();
    }
    String::from_utf8_lossy(&id.as_bytes()[..8]).into_owned()
}

/// 경로에 쓰는 짧은 이름: 앞 8바이트 + `-` + 대시를 뺀 뒤 8바이트.
pub fn path_slug(id: &str) -> String {
    let clean = id.replace('-', "");
    if clean.len() < 16 {
        return short(id);
    }
    let tail = String::from_utf8_lossy(&clean.as_bytes()[clean.len() - 8..]).into_owned();
    format!("{}-{tail}", short(id))
}

/// headless 도구 id 들 (runs.json 에서 바로 읽는다).
pub fn headless_tool_ids(dir: &Path) -> HashSet<String> {
    otter_shared_runfile::headless_tool_ids(dir)
}
