//! 메서드별 처리 — 인자를 풀고 ToolManager 를 부르고 응답 한 줄을 만든다.

use std::sync::Arc;
use std::time::Duration;

use dm_gocompat::json::{self, ErrorKind, RawMessage};
use dm_shared_agentrec as agentrec;
use dm_shared_chatwire as chatwire;
use dm_shared_toolhub::{AgentState, ManagerError, Placement};
use dm_shared_toolipc::{self as ipc, PanedErrObj, PanedError, PanedRequest, PanedResponse};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::conn::Conn;
use crate::records::apply_record;

/// 부호화된 응답 한 줄(끝에 개행).
pub(crate) type Line = Vec<u8>;

/// 도구별 입력 줄이 가득 찼다.
pub const ERR_TOOL_QUEUE_FULL: &str = "도구의 입력 줄이 가득 찼다";
/// report 가 서버 연결 없이 왔다.
pub const ERR_NO_SERVER: &str = "연결이 데몬에 실리지 않았다";

#[derive(Serialize)]
struct Empty {}

fn encode<T: Serialize + ?Sized>(v: &T) -> Line {
    json::Encoder::new().encode(v).unwrap_or_default()
}

pub(crate) fn ok<T: Serialize>(id: i64, result: &T) -> Line {
    encode(&PanedResponse { id, result })
}

fn ok_empty(id: i64) -> Line {
    ok(id, &Empty {})
}

pub(crate) fn err_msg(id: i64, code: i64, message: &str) -> Line {
    encode(&PanedError {
        id,
        error: PanedErrObj {
            code,
            message: message.to_owned(),
        },
    })
}

pub(crate) fn queue_full(req: &PanedRequest) -> Line {
    err_msg(req.id, ipc::CODE_SERVER, ERR_TOOL_QUEUE_FULL)
}

/// 인자를 푼다. 실패하면 CODE_INVALID_PARAMS 응답이다 — base64 오류는 "invalid base64" 로 줄인다.
pub(crate) fn decode<T: DeserializeOwned>(req: &PanedRequest) -> Result<T, Line> {
    json::unmarshal(&req.params.0).map_err(|e| {
        let msg = match e.kind() {
            ErrorKind::Type { .. } if e.to_string().contains("illegal base64 data") => {
                "invalid base64".to_owned()
            }
            _ => e.to_string(),
        };
        err_msg(req.id, ipc::CODE_INVALID_PARAMS, &msg)
    })
}

pub(crate) fn tool_of(req: &PanedRequest) -> String {
    decode::<ipc::WriteParams>(req)
        .map(|p| p.id)
        .unwrap_or_default()
}

pub(crate) fn hello(c: &Conn, req: &PanedRequest) -> Line {
    if let Ok(p) = decode::<ipc::HelloParams>(req) {
        let has = |n| ipc::has_feature(&p.features, n);
        c.reports.store(
            has(ipc::FEATURE_REPORTS),
            std::sync::atomic::Ordering::SeqCst,
        );
        c.attention.store(
            has(ipc::FEATURE_ATTENTION),
            std::sync::atomic::Ordering::SeqCst,
        );
        c.edge
            .store(has(ipc::FEATURE_EDGE), std::sync::atomic::Ordering::SeqCst);
        c.chat
            .store(has(ipc::FEATURE_CHAT), std::sync::atomic::Ordering::SeqCst);
    }
    ok(
        req.id,
        &ipc::HelloResult {
            build: c.build.clone(),
            features: ipc::DAEMON_FEATURES
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            version: ipc::PROTOCOL_VERSION,
        },
    )
}

fn manager_code(e: &ManagerError, cap: i64) -> i64 {
    if matches!(e, ManagerError::ToolCap) {
        cap
    } else {
        ipc::CODE_INTERNAL
    }
}

pub(crate) fn create(c: &Arc<Conn>, req: &PanedRequest) -> Line {
    let p: ipc::CreateParams = match decode(req) {
        Ok(p) => p,
        Err(l) => return l,
    };
    let place = Placement {
        window_uuid: p.window,
        profile: p.profile,
        command: p.command,
        work: p.work,
        extra_env: p.extra_env.unwrap_or_default(),
        ..Placement::default()
    };
    let tool = match c.pm.create(&p.cwd, p.cols, p.rows, place) {
        Ok(t) => t,
        Err(e) => {
            return err_msg(req.id, manager_code(&e, ipc::CODE_TOOL_CAP), &e.to_string());
        }
    };
    if let Some(srv) = c.srv.upgrade() {
        srv.wire_tool(&tool);
    }
    ok(
        req.id,
        &ipc::CreateResult {
            cols: p.cols,
            id: tool.id.clone(),
            name: tool.name.clone(),
            pid: i64::from(tool.cmd_process_pid()),
            rows: p.rows,
        },
    )
}

pub(crate) fn restore(c: &Arc<Conn>, req: &PanedRequest) -> Line {
    let p: ipc::RestoreParams = match decode(req) {
        Ok(p) => p,
        Err(l) => return l,
    };
    if let Err(e) = c.pm.restore(&p.id, &p.name, &p.cwd, p.cols, p.rows) {
        return err_msg(req.id, ipc::CODE_INTERNAL, &e.to_string());
    }
    if let (Some(srv), Some(t)) = (c.srv.upgrade(), c.pm.get(&p.id)) {
        srv.wire_tool(&t);
    }
    ok(
        req.id,
        &ipc::RestoreResult {
            cols: p.cols,
            id: p.id,
            rows: p.rows,
        },
    )
}

fn unit<E: std::fmt::Display>(req: &PanedRequest, code: i64, r: Result<(), E>) -> Line {
    match r {
        Ok(()) => ok_empty(req.id),
        Err(e) => err_msg(req.id, code, &e.to_string()),
    }
}

pub(crate) fn kill(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::IdParams>(req) {
        Ok(p) => unit(req, ipc::CODE_SERVER, c.pm.delete(&p.id)),
        Err(l) => l,
    }
}

pub(crate) async fn terminate(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::TerminateParams>(req) {
        Ok(p) => {
            let grace = Duration::from_millis(u64::try_from(p.grace_ms).unwrap_or(0));
            unit(req, ipc::CODE_SERVER, c.pm.terminate(&p.id, grace).await)
        }
        Err(l) => l,
    }
}

pub(crate) fn write(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::WriteParams>(req) {
        Ok(p) => unit(req, ipc::CODE_SERVER, c.pm.write(&p.id, &p.data)),
        Err(l) => l,
    }
}

pub(crate) async fn paste_with(c: &Conn, req: &PanedRequest, p: &ipc::PasteParams) -> Line {
    unit(
        req,
        ipc::CODE_SERVER,
        c.pm.send_paste(&p.id, &p.data, p.submit).await,
    )
}

pub(crate) fn resize(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::ResizeParams>(req) {
        Ok(p) => unit(req, ipc::CODE_SERVER, c.pm.resize(&p.id, p.cols, p.rows)),
        Err(l) => l,
    }
}

/// 응답 없는 입력이다 (FR-OPT-2-2). 실패는 버린다.
pub(crate) fn input(c: &Conn, req: &PanedRequest) {
    if let Ok(p) = decode::<ipc::WriteParams>(req) {
        let _ = c.pm.write(&p.id, &p.data);
    }
}

pub(crate) fn resize_notify(c: &Conn, req: &PanedRequest) {
    if let Ok(p) = decode::<ipc::ResizeParams>(req) {
        let _ = c.pm.resize(&p.id, p.cols, p.rows);
    }
}

pub(crate) fn list(c: &Conn, req: &PanedRequest) -> Line {
    let tools = c.pm.list_cached();
    ok(
        req.id,
        &ipc::ListResult {
            tools: (!tools.is_empty()).then_some(tools),
        },
    )
}

/// since 가 없거나 null 이면 -1(전량 재생)이다 (FR-TRS-3).
#[derive(Default, Deserialize)]
#[serde(default, rename = "toolipc.SnapshotParams")]
struct SnapParams {
    id: String,
    since: Option<i64>,
}

pub(crate) fn snapshot(c: &Conn, req: &PanedRequest) -> Line {
    let p: SnapParams = match decode(req) {
        Ok(p) => p,
        Err(l) => return l,
    };
    if c.pm.get(&p.id).is_none() {
        return err_msg(
            req.id,
            ipc::CODE_NOT_FOUND,
            &ManagerError::NotFound.to_string(),
        );
    }
    let s = c.pm.snapshot_tool_since(&p.id, p.since.unwrap_or(-1));
    ok(
        req.id,
        &ipc::SnapshotResult {
            cols: s.cols,
            data: s.data,
            end: s.end,
            modes: s.modes,
            resumed: s.resumed,
            retained: s.retained,
            rows: s.rows,
            total_bytes_drop: s.total_bytes_drop,
            total_bytes_in: s.total_bytes_in,
        },
    )
}

pub(crate) fn cwd(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::IdParams>(req) {
        Ok(p) => ok(
            req.id,
            &ipc::CwdResult {
                cwd: c.pm.cwd(&p.id),
            },
        ),
        Err(l) => l,
    }
}

pub(crate) fn busy(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::IdParams>(req) {
        Ok(p) => ok(
            req.id,
            &ipc::BusyResult {
                busy: c.pm.busy(&p.id),
            },
        ),
        Err(l) => l,
    }
}

pub(crate) fn busy_many(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::BusyManyParams>(req) {
        Ok(p) => {
            let busy = c.pm.busy_many(&p.ids.unwrap_or_default());
            ok(
                req.id,
                &ipc::BusyManyResult {
                    busy: Some(busy.into_iter().collect()),
                },
            )
        }
        Err(l) => l,
    }
}

pub(crate) fn shell_probe(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::ShellProbeParams>(req) {
        Ok(p) => {
            let pids: Vec<i32> = p
                .pids
                .unwrap_or_default()
                .into_iter()
                .filter_map(|x| i32::try_from(x).ok())
                .collect();
            let state = c.pm.shell_probe(&p.id, &pids).as_str().to_owned();
            ok(req.id, &ipc::ShellProbeResult { state })
        }
        Err(l) => l,
    }
}

pub(crate) fn set_background(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::SetBackgroundParams>(req) {
        Ok(p) => ok(
            req.id,
            &ipc::SetBackgroundResult {
                ok: c.pm.set_background(&p.id, p.background),
            },
        ),
        Err(l) => l,
    }
}

pub(crate) fn background_list(c: &Conn, req: &PanedRequest) -> Line {
    // Go 는 비어도 `[]` 다(목록은 null).
    let bg = c.pm.background_list();
    ok(
        req.id,
        &ipc::BackgroundListResult {
            background: Some(bg),
        },
    )
}

pub(crate) fn record_set(c: &Conn, req: &PanedRequest) -> Line {
    let p: ipc::RecordSetParams = match decode(req) {
        Ok(p) => p,
        Err(l) => return l,
    };
    let Some(srv) = c.srv.upgrade() else {
        return err_msg(
            req.id,
            ipc::CODE_INVALID_PARAMS,
            crate::records::ERR_RECORD_SHAPE,
        );
    };
    match apply_record(&c.pm, &srv.records, &p.kind, &p.tool, &p.value) {
        Ok(()) => ok_empty(req.id),
        Err((code, msg)) => err_msg(req.id, code, &msg),
    }
}

pub(crate) fn records_snapshot(c: &Conn, req: &PanedRequest) -> Line {
    let global = c
        .srv
        .upgrade()
        .map(|s| s.records.snapshot())
        .unwrap_or_default();
    let tools =
        c.pm.snapshot()
            .iter()
            .map(|p| ipc::ToolRecords {
                agent: p.agent_state(),
                records: p.records(),
                tool: p.id.clone(),
            })
            .collect();
    ok(
        req.id,
        &ipc::RecordsResult {
            global,
            tools: Some(tools),
        },
    )
}

pub(crate) fn attn_config(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::AttnConfigParams>(req) {
        Ok(p) => {
            let idle = Duration::from_millis(u64::try_from(p.idle_ms).unwrap_or(0));
            c.pm.set_attention_config(idle, p.allow_bell);
            ok_empty(req.id)
        }
        Err(l) => l,
    }
}

pub(crate) fn attend(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::AttendParams>(req) {
        Ok(p) => {
            if let Some(t) = c.pm.get(&p.tool) {
                if p.typed {
                    t.attend_typed();
                } else {
                    t.attend();
                }
            }
            ok_empty(req.id)
        }
        Err(l) => l,
    }
}

pub(crate) fn report(c: &Arc<Conn>, req: &PanedRequest) -> Line {
    let p: ipc::ReportParams = match decode(req) {
        Ok(p) => p,
        Err(l) => return l,
    };
    if !agentrec::known_method(&p.method) {
        return err_msg(
            req.id,
            ipc::CODE_INVALID_PARAMS,
            dm_shared_handover::OLD_DAEMON_UNKNOWN_METHOD,
        );
    }
    let Some(srv) = c.srv.upgrade() else {
        return err_msg(req.id, ipc::CODE_INVALID_PARAMS, ERR_NO_SERVER);
    };
    match srv.accept_report(Some(c), &p.method, &p.body) {
        Ok(()) => ok_empty(req.id),
        Err(e) => {
            let code = if e.not_found {
                ipc::CODE_NOT_FOUND
            } else {
                ipc::CODE_INVALID_PARAMS
            };
            err_msg(req.id, code, &e.msg)
        }
    }
}

pub(crate) async fn edge_op(c: &Arc<Conn>, req: &PanedRequest) -> Line {
    let p: ipc::EdgeParams = match decode(req) {
        Ok(p) => p,
        Err(l) => return l,
    };
    let node = c.srv.upgrade().and_then(|s| s.edge_node());
    let Some(n) = node else {
        return ok(
            req.id,
            &ipc::EdgeResult {
                status: 503,
                code: dm_shared_edge::CODE_UNAVAILABLE.to_owned(),
                message: "edge layer unavailable".to_owned(),
                ..ipc::EdgeResult::default()
            },
        );
    };
    let r = dm_shared_edgenode::OpRequest {
        op: p.op,
        args: p.args.0,
        if_match: p.if_match,
    };
    let res = n.do_op(r).await;
    ok(
        req.id,
        &ipc::EdgeResult {
            body: RawMessage(res.body),
            code: res.code,
            etag: res.etag,
            message: res.message,
            status: i64::from(res.status.as_u16()),
        },
    )
}

pub(crate) fn edge_port(c: &Conn, req: &PanedRequest) -> Line {
    match decode::<ipc::EdgePortParams>(req) {
        Ok(p) => {
            if let Some(s) = c.srv.upgrade() {
                s.set_edge_port(p.listening, p.addr, p.error);
            }
            ok_empty(req.id)
        }
        Err(l) => l,
    }
}

pub(crate) fn chat_op(c: &Arc<Conn>, req: &PanedRequest) -> Line {
    let p: ipc::ChatParams = match decode(req) {
        Ok(p) => p,
        Err(l) => return l,
    };
    let user = c.srv.upgrade().and_then(|s| s.chat_user());
    let Some(u) = user else {
        return ok(
            req.id,
            &ipc::ChatResult {
                error: Some(chatwire::Error {
                    code: chatwire::CODE_DAEMON_UNAVAILABLE.to_owned(),
                    message: "chat unavailable".to_owned(),
                }),
                ..ipc::ChatResult::default()
            },
        );
    };
    let r = match u.user_call(&p.op, &p.args) {
        Ok(result) => ipc::ChatResult {
            result,
            ..ipc::ChatResult::default()
        },
        Err(e) => ipc::ChatResult {
            error: Some(e),
            ..ipc::ChatResult::default()
        },
    };
    ok(req.id, &r)
}

/// kill·kick 은 데몬이 사람 참가자를 내보내며 기다리므로 읽기 루프 밖에서 돈다.
pub(crate) fn chat_slow(req: &PanedRequest) -> bool {
    decode::<ipc::ChatParams>(req)
        .is_ok_and(|p| p.op == chatwire::OP_KILL || p.op == chatwire::OP_KICK)
}

/// AgentState 를 기록으로 되살린다 (FR-ARD-13).
pub(crate) fn agent_from(v: &RawMessage) -> Result<AgentState, String> {
    json::unmarshal(&v.0).map_err(|e| e.to_string())
}
