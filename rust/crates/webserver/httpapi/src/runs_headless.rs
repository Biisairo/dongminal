//! 묶음 H — 헤드리스 멤버와 탭 부착·분리 (Go `handlers_runs_headless.go`, RUN_HEADLESS_SRS).
//!
//! 헤드리스 도구는 탭 없이 도는 도구다. 부착·분리는 브라우저가 탭을 만들고 지워야 끝나므로
//! 방송 뒤 workspace 반영을 기다린다 (FR-HLM-3·4).

use std::collections::BTreeMap;
use std::time::Duration;

use dm_shared_dmlog::{errorf, infof};
use dm_shared_httpresp::Response;
use dm_shared_pollwait as pollwait;
use dm_shared_toolhub::{DEFAULT_COLS, DEFAULT_ROWS, Placement};
use dm_webserver_domain_run::{self as run, Record};
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::Server;
use crate::go_embed::{Obj, raw};
use crate::httperr::{decode_json_body, write_json, write_tool_io_error};
use crate::req::Req;
use crate::runs::{Rt, RunFail, extra1, member_detach_answer, write_run_error};
use crate::tools_api::off_thread;

/// 헤드리스 도구의 화면 크기다 — 그리는 쪽이 없으므로 기본값을 쓴다.
const HEADLESS_COLS: u16 = DEFAULT_COLS;
const HEADLESS_ROWS: u16 = DEFAULT_ROWS;

/// 부착·분리를 브라우저가 반영하기를 기다리는 상한이다.
const ATTACH_SETTLE_TIMEOUT: Duration = Duration::from_secs(3);

fn is_false(b: &bool) -> bool {
    !*b
}

/// 헤드리스 도구 하나의 참조다. 닫기의 보존 목록과 끝난 Run 의 고아 목록이 쓴다 (FR-HLM-5).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HeadlessRef {
    #[serde(skip_serializing_if = "is_false")]
    kept: bool,
    member_id: String,
    role: String,
    tool_id: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct HeadlessBody {
    cwd: String,
    /// 셸 대신 띄울 명령. 로그에는 길이와 해시만 남긴다.
    command: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct AttachBody {
    member_id: String,
    location: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct DetachBody {
    member_id: String,
}

/// Go `redactCmdForLog`: 명령 본문은 비밀을 담을 수 있다.
fn redact_cmd_for_log(command: &str) -> String {
    if command.is_empty() {
        return "none".to_owned();
    }
    let sum = hex::encode(Sha256::digest(command.as_bytes()));
    format!("len:{} sha256:{}", command.len(), &sum[..12])
}

fn args1(k: &str, v: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([(k.to_owned(), Value::String(v.to_owned()))])
}

impl Server {
    /// POST /api/tools/headless (FR-HLM-1).
    pub(crate) async fn api_tools_headless(&self, r: &mut Req) -> Response {
        if self.deps.tools.is_none() {
            return write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "tool hub unavailable");
        }
        let body: HeadlessBody = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        let Some(srv) = self.arc() else {
            return write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "server gone");
        };
        let (cwd, command) = (body.cwd.clone(), body.command.clone());
        let created = off_thread(move || srv.create_headless_tool(&cwd, &command)).await;
        let tool_id = match created {
            Some(Ok(id)) => id,
            Some(Err(e)) => return write_tool_io_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            None => return write_tool_io_error(StatusCode::SERVICE_UNAVAILABLE, "server gone"),
        };
        let mut out = Obj::new();
        out.insert("toolId", raw(&tool_id));
        out.insert("cwd", raw(&body.cwd));
        out.insert("command", raw(&body.command));
        out.insert("cols", raw(&HEADLESS_COLS));
        out.insert("rows", raw(&HEADLESS_ROWS));
        out.insert("headless", raw(&true));
        write_json(&out)
    }

    /// Go `createHeadlessTool`: 배경 도구로 만든다 — 탭이 없다.
    pub(crate) fn create_headless_tool(&self, cwd: &str, command: &str) -> Result<String, String> {
        let Some(hub) = self.tools(None) else {
            return Err("tool hub unavailable".to_owned());
        };
        let place = Placement {
            command: command.to_owned(),
            ..Placement::default()
        };
        let tool = hub
            .create(cwd, HEADLESS_COLS, HEADLESS_ROWS, &place)
            .map_err(|e| e.to_string())?;
        hub.set_background(&tool.id, true);
        infof!(
            None,
            "[run] headless tool={} cwd={cwd} cmd={} {HEADLESS_COLS}x{HEADLESS_ROWS}",
            tool.id,
            redact_cmd_for_log(command)
        );
        self.broadcast_layout("tools_background_changed", None);
        Ok(tool.id)
    }

    /// POST /api/runs/attach (FR-HLM-3): 헤드리스 멤버를 탭에 붙인다.
    pub(crate) async fn api_run_attach(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: AttachBody = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        self.run_sync(r, move |s, rt| {
            let (_, m) = match s.run_member(&st, &body.member_id) {
                Ok(v) => v,
                Err(res) => return res,
            };
            if !m.tab_id.is_empty() {
                let mut extra = extra1("memberId", &m.id);
                extra.insert("tabId", raw(&m.tab_id));
                return write_run_error(&RunFail::of(run::Error::MemberAttached), extra);
            }
            if !s.tool_live(&m.tool_id) {
                return write_tool_io_error(
                    StatusCode::NOT_FOUND,
                    &format!("멤버의 도구가 살아 있지 않다: {}", m.tool_id),
                );
            }
            let mut args = args1("toolId", &m.tool_id);
            if !body.location.is_empty() {
                args.insert("location".to_owned(), Value::String(body.location.clone()));
            }
            if s.broadcast_layout("restoreTool", Some(&args)) == 0 {
                return write_tool_io_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "구독 중인 브라우저가 없다 — 부착은 화면이 있어야 한다",
                );
            }
            let tab_id = s.await_tab(rt, &m.tool_id, true);
            if tab_id.is_empty() {
                return write_tool_io_error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "브라우저가 탭 생성을 반영하지 않았다 — 잠시 후 다시 시도한다",
                );
            }
            // 복원이 재결속(reconcile)과 겹치면 이미 같은 탭이 기록돼 있다 — 그것은 성공이다.
            let res = match st.attach(&m.id, &tab_id) {
                Err(run::Error::MemberAttached) => match st.find_member(&m.id) {
                    Some((cur, got)) if got.tab_id == tab_id => Ok((cur, got)),
                    _ => Err(run::Error::MemberAttached),
                },
                other => other,
            };
            let (rec, updated) = match res {
                Ok(v) => v,
                Err(e) => return write_run_error(&RunFail::of(e), extra1("memberId", &m.id)),
            };
            s.mark_workspace_run(&rec, &tab_id, &rec.id);
            infof!(
                None,
                "[run] attach run={} member={} tool={} tab={tab_id}",
                rec.id,
                updated.id,
                updated.tool_id
            );
            write_json(&s.member_view(updated))
        })
        .await
    }

    /// POST /api/runs/detach (FR-HLM-4): 탭을 닫고 도구는 배경으로 남긴다.
    pub(crate) async fn api_run_detach(&self, r: &mut Req) -> Response {
        let st = match self.runs_ready() {
            Ok(st) => st,
            Err(res) => return res,
        };
        let body: DetachBody = match decode_json_body(r, 0).await {
            Ok(b) => b,
            Err(res) => return res,
        };
        self.run_sync(r, move |s, rt| {
            let (_, m) = match s.run_member(&st, &body.member_id) {
                Ok(v) => v,
                Err(res) => return res,
            };
            if !member_detach_answer(&m).ok {
                return write_run_error(
                    &RunFail::of(run::Error::MemberNotAttached),
                    extra1("memberId", &m.id),
                );
            }
            if s.broadcast_layout("detachTab", Some(&args1("toolId", &m.tool_id))) == 0 {
                return write_tool_io_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "구독 중인 브라우저가 없다 — 분리는 화면이 있어야 한다",
                );
            }
            if !s.await_tab(rt, &m.tool_id, false).is_empty() {
                return write_tool_io_error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "브라우저가 탭 닫기를 반영하지 않았다 — 잠시 후 다시 시도한다",
                );
            }
            let (rec, updated) = match st.detach(&m.id) {
                Ok(v) => v,
                Err(e) => return write_run_error(&RunFail::of(e), extra1("memberId", &m.id)),
            };
            infof!(
                None,
                "[run] detach run={} member={} tool={}",
                rec.id,
                updated.id,
                updated.tool_id
            );
            write_json(&s.member_view(updated))
        })
        .await
    }

    /// Go `awaitTab`: 도구의 탭이 생기거나(`want`) 사라지기를 기다린다. 끝의 탭 uuid 를 준다.
    fn await_tab(&self, rt: &Rt, tool_id: &str, want: bool) -> String {
        let Some(idx) = &self.deps.work_index else {
            return String::new();
        };
        let mut tab_id = String::new();
        // 시한·취소는 결말이 아니다 — 마지막으로 본 탭이 답이다.
        let _ = rt.wait(pollwait::on(
            &rt.ctx,
            ATTACH_SETTLE_TIMEOUT,
            || idx.changes(),
            || {
                tab_id = self.tab_id_of_tool(tool_id);
                tab_id.is_empty() != want
            },
        ));
        tab_id
    }

    /// Go `closeHeadlessTools`: 살아 있는 헤드리스 도구를 닫는다. `keep` 이면 남기고 목록만 낸다.
    pub(crate) fn close_headless_tools(&self, rec: &Record, keep: bool) -> Vec<HeadlessRef> {
        let mut out = Vec::new();
        for m in &rec.members {
            if !m.headless_tool() || !self.tool_live(&m.tool_id) {
                continue;
            }
            if keep {
                out.push(HeadlessRef {
                    kept: true,
                    member_id: m.id.clone(),
                    role: m.role.clone(),
                    tool_id: m.tool_id.clone(),
                });
                continue;
            }
            if let Some(hub) = self.tools(None) {
                // 이미 없으면 닫을 것이 없다 — 오류를 명시로 무시한다.
                let _ = hub.delete(&m.tool_id);
            }
            infof!(
                None,
                "[run] headless close run={} member={} tool={}",
                rec.id,
                m.id,
                m.tool_id
            );
        }
        out
    }

    /// Go `orphanHeadless`: 끝난 Run 에 남은 살아 있는 헤드리스 도구 (FR-HLM-5). 없으면 `None`.
    pub(crate) fn orphan_headless(&self, rec: &Record) -> Option<Vec<HeadlessRef>> {
        if rec.state == run::OPEN {
            return None;
        }
        let out: Vec<HeadlessRef> = rec
            .members
            .iter()
            .filter(|m| m.headless_tool() && self.tool_live(&m.tool_id))
            .map(|m| HeadlessRef {
                kept: false,
                member_id: m.id.clone(),
                role: m.role.clone(),
                tool_id: m.tool_id.clone(),
            })
            .collect();
        (!out.is_empty()).then_some(out)
    }

    /// Go `reconcileMemberTab`: 배경에서 돌아온 멤버 도구의 새 탭을 기록에 잇는다 (FR-HLM-8).
    pub(crate) fn reconcile_member_tab(&self, tool_id: &str) {
        let Some(st) = self.runs() else {
            return;
        };
        let Some(m) = st.member_by_tool(tool_id) else {
            return;
        };
        if !m.tab_id.is_empty() {
            return;
        }
        let Some(srv) = self.arc() else {
            return;
        };
        let tool_id = tool_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let rt = Rt::background();
            let tab_id = srv.await_tab(&rt, &tool_id, true);
            if tab_id.is_empty() {
                return;
            }
            let Some(st) = srv.runs() else {
                return;
            };
            match st.attach(&m.id, &tab_id) {
                Ok((rec, updated)) => {
                    srv.mark_workspace_run(&rec, &tab_id, &rec.id);
                    infof!(
                        None,
                        "[run] 탭 결속 반영 run={} member={} tool={tool_id} tab={tab_id}",
                        rec.id,
                        updated.id
                    );
                }
                Err(run::Error::MemberAttached) => {}
                Err(e) => errorf!(None, "[run] 탭 결속 기록 실패 member={}: {e}", m.id),
            }
        });
    }
}
