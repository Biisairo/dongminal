//! 원격 명령 허브의 HTTP 표면 (Go `commands.go`): `/api/commands`(POST). otterctl 이 POST 하고,
//! 브라우저가 채널의 `cmd` 로 받아 실행한다 (`perf/CHANNEL_PROTOCOL.md` C2a).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use http::{Method, StatusCode};
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::{debugf, infof, warnf};
use otter_shared_pollwait::{self as pollwait, CancellationToken};
use otter_webserver_apierr as apierr;
use otter_webserver_hub::{self as hub, CmdPosition, CmdResult, TabRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Server;
use crate::entity_name::{command_name_answer, reject_command_answer};
use crate::httperr::{fail, fail_read, http_err};
use crate::openurl::{OPEN_URL_ACTION, WHERE_LOCAL, open_url_target};
use crate::req::Req;

/// uuid 를 좌표로 바꾸지 않고 그대로 넘기는 명령이다(이름 바꾸기는 uuid 로 탭을 찾는다).
const UUID_LOCATION_ACTIONS: &[&str] = &["renameTab", "renameWindow"];

/// 도구가 이미 사라진 탭(색인에는 남음)을 uuid 그대로 넘기는 명령이다. 좌표로 바꿀 수 없어도 브라우저는
/// uuid 로 자리를 찾는다 — 그런 탭을 닫을 길이 이것뿐이다(Run 종료 뒤 남은 빈 탭).
const DANGLING_UUID_ACTIONS: &[&str] = &["closeTab"];

/// 생성 명령의 결과를 답하기 전에 새 탭 uuid 가 워크스페이스 색인에 들어오기를 기다리는 상한이다.
/// 브라우저의 저장 충돌 뒤 미룸 상한(`WS_SAVE_BACKOFF_MAX_MS`)과 같다.
pub(crate) const NEW_TAB_INDEX_WAIT: Duration = Duration::from_secs(2);

/// POST /api/commands 의 본문 (Go `commandPostReq`).
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct CommandPostReq {
    pub(crate) action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) args: Option<otter_gocompat::json::RawMessage>,
    #[serde(rename = "reqId", skip_serializing_if = "String::is_empty")]
    pub(crate) req_id: String,
    #[serde(rename = "execClientId", skip_serializing_if = "String::is_empty")]
    pub(crate) exec_client_id: String,
}

/// Go `translateLocationUUID`: `args.location` 의 탭 uuid 를 좌표로 바꾼다. 바꾼 뒤 args 는
/// Go `map[string]any` 를 다시 쓴 것처럼 키 순서가 정렬된다.
pub(crate) fn translate_location_uuid(
    args: &mut Option<otter_gocompat::json::RawMessage>,
    ws: Option<&dyn crate::WorkspaceStore>,
    keep_uuid: bool,
    pass_dangling: bool,
) -> Result<(String, String), String> {
    let (Some(raw), Some(ws)) = (args.as_ref(), ws) else {
        return Ok((String::new(), String::new()));
    };
    if raw.0.is_empty() {
        return Ok((String::new(), String::new()));
    }
    let Ok(mut m) = otter_gocompat::json::unmarshal::<BTreeMap<String, Value>>(&raw.0) else {
        return Ok((String::new(), String::new()));
    };
    let loc = match m.get("location") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Ok((String::new(), String::new())),
    };
    if !ws.is_known_tab_id(&loc) {
        return Err(format!(
            "location 은 list-workspace 의 uuid 만 허용 (좌표/라벨/toolId 거부): {}",
            otter_gocompat::strconv::quote(&loc)
        ));
    }
    let coord = match ws.coordinate_of(&loc) {
        Ok(c) => c,
        Err(_) if pass_dangling => return Ok((loc.clone(), loc)),
        Err(e) => return Err(e.to_string()),
    };
    if keep_uuid {
        return Ok((loc, coord));
    }
    m.insert("location".to_owned(), Value::String(coord.clone()));
    let patched = otter_gocompat::json::marshal(&m).map_err(|e| e.to_string())?;
    *args = Some(otter_gocompat::json::RawMessage(patched));
    Ok((loc, coord))
}

fn command_loc_field(orig: &str, fin: &str) -> String {
    if fin.is_empty() {
        String::new()
    } else if orig != fin {
        format!(" location={fin} uuid={orig}")
    } else {
        format!(" location={fin}")
    }
}

/// POST /api/commands 응답. Go `map[string]interface{}` 라 키가 이름 순이다.
#[derive(Serialize, Default)]
struct CommandResp {
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivered: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// 시간 초과로 끝난 단일 실행자 명령의 지정 실행자다 — 받지 못한 쪽을 알아챌 길 (4.3).
    #[serde(rename = "execClientId", skip_serializing_if = "Option::is_none")]
    exec_client_id: Option<String>,
    location: String,
    #[serde(rename = "newGroups", skip_serializing_if = "Option::is_none")]
    new_groups: Option<Vec<String>>,
    #[serde(rename = "newPanes", skip_serializing_if = "Option::is_none")]
    new_panes: Option<Option<Vec<String>>>,
    #[serde(rename = "newTabs", skip_serializing_if = "Option::is_none")]
    new_tabs: Option<Option<Vec<TabRef>>>,
    #[serde(rename = "newWindows", skip_serializing_if = "Option::is_none")]
    new_windows: Option<Option<Vec<String>>>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<CmdPosition>,
    #[serde(rename = "requestedLocation")]
    requested_location: String,
    #[serde(rename = "timedOut", skip_serializing_if = "Option::is_none")]
    timed_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    r#where: Option<String>,
}

fn not_allowed() -> Response {
    http_err(
        "method not allowed",
        StatusCode::METHOD_NOT_ALLOWED,
        apierr::CODE_NOT_ALLOWED,
    )
}

impl Server {
    /// POST /api/commands.
    pub(crate) async fn handle_command_post(&self, r: &mut Req) -> Response {
        let mut req = match parse_command_post(r).await {
            Ok(q) => q,
            Err(res) => return res,
        };
        let mut open_url_where = String::new();
        if req.action == OPEN_URL_ACTION {
            if let Err(e) = open_url_target(req.args.as_ref().map(|a| a.0.as_slice())) {
                return fail(StatusCode::BAD_REQUEST, &e, None);
            }
            open_url_where = self.open_url_where().0;
        }
        let keep = UUID_LOCATION_ACTIONS.contains(&req.action.as_str());
        let dangling = DANGLING_UUID_ACTIONS.contains(&req.action.as_str());
        let (orig, fin) = match translate_location_uuid(&mut req.args, self.work(), keep, dangling)
        {
            Ok(v) => v,
            Err(e) => return fail(StatusCode::BAD_REQUEST, &e, None),
        };
        let loc_field = command_loc_field(&orig, &fin);
        req.exec_client_id = String::new();
        if hub::is_single_executor_action(&req.action) {
            req.exec_client_id = self.focus.executor();
        }
        let mut resp = CommandResp {
            ok: true,
            action: req.action.clone(),
            location: fin,
            requested_location: orig,
            ..CommandResp::default()
        };
        if !open_url_where.is_empty() {
            resp.r#where = Some(open_url_where.clone());
        }
        if open_url_where == WHERE_LOCAL {
            resp.delivered = Some(0);
            infof!(
                None,
                "[cmd] action={} where=local (뷰어가 서버와 같은 컴퓨터 — 부른 셸이 연다)",
                req.action
            );
            return httpresp::json(StatusCode::OK, &resp);
        }
        self.dispatch_command(req, &mut resp, &loc_field).await;
        httpresp::json(StatusCode::OK, &resp)
    }

    async fn dispatch_command(&self, mut req: CommandPostReq, resp: &mut CommandResp, loc: &str) {
        let Some(cmds) = self.commands() else {
            return;
        };
        if hub::awaits_result(&req.action) {
            req.req_id = hub::new_req_id();
            let payload = otter_gocompat::json::marshal(&req).unwrap_or_default();
            let (res, n, timed_out) = cmds
                .broadcast_and_await(&payload, &req.req_id, hub::command_result_timeout())
                .await;
            if !timed_out && let Some(tabs) = &res.new_tabs {
                self.await_tabs_indexed(&req.action, tabs).await;
            }
            let tabs = res.new_tabs.as_ref().map_or(0, Vec::len);
            put_command_result(resp, res, n, timed_out);
            let mut exec = String::new();
            if timed_out && !req.exec_client_id.is_empty() {
                exec = format!(" execClientId={}", req.exec_client_id);
                resp.exec_client_id = Some(req.exec_client_id.clone());
            }
            infof!(
                None,
                "[cmd] action={}{loc} delivered={n} newTabs={tabs} timedOut={timed_out}{exec}",
                req.action
            );
            return;
        }
        let payload = otter_gocompat::json::marshal(&req).unwrap_or_default();
        let n = cmds.broadcast(&payload);
        resp.delivered = Some(n);
        infof!(
            None,
            "[cmd] action={}{loc} delivered={n} bytes={}",
            req.action,
            payload.len()
        );
        debugf!(
            None,
            "[cmd] action={} payload={}",
            req.action,
            String::from_utf8_lossy(&payload)
        );
    }

    /// 생성 명령의 새 탭 uuid 가 모두 워크스페이스 색인에 들어올 때까지 기다린다 — 브라우저의
    /// 저장(`PUT /api/workspace`)이 echo 보다 늦어도 답을 받은 호출자가 곧바로 그 uuid 를
    /// `location` 으로 쓸 수 있게 한다. 상한을 넘으면 기다림을 접고 기록만 남긴다.
    async fn await_tabs_indexed(&self, action: &str, tabs: &[TabRef]) {
        let Some(ws) = self.work() else {
            return;
        };
        let all_known = || {
            tabs.iter()
                .all(|t| t.uuid.is_empty() || ws.is_known_tab_id(&t.uuid))
        };
        let res = pollwait::on(
            &CancellationToken::new(),
            NEW_TAB_INDEX_WAIT,
            || ws.changes(),
            all_known,
        )
        .await;
        if res.is_err() {
            warnf!(
                None,
                "[cmd] action={action} 새 탭이 {} 안에 워크스페이스에 등록되지 않았다 — 그대로 답한다",
                otter_gocompat::time::format_std_duration(NEW_TAB_INDEX_WAIT)
            );
        }
    }

    /// Go `attachSSELeases`: 채널이 `hello` 로 밝힌 신원이 붙어 있는 동안의 임대(포커스 소유 등)다.
    /// 역순으로 푼다. 채널(`channel/mod.rs`)이 부른다.
    pub(crate) fn attach_channel_leases(
        self: &Arc<Self>,
        cid: &str,
        remote: &str,
        presence: bool,
    ) -> impl FnOnce() + Send + use<> {
        let mut undo: Vec<Box<dyn FnOnce() + Send>> = Vec::new();
        if !cid.is_empty() {
            let ep = self.focus.attach_from(cid, remote);
            let me = Arc::clone(self);
            let cid = cid.to_owned();
            undo.push(Box::new(move || {
                if me.focus.detach(&cid, ep) {
                    me.broadcast_focus_owners();
                }
            }));
        }
        // git 감시 임대는 채널의 `git:<repo>` 토픽 구독이 쥔다 (CHANNEL_PROTOCOL C4).
        // FR-ELR-51: 파일 감시는 이 구독이 붙어 있는 동안만이다. presence 구독은 쥐지 않는다.
        if !cid.is_empty()
            && !presence
            && let Some(w) = &self.fs.watch
        {
            let ep = w.attach(cid);
            let w = w.clone();
            let cid = cid.to_owned();
            undo.push(Box::new(move || w.detach(&cid, ep)));
        }
        move || {
            while let Some(f) = undo.pop() {
                f();
            }
        }
    }
}

async fn parse_command_post(r: &Req) -> Result<CommandPostReq, Response> {
    if r.method != Method::POST {
        return Err(not_allowed());
    }
    let body = r.read_body(0).await.map_err(|e| fail_read(&e))?;
    let req: CommandPostReq = otter_gocompat::json::unmarshal(&body).map_err(|e| {
        let msg = otter_shared_httpreq::message(
            r.rid(),
            r.method.as_str(),
            &r.path,
            "invalid json",
            &otter_shared_httpreq::DecodeError::NotJson(e),
        );
        http_err(&msg, StatusCode::BAD_REQUEST, apierr::CODE_INVALID_JSON)
    })?;
    if !hub::is_allowed_cmd_action(&req.action) {
        return Err(http_err(
            &format!("unknown action: {}", req.action),
            StatusCode::BAD_REQUEST,
            apierr::CODE_UNKNOWN_ACTION,
        ));
    }
    let a = command_name_answer(&req.action, req.args.as_ref().map(|a| a.0.as_slice()));
    if !a.ok {
        return Err(reject_command_answer(&a));
    }
    Ok(req)
}

fn put_command_result(resp: &mut CommandResp, res: CmdResult, n: usize, timed_out: bool) {
    resp.delivered = Some(n);
    resp.new_windows = Some(res.new_windows);
    resp.new_panes = Some(res.new_panes);
    resp.new_tabs = Some(res.new_tabs);
    resp.timed_out = Some(timed_out);
    if res.new_groups.as_ref().is_some_and(|g| !g.is_empty()) {
        resp.new_groups = res.new_groups;
    }
    resp.position = res.position;
    if !res.error.is_empty() {
        resp.error = Some(res.error);
    }
}
