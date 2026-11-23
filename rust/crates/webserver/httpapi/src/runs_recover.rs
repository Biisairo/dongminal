//! Run 복구 — 끊긴 에이전트 세션을 빈 셸에 재개줄로 되살린다 (Go `handlers_runs_recover.go`,
//! RUN_RECOVERY_SRS).
//!
//! 판정은 두 단계다. 기록만 보는 정적 판정(`recover_static`)은 목록의 버튼 근거이고, 셸을 보는
//! 동적 판정(`recover_dynamic`)은 실제로 넣기 직전에만 한다 (FR-RRC-26).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dm_shared_agentadapter::{self as agentadapter, Adapter};
use dm_shared_dmlog::infof;
use dm_shared_httpresp::Response;
use dm_shared_toolhub::ShellState;
use dm_webserver_domain_run::{self as run, Member, Record};
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::go_embed::{Obj, raw};
use crate::httperr::{decode_json_body, write_json};
use crate::req::Req;
use crate::runs::{RunFail, extra1, settled_state, write_run_error};
use crate::status::Liveness;

const REASON_ENDED: &str = "ended";
const REASON_NO_TOOL: &str = "no-tool";
const REASON_NO_AGENT: &str = "no-agent";
const REASON_NO_RESUME: &str = "no-resume";
const REASON_NO_SESSION: &str = "no-session";
const REASON_BAD_SESSION: &str = "bad-session";
const REASON_RECOVERING: &str = "recovering";
const REASON_UNKNOWN: &str = "unknown";
const REASON_RUNNING_HERE: &str = "running-here";
const REASON_RUNNING_ELSEWHERE: &str = "running-elsewhere";
const REASON_BUSY: &str = "busy";

const RECOVER_RESUMED: &str = "resumed";
const RECOVER_SKIPPED: &str = "skipped";
const RECOVER_FAILED: &str = "failed";

const RECOVER_COORDINATOR: &str = "coordinator";
const RECOVER_MEMBER: &str = "member";

/// 재개줄을 막 넣은 도구를 다시 건드리지 않는 시간이다 (FR-RRC-18).
const RECOVER_HOLD: Duration = Duration::from_secs(15);

/// 셸 판정을 바꿔 끼우는 자리다 — 시험만 채운다.
pub(crate) type RecoverProbe = Box<dyn Fn(&str, Option<&[i64]>) -> ShellState + Send + Sync>;
/// 설정 폴더 목록을 바꿔 끼우는 자리다 — 시험만 채운다.
pub(crate) type RecoverDirs = Box<dyn Fn() -> Vec<PathBuf> + Send + Sync>;

/// Go `runAux`: Run 표면의 서버 쪽 보조 상태.
#[derive(Default)]
pub(crate) struct RunAux {
    pub(crate) recover_probe: Option<RecoverProbe>,
    pub(crate) recover_dirs: Option<RecoverDirs>,
    recover_held: RecoverHolds,
    /// 이미 보낸 컨텍스트 통지 (FR-CBG-7). 서버 수명이다.
    pub(crate) context_notices: ContextNoticeLog,
}

/// Go `recoverHolds`.
#[derive(Default)]
struct RecoverHolds {
    at: Mutex<HashMap<String, Instant>>,
}

impl RecoverHolds {
    fn take(&self, tool_id: &str, now: Instant) -> bool {
        let mut at = self.at.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = at.get(tool_id)
            && now.duration_since(*t) < RECOVER_HOLD
        {
            return false;
        }
        at.insert(tool_id.to_owned(), now);
        true
    }

    fn release(&self, tool_id: &str) {
        self.at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(tool_id);
    }
}

/// Go `contextNoticeLog`: 멤버·등급마다 통지는 한 번이다.
#[derive(Default)]
pub(crate) struct ContextNoticeLog {
    sent: Mutex<std::collections::HashSet<String>>,
}

impl ContextNoticeLog {
    pub(crate) fn claim(&self, member_id: &str, level: &str) -> bool {
        self.sent
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(format!("{member_id}/{level}"))
    }
}

/// Go `recoverTarget`.
#[derive(Clone, Default)]
pub(crate) struct RecoverTarget {
    coord: bool,
    member_id: String,
    tool_id: String,
    agent: String,
    session_id: String,
    ended: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoverResult {
    target: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    member_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    tool_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    agent: String,
    outcome: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    reason: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    needs_force: bool,
}

fn run_wide_targets(rec: &Record) -> Vec<RecoverTarget> {
    let mut out = Vec::new();
    if !rec.coordinator_tool_id.is_empty() {
        out.push(coord_target(rec));
    }
    out.extend(rec.members.iter().map(member_target));
    out
}

/// Go `coordTarget`.
pub(crate) fn coord_target(rec: &Record) -> RecoverTarget {
    RecoverTarget {
        coord: true,
        tool_id: rec.coordinator_tool_id.clone(),
        agent: rec.coordinator_agent.clone(),
        session_id: rec
            .coordinator
            .as_ref()
            .map(|c| c.session_id.clone())
            .unwrap_or_default(),
        ..RecoverTarget::default()
    }
}

/// Go `memberTarget`: 보고했거나 끝난 상태의 멤버는 되살리지 않는다.
pub(crate) fn member_target(m: &Member) -> RecoverTarget {
    RecoverTarget {
        member_id: m.id.clone(),
        tool_id: m.tool_id.clone(),
        agent: m.agent.clone(),
        session_id: m.context.session_id.clone(),
        ended: m.reported() || settled_state(&m.state),
        ..RecoverTarget::default()
    }
}

/// Go `recoverStatic`: 기록만으로 내릴 수 있는 판정. 되살릴 수 있으면 어댑터를 준다.
fn recover_static(t: &RecoverTarget, live: bool) -> Result<&'static Adapter, &'static str> {
    if t.ended {
        return Err(REASON_ENDED);
    }
    if t.tool_id.is_empty() || !live {
        return Err(REASON_NO_TOOL);
    }
    if t.agent.is_empty() {
        return Err(REASON_NO_AGENT);
    }
    let ad = match agentadapter::get(&t.agent) {
        Ok(ad) if ad.can_resume() => ad,
        _ => return Err(REASON_NO_RESUME),
    };
    if t.session_id.is_empty() {
        return Err(REASON_NO_SESSION);
    }
    if !agentadapter::valid_session_id(&t.session_id) {
        return Err(REASON_BAD_SESSION);
    }
    Ok(ad)
}

/// Go `recoverDynamic`: 모르면 강제 없이는 넣지 않는다 (FR-RRC-12).
fn recover_dynamic(reg_ok: bool, shell: ShellState, force: bool) -> (&'static str, bool) {
    if !force && (!reg_ok || shell == ShellState::Unknown) {
        return (REASON_UNKNOWN, true);
    }
    match shell {
        ShellState::Here => (REASON_RUNNING_HERE, false),
        ShellState::Elsewhere => (REASON_RUNNING_ELSEWHERE, false),
        ShellState::Busy => (REASON_BUSY, false),
        _ => ("", false),
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RecoverBody {
    run_id: String,
    member_id: String,
    coordinator: bool,
    force: bool,
}

impl Server {
    /// Go `recoverable`: 복구 버튼의 근거 (FR-RRC-26). 생존을 모르면 살아 있는 쪽으로 읽는다.
    pub(crate) fn recoverable(&self, t: &RecoverTarget) -> bool {
        if t.tool_id.is_empty() {
            return false;
        }
        recover_static(t, self.tool_liveness(&t.tool_id) != Liveness::Dead).is_ok()
    }

    fn shell_state(&self, tool_id: &str, pids: Option<&[i64]>) -> ShellState {
        if let Some(p) = &self.run_aux.recover_probe {
            return p(tool_id, pids);
        }
        match self.tools(None) {
            Some(h) => h.shell_probe(tool_id, pids),
            None => ShellState::Unknown,
        }
    }

    /// Go `agentConfigDirs`. 계정 서비스(`s.ca`)의 목록은 5.5.9 가 잇는다.
    fn agent_config_dirs(&self) -> Vec<PathBuf> {
        if let Some(d) = &self.run_aux.recover_dirs {
            return d();
        }
        match std::env::home_dir().filter(|h| !h.as_os_str().is_empty()) {
            Some(home) => {
                vec![dm_webserver_domain_claudeacct::ClaudePaths::default_for(&home).config_home]
            }
            None => Vec::new(),
        }
    }

    fn recover_one(
        &self,
        t: &RecoverTarget,
        dirs: &[PathBuf],
        force: bool,
        single: bool,
    ) -> RecoverResult {
        let mut out = RecoverResult {
            target: if t.coord {
                RECOVER_COORDINATOR
            } else {
                RECOVER_MEMBER
            },
            member_id: t.member_id.clone(),
            tool_id: t.tool_id.clone(),
            agent: t.agent.clone(),
            outcome: RECOVER_SKIPPED,
            reason: String::new(),
            needs_force: false,
        };
        let live = !t.tool_id.is_empty() && self.tool_liveness(&t.tool_id) != Liveness::Dead;
        let ad = match recover_static(t, live) {
            Ok(ad) => ad,
            Err(why) => {
                out.reason = why.to_owned();
                return out;
            }
        };
        if !self.run_aux.recover_held.take(&t.tool_id, Instant::now()) {
            out.reason = REASON_RECOVERING.to_owned();
            return out;
        }
        let (pids, reg_ok) = match ad.session_pids {
            Some(f) => match f(&t.session_id, dirs) {
                Some(p) => (Some(p), true),
                None => (None, false),
            },
            None => (None, true),
        };
        let (why, needs_force) =
            recover_dynamic(reg_ok, self.shell_state(&t.tool_id, pids.as_deref()), force);
        if !why.is_empty() {
            self.run_aux.recover_held.release(&t.tool_id);
            out.reason = why.to_owned();
            out.needs_force = needs_force && single;
            return out;
        }
        let hooks = if self.cfg.data_dir.as_os_str().is_empty() {
            String::new()
        } else {
            dm_shared_dmenv::agent_hooks_dir_in(&self.cfg.data_dir.join(dm_shared_dmenv::BIN_DIR))
                .to_string_lossy()
                .into_owned()
        };
        let res = ad
            .resume_line(&hooks, &t.session_id, !t.coord)
            .map_err(|e| e.to_string())
            .and_then(|line| self.deliver_to_tool(&t.tool_id, &line, true));
        if let Err(e) = res {
            self.run_aux.recover_held.release(&t.tool_id);
            out.outcome = RECOVER_FAILED;
            out.reason = e;
            return out;
        }
        out.outcome = RECOVER_RESUMED;
        out
    }

    /// POST /api/runs/recover (FR-RRC-20).
    pub(crate) async fn api_run_recover(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: RecoverBody = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        self.run_sync(r, move |s, _| {
            let single = !body.member_id.is_empty() || body.coordinator;
            if (!body.member_id.is_empty() && body.coordinator) || (body.force && !single) {
                return write_run_error(
                    &RunFail::of(run::Error::InvalidArgument(String::new())),
                    extra1("runId", &body.run_id),
                );
            }
            let Some(rec) = st.get(&body.run_id) else {
                return write_run_error(
                    &RunFail::of(run::Error::UnknownRun),
                    extra1("runId", &body.run_id),
                );
            };
            if rec.state != run::OPEN {
                return write_run_error(
                    &RunFail::of(run::Error::RunClosed),
                    extra1("runId", &body.run_id),
                );
            }
            let targets = if body.coordinator {
                vec![coord_target(&rec)]
            } else if !body.member_id.is_empty() {
                match rec.members.iter().rfind(|m| m.id == body.member_id) {
                    Some(m) => vec![member_target(m)],
                    None => {
                        return write_run_error(
                            &RunFail::of(run::Error::UnknownMember),
                            extra1("memberId", &body.member_id),
                        );
                    }
                }
            } else {
                run_wide_targets(&rec)
            };
            let dirs = s.agent_config_dirs();
            let mut results = Vec::with_capacity(targets.len());
            let mut resumed = 0;
            for t in &targets {
                let res = s.recover_one(t, &dirs, body.force, single);
                if res.outcome == RECOVER_RESUMED {
                    resumed += 1;
                }
                infof!(
                    None,
                    "[runs] recover run={} target={} member={} tool={} outcome={} reason={}",
                    rec.id,
                    res.target,
                    res.member_id,
                    res.tool_id,
                    res.outcome,
                    res.reason
                );
                results.push(res);
            }
            if resumed > 0 {
                s.broadcast_run_changed(&rec);
            }
            let mut out = Obj::new();
            out.insert("runId", raw(&rec.id));
            out.insert("results", raw(&results));
            write_json(&out)
        })
        .await
    }
}
