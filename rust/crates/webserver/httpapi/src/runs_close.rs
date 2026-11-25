//! Run 닫기·삭제·자동 수거와 닫기 정리 (Go `handlers_runs_close.go`·`handlers_runs_delete.go`·
//! `handlers_runs_cleanup.go`, RUN_ORCHESTRATION_SRS·UX_REVISION_SRS FR-DEL-*).

use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::Ordering;
use std::time::Duration;

use http::StatusCode;
use otter_shared_agentadapter as agentadapter;
use otter_shared_httpresp::Response;
use otter_shared_otterlog::{errorf, infof};
use otter_shared_pollwait as pollwait;
use otter_shared_runwait as runwait;
use otter_webserver_domain_run::{self as run, Member, Record};
use otter_webserver_domain_worktree::RemoveResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::go_embed::{Obj, raw};
use crate::httperr::{decode_json_body, write_json, write_tool_io_error};
use crate::req::Req;
use crate::runs::{MemberView, Rt, RunFail, write_run_error};
use crate::runs_worktree::worktree_residue;
use crate::tools_api::off_thread;

/// 닫기 정리가 에이전트의 종료를 기다리는 상한과 간격이다 (FR-RCL-*).
const EXIT_SETTLE_TIMEOUT: Duration = runwait::EXIT_SETTLE;
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Go `runCloseReq`.
#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.runCloseReq", rename_all = "camelCase")]
struct RunCloseReq {
    run_id: String,
    force: bool,
    /// 작업 트리를 지우지 않는다 (FR-WKT-8).
    keep_worktrees: bool,
    /// 헤드리스 도구와 멤버 탭을 남긴다 (FR-HLM-5).
    keep_tools: bool,
}

/// 닫기 정리가 닫은 탭 하나 (Go 의 `map[string]any` — 키 순서로 놓는다).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosedTab {
    closed: bool,
    delivered: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    empty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    member_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    tab_id: String,
}

/// 닫기 응답의 정리 대상 하나.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupTarget {
    agent: String,
    live: bool,
    member_id: String,
    role: String,
    tab_id: String,
    tool_id: String,
}

/// Go `closedTabIDs`: 실제로 닫힌 탭만 고른다.
fn closed_tab_ids(closed: &[ClosedTab]) -> HashSet<String> {
    closed
        .iter()
        .filter(|c| c.closed && !c.tab_id.is_empty())
        .map(|c| c.tab_id.clone())
        .collect()
}

/// Go `keepRunRecord`: 치우지 못한 것이 남으면 레코드를 지우지 않는다.
fn keep_run_record(residue: i64, kept_tools: usize) -> bool {
    residue > 0 || kept_tools > 0
}

/// 정리 결과 목록. 대상이 없으면 Go 의 nil 이다.
fn trees_json(trees: &[RemoveResult]) -> otter_gocompat::json::RawMessage {
    if trees.is_empty() {
        return raw(&None::<()>);
    }
    raw(trees)
}

/// Go `exitCommandFor`: 에이전트가 선언한 종료 명령.
fn exit_command_for(agent: &str) -> &'static str {
    agentadapter::get(agent)
        .map(|a| a.exit_command)
        .unwrap_or_default()
}

fn close_tab_args(tab_id: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("location".to_owned(), Value::String(tab_id.to_owned())),
        ("force".to_owned(), Value::Bool(true)),
    ])
}

impl Server {
    /// POST /api/runs/close (FR-RUN-11).
    pub(crate) async fn api_run_close(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: RunCloseReq = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        self.run_sync(r, move |s, _| s.run_close(&st, body)).await
    }

    fn run_close(&self, st: &run::Store, body: RunCloseReq) -> Response {
        let (rec, sweep) = match self.close_or_sweep(st, &body.run_id, body.force) {
            Ok(v) => v,
            Err((e, pending)) => {
                return write_run_error(&RunFail::of(e), self.unreported_extra(&pending));
            }
        };
        let cleanup = self.cleanup_targets(&rec);
        let kept = self.close_headless_tools(&rec, body.keep_tools);
        // 응답을 기다리던 쪽이 떠나도 정리는 끝까지 한다 (Go `context.WithoutCancel`).
        let rt = Rt::background();
        let closed = self.close_run_tabs(&rt, &rec, body.keep_tools);
        self.mark_workspace_run_except(&rec, "", "", &closed_tab_ids(&closed));
        let trees = self.cleanup_worktrees(&rt, &rec, body.keep_worktrees);
        let residue = worktree_residue(&trees);
        infof!(
            None,
            "[run] close id={} members={} force={} sweep={sweep} worktrees={} residue={residue} keepTools={}",
            rec.id,
            rec.members.len(),
            body.force,
            trees.len(),
            body.keep_tools
        );
        let orphans = self.orphan_headless(&rec);
        self.retire_closed_run(st, &rec, residue, kept.len());
        self.kick_run_reap();
        let mut out = Obj::new();
        out.insert("id", raw(&rec.id));
        out.insert("short", raw(&rec.short));
        out.insert("state", raw(&rec.state));
        out.insert("closedAt", raw(&rec.closed_at));
        out.insert("windowId", raw(&rec.window_id));
        out.insert("cleanup", raw(&cleanup));
        out.insert("worktrees", trees_json(&trees));
        out.insert("residue", raw(&residue));
        out.insert("swept", raw(&sweep));
        out.insert("keptTools", raw(&kept));
        out.insert("orphans", raw(&orphans));
        out.insert("closedTabs", raw(&closed));
        write_json(&out)
    }

    /// Go `retireClosedRun`: 남은 것이 없으면 닫은 Run 의 레코드를 지운다.
    fn retire_closed_run(&self, st: &run::Store, rec: &Record, residue: i64, kept_tools: usize) {
        if keep_run_record(residue, kept_tools) {
            infof!(
                None,
                "[run] close 뒤 레코드 보존 id={} residue={residue} keptTools={kept_tools}",
                rec.id
            );
        } else if let Err(e) = st.delete(&rec.id) {
            errorf!(None, "[run] close 뒤 레코드 삭제 실패 id={}: {e}", rec.id);
        } else {
            self.broadcast_run_changed(rec);
        }
    }

    /// Go `unreportedExtra`: 보고하지 않은 멤버를 거절 응답에 싣는다 (FR-PRE-6).
    fn unreported_extra(&self, pending: &[Member]) -> Obj {
        if pending.is_empty() {
            return Obj::new();
        }
        let items: Vec<MemberView> = pending
            .iter()
            .map(|m| self.member_view(m.clone()))
            .collect();
        Obj::from([("unreported", raw(&items))])
    }

    /// Go `cleanupTargets`.
    fn cleanup_targets(&self, rec: &Record) -> Vec<CleanupTarget> {
        rec.members
            .iter()
            .map(|m| CleanupTarget {
                agent: m.agent.clone(),
                live: self.tool_live(&m.tool_id),
                member_id: m.id.clone(),
                role: m.role.clone(),
                tab_id: m.tab_id.clone(),
                tool_id: m.tool_id.clone(),
            })
            .collect()
    }

    /// Go `closeOrSweep`: 이미 끝난 Run 을 강제로 닫으면 남은 것을 쓸어 담는다. 두 번째 값은
    /// 쓸어 담았는가다.
    fn close_or_sweep(
        &self,
        st: &run::Store,
        run_id: &str,
        force: bool,
    ) -> Result<(Record, bool), (run::Error, Vec<Member>)> {
        if force && st.get(run_id).is_some_and(|cur| cur.state != run::OPEN) {
            return st
                .sweep(run_id)
                .map(|r| (r, true))
                .map_err(|e| (e, Vec::new()));
        }
        match st.close(run_id, force) {
            (Ok(rec), _) => Ok((rec, false)),
            (Err(e), pending) => Err((e, pending)),
        }
    }

    /// Go `closeRunTabs`: 살아 있는 멤버의 에이전트를 끝내고 탭을 닫는다 (FR-RCL-*).
    fn close_run_tabs(&self, rt: &Rt, rec: &Record, keep: bool) -> Vec<ClosedTab> {
        let mut out = Vec::new();
        if keep || self.commands().is_none() {
            return out;
        }
        let hub = self.tools(None);
        let mut targets: Vec<&Member> = Vec::new();
        for m in &rec.members {
            if m.tab_id.is_empty() || !self.tool_live(&m.tool_id) {
                continue;
            }
            let cmd = exit_command_for(&m.agent);
            if !cmd.is_empty()
                && self.deps.tool_io.is_some()
                && hub.as_ref().is_some_and(|h| h.busy(&m.tool_id))
                && let Err(e) = self.deliver_to_tool(&m.tool_id, cmd, true)
            {
                errorf!(
                    None,
                    "[run] close 정리: 종료 명령 실패 member={} tool={}: {e}",
                    m.id,
                    m.tool_id
                );
            }
            targets.push(m);
        }
        let ids: Vec<String> = targets.iter().map(|m| m.tool_id.clone()).collect();
        self.wait_tools_idle(rt, &ids);

        let (busy, known) = match &hub {
            Some(h) => match h.busy_many(&ids) {
                Some(b) => (b, true),
                None => (Default::default(), false),
            },
            None => (Default::default(), true),
        };
        for m in targets {
            let exited = known && !busy.get(&m.tool_id).copied().unwrap_or(false);
            let n = self.broadcast_layout("closeTab", Some(&close_tab_args(&m.tab_id)));
            out.push(ClosedTab {
                closed: n > 0,
                delivered: n,
                empty: None,
                exited: Some(exited),
                member_id: Some(m.id.clone()),
                role: Some(m.role.clone()),
                tab_id: m.tab_id.clone(),
            });
        }
        for e in self.empty_run_tabs(rec) {
            let n = self.broadcast_layout("closeTab", Some(&close_tab_args(&e)));
            out.push(ClosedTab {
                closed: n > 0,
                delivered: n,
                empty: Some(true),
                exited: None,
                member_id: None,
                role: None,
                tab_id: e,
            });
        }
        out
    }

    /// Go `waitToolsIdle`: 셸이 에이전트에서 돌아오기를 상한까지 기다린다.
    fn wait_tools_idle(&self, rt: &Rt, ids: &[String]) {
        let Some(hub) = self.tools(None) else {
            return;
        };
        if ids.is_empty() {
            return;
        }
        let res = rt.wait(pollwait::until(
            &rt.ctx,
            EXIT_SETTLE_TIMEOUT,
            EXIT_POLL_INTERVAL,
            || match hub.busy_many(ids) {
                Some(busy) => ids.iter().all(|id| !busy.get(id).copied().unwrap_or(false)),
                None => false,
            },
        ));
        if res == Err(pollwait::WaitError::Timeout) {
            infof!(
                None,
                "[run] close 정리: 종료 대기 상한 초과 — 그대로 닫는다 ({}개)",
                ids.len()
            );
        }
    }

    /// Go `emptyRunTabs`: 전용 창에 남은 멤버가 아닌 탭.
    fn empty_run_tabs(&self, rec: &Record) -> Vec<String> {
        let Some(idx) = &self.deps.work_index else {
            return Vec::new();
        };
        if rec.projection != run::DEDICATED_WINDOW || rec.window_id.is_empty() {
            return Vec::new();
        }
        let member: HashSet<&str> = rec
            .members
            .iter()
            .filter(|m| !m.tab_id.is_empty())
            .map(|m| m.tab_id.as_str())
            .collect();
        idx.entries()
            .into_iter()
            .filter(|e| e.window_uuid == rec.window_id && !e.tab_uuid.is_empty())
            .filter(|e| !member.contains(e.tab_uuid.as_str()))
            .map(|e| e.tab_uuid)
            .collect()
    }

    /// DELETE /api/runs/{id} (FR-DEL-5).
    pub(crate) async fn api_run_delete(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let id = r
            .path
            .strip_prefix("/api/runs/")
            .unwrap_or(&r.path)
            .to_owned();
        if id.is_empty() || id.contains('/') {
            return write_tool_io_error(StatusCode::BAD_REQUEST, "run id 가 없다");
        }
        self.run_sync(r, move |s, rt| {
            let Some(rec) = st.get(&id) else {
                return write_run_error(&RunFail::of(run::Error::UnknownRun), Obj::new());
            };
            let trees = match s.purge_run(st.as_ref(), rt, &rec, "manual", true) {
                Ok(t) => t,
                Err(e) => return write_run_error(&RunFail::of(e), Obj::new()),
            };
            let mut out = Obj::new();
            out.insert("id", raw(&rec.id));
            out.insert("short", raw(&rec.short));
            out.insert("state", raw(&rec.state));
            out.insert("worktrees", trees_json(&trees));
            out.insert("residue", raw(&worktree_residue(&trees)));
            write_json(&out)
        })
        .await
    }

    /// Go `purgeRun`: 표식·헤드리스·트리를 치우고 레코드를 지운다. `force` 가 아니면 잔여가
    /// 있을 때 레코드를 남긴다.
    fn purge_run(
        &self,
        st: &run::Store,
        rt: &Rt,
        rec: &Record,
        why: &str,
        force: bool,
    ) -> Result<Vec<RemoveResult>, run::Error> {
        self.mark_workspace_run(rec, "", ""); // 표식 해제
        self.close_headless_tools(rec, false);
        let trees = self.cleanup_worktrees(rt, rec, false);
        let residue = worktree_residue(&trees);
        if residue > 0 && !force {
            infof!(
                None,
                "[run] 자동 제거 보류 id={} short={} residue={residue} — 잔여 worktree 가 있다",
                rec.id,
                rec.short
            );
            return Ok(trees);
        }
        st.delete(&rec.id)?;
        infof!(
            None,
            "[run] delete id={} short={} state={} why={why} members={} worktrees={} residue={residue}",
            rec.id,
            rec.short,
            rec.state,
            rec.members.len(),
            trees.len()
        );
        self.broadcast_run_changed(rec);
        Ok(trees)
    }

    /// Go `reapRuns`: 조정자가 확인된 죽음이거나 끝난 Run 을 치운다 (FR-ARD-5). 지운 수를 준다.
    pub(crate) fn reap_runs(&self) -> usize {
        let Some(st) = self.runs() else {
            return 0;
        };
        let dead = |id: &str| self.tool_dead(id);
        let targets = st.reap_targets(Some(&dead));
        let rt = Rt::background();
        let mut n = 0;
        for rec in targets {
            let why = if rec.state == run::OPEN {
                "coordinator-gone".to_owned()
            } else {
                format!("ended-{}", rec.state)
            };
            if let Err(e) = self.purge_run(st, &rt, &rec, &why, false) {
                errorf!(None, "[run] 자동 제거 실패 id={}: {e}", rec.id);
                continue;
            }
            if st.get(&rec.id).is_none() {
                n += 1;
            }
        }
        n
    }

    /// Go `StartRunReaper`: 합성 루트가 부른다. 시작할 때 한 번, 그 뒤 [`Server::kick_run_reap`]
    /// 가 깨울 때마다 수거한다 — 주기는 없다 (PERF M4 S7). 저장소가 없으면 아무것도 띄우지 않는다.
    pub fn start_run_reaper(&self, stop: CancellationToken) {
        if self.runs().is_none() {
            return;
        }
        let Some(srv) = self.arc() else {
            return;
        };
        tokio::spawn(async move {
            let s = srv.clone();
            srv.run_aux.reaps.fetch_add(1, Ordering::Relaxed);
            let _ = off_thread(move || s.reap_runs()).await;
            loop {
                tokio::select! {
                    _ = stop.cancelled() => return,
                    _ = srv.run_aux.reap_kick.notified() => {}
                }
                srv.run_aux.reaps.fetch_add(1, Ordering::Relaxed);
                let s = srv.clone();
                let _ = off_thread(move || s.reap_tick()).await;
            }
        });
    }

    /// Run 수거를 깨운다. 도구 종료 push·데몬 재연결·Run 닫기가 부른다 (PERF M4 S7).
    pub fn kick_run_reap(&self) {
        self.run_aux.reap_kick.notify_one();
    }

    /// Go `reapTick`: 레코드 수거와 함께 죽은 도구의 메모리 상태를 치운다 (FR-ARD-2).
    pub(crate) fn reap_tick(&self) {
        self.reap_runs();
        let live = |id: &str| self.tool_not_dead(id);
        self.agents.usage.prune(live);
        self.agents.subagents.prune(live);
        self.agents.sub_acts.prune(live);
    }
}
