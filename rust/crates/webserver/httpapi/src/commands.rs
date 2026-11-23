//! 원격 명령 허브의 HTTP 표면 (Go `commands.go`): `/api/commands`(POST)·`/api/commands/sse`·
//! `/api/command-result`. dmctl 이 POST 하고, 브라우저가 SSE 로 받아 실행한다.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use dm_shared_dmlog::{debugf, infof};
use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_apierr as apierr;
use dm_webserver_hub::{self as hub, CmdPosition, CmdResult, TabRef};
use http::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Server;
use crate::entity_name::{command_name_answer, reject_command_answer};
use crate::httperr::{BodyRead, fail, fail_read, http_err, read_body_http};
use crate::openurl::{OPEN_URL_ACTION, WHERE_LOCAL, open_url_target};
use crate::req::Req;

/// SSE 인사의 주기다 (FR-RLC-20a).
pub(crate) const SSE_HELLO_EVERY: Duration = Duration::from_secs(15);

/// uuid 를 좌표로 바꾸지 않고 그대로 넘기는 명령이다(이름 바꾸기는 uuid 로 탭을 찾는다).
const UUID_LOCATION_ACTIONS: &[&str] = &["renameTab", "renameWindow"];

/// POST /api/commands 의 본문 (Go `commandPostReq`).
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct CommandPostReq {
    pub(crate) action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) args: Option<dm_gocompat::json::RawMessage>,
    #[serde(rename = "reqId", skip_serializing_if = "String::is_empty")]
    pub(crate) req_id: String,
    #[serde(rename = "execClientId", skip_serializing_if = "String::is_empty")]
    pub(crate) exec_client_id: String,
}

/// Go `translateLocationUUID`: `args.location` 의 탭 uuid 를 좌표로 바꾼다. 바꾼 뒤 args 는
/// Go `map[string]any` 를 다시 쓴 것처럼 키 순서가 정렬된다.
pub(crate) fn translate_location_uuid(
    args: &mut Option<dm_gocompat::json::RawMessage>,
    ws: Option<&dyn crate::WorkspaceStore>,
    keep_uuid: bool,
) -> Result<(String, String), String> {
    let (Some(raw), Some(ws)) = (args.as_ref(), ws) else {
        return Ok((String::new(), String::new()));
    };
    if raw.0.is_empty() {
        return Ok((String::new(), String::new()));
    }
    let Ok(mut m) = dm_gocompat::json::unmarshal::<BTreeMap<String, Value>>(&raw.0) else {
        return Ok((String::new(), String::new()));
    };
    let loc = match m.get("location") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Ok((String::new(), String::new())),
    };
    if !ws.is_known_tab_id(&loc) {
        return Err(format!(
            "location 은 list-workspace 의 uuid 만 허용 (좌표/라벨/toolId 거부): {}",
            dm_gocompat::strconv::quote(&loc)
        ));
    }
    let coord = ws.coordinate_of(&loc).map_err(|e| e.to_string())?;
    if keep_uuid {
        return Ok((loc, coord));
    }
    m.insert("location".to_owned(), Value::String(coord.clone()));
    let patched = dm_gocompat::json::marshal(&m).map_err(|e| e.to_string())?;
    *args = Some(dm_gocompat::json::RawMessage(patched));
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

/// POST /api/command-result 의 본문.
#[derive(Deserialize, Default)]
#[serde(default)]
struct CommandResultBody {
    #[serde(rename = "reqId")]
    req_id: String,
    #[serde(rename = "newWindows")]
    new_windows: Option<Vec<String>>,
    #[serde(rename = "newPanes")]
    new_panes: Option<Vec<String>>,
    #[serde(rename = "newTabs")]
    new_tabs: Option<Vec<TabRef>>,
    #[serde(rename = "newGroups")]
    new_groups: Option<Vec<String>>,
    position: Option<CmdPosition>,
    error: String,
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
        let (orig, fin) = match translate_location_uuid(&mut req.args, self.work(), keep) {
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
            let payload = dm_gocompat::json::marshal(&req).unwrap_or_default();
            let (res, n, timed_out) = cmds
                .broadcast_and_await(&payload, &req.req_id, hub::command_result_timeout())
                .await;
            let tabs = res.new_tabs.as_ref().map_or(0, Vec::len);
            put_command_result(resp, res, n, timed_out);
            infof!(
                None,
                "[cmd] action={}{loc} delivered={n} newTabs={tabs} timedOut={timed_out}",
                req.action
            );
            return;
        }
        let payload = dm_gocompat::json::marshal(&req).unwrap_or_default();
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

    /// POST /api/command-result: 브라우저가 생성 명령의 결과를 돌려준다.
    pub(crate) async fn handle_command_result(&self, r: &mut Req) -> Response {
        if r.method != Method::POST {
            return not_allowed();
        }
        let body: CommandResultBody = match read_body_http(r).await {
            BodyRead::Ok(b) => b,
            BodyRead::Answered(res) => return res,
            BodyRead::NotJson => {
                return http_err(
                    "invalid json",
                    StatusCode::BAD_REQUEST,
                    apierr::CODE_INVALID_JSON,
                );
            }
        };
        if !body.req_id.is_empty()
            && let Some(c) = self.commands()
        {
            c.deliver_result(
                &body.req_id,
                CmdResult {
                    new_windows: body.new_windows,
                    new_panes: body.new_panes,
                    new_tabs: body.new_tabs,
                    new_groups: body.new_groups,
                    position: body.position,
                    error: body.error,
                },
            );
        }
        http::Response::new(httpresp::empty())
    }

    /// GET /api/commands/sse: 명령 방송을 받는다. `?presence=1` 은 방송 없이 자리만 지킨다.
    pub(crate) async fn handle_command_sse(&self, r: &mut Req) -> Response {
        let q = r.query();
        let presence = q.get_or_empty("presence") == "1";
        let cid = q.get_or_empty("clientId");
        let (res, mut st) = dm_webserver_sse::start(dm_webserver_sse::WRITE_TIMEOUT);
        let sub = if presence {
            if self.conn.presence_subs.fetch_add(1, SEQ) + 1 > hub::SUB_CAP as i64 {
                self.conn.presence_subs.fetch_sub(1, SEQ);
                reject_sub(st);
                return res;
            }
            None
        } else {
            match self.commands().and_then(|c| c.add()) {
                Some(s) => Some(s),
                None => {
                    reject_sub(st);
                    return res;
                }
            }
        };
        let Some(me) = self.arc() else {
            return res;
        };
        let remote = r.remote_addr.clone();
        tokio::spawn(async move {
            let release = me.attach_sse_leases(&cid, &remote, presence);
            if !presence && let Some(u) = me.deps.updates.clone() {
                tokio::task::spawn_blocking(move || u.trigger());
            }
            let hello = me.hello_event();
            st.comment("connected");
            st.data(&hello);
            if st.flush().await
                && (presence || !me.foreground_on_connect(&mut st) || st.flush().await)
            {
                me.pump_command_sse(&mut st, sub.as_ref(), &hello).await;
            }
            release();
            match sub {
                Some(s) => {
                    if let Some(c) = me.commands() {
                        c.remove(&s);
                    }
                }
                None => {
                    me.conn.presence_subs.fetch_sub(1, SEQ);
                }
            }
        });
        res
    }

    fn foreground_on_connect(&self, st: &mut dm_webserver_sse::Stream) -> bool {
        let Some(t) = &self.deps.tools else {
            return false;
        };
        let Some(tools) = t.list_ok() else {
            return false;
        };
        if tools.is_empty() {
            return false;
        }
        for ev in hub::foreground_snapshot(&tools) {
            st.data(&ev);
        }
        true
    }

    /// Go `attachSSELeases`: 이 구독이 붙어 있는 동안의 임대(포커스 소유 등)다. 역순으로 푼다.
    fn attach_sse_leases(
        self: &Arc<Self>,
        cid: &str,
        remote: &str,
        _presence: bool,
    ) -> impl FnOnce() {
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
        move || {
            while let Some(f) = undo.pop() {
                f();
            }
        }
    }

    async fn pump_command_sse(
        &self,
        st: &mut dm_webserver_sse::Stream,
        sub: Option<&Arc<hub::CmdSub>>,
        hello: &[u8],
    ) {
        let mut keep = tokio::time::interval_at(
            tokio::time::Instant::now() + self.hello_interval(),
            self.hello_interval(),
        );
        loop {
            match sub {
                Some(s) => {
                    tokio::select! {
                        _ = s.closed() => return,
                        m = s.recv() => match m {
                            Some(msg) => {
                                st.data(&msg);
                                st.drain_data(|| s.try_recv());
                            }
                            None => return,
                        },
                        _ = keep.tick() => st.data(hello),
                    }
                }
                None => {
                    keep.tick().await;
                    st.data(hello);
                }
            }
            if !st.flush().await {
                return;
            }
        }
    }

    pub(crate) fn hello_interval(&self) -> Duration {
        match *self.hello_every.lock().unwrap_or_else(|e| e.into_inner()) {
            Some(d) if !d.is_zero() => d,
            _ => SSE_HELLO_EVERY,
        }
    }

    /// Go `helloEvent`: 판을 알면 `assetVersion` 을 싣는다 (FR-AVS-3).
    pub(crate) fn hello_event(&self) -> Vec<u8> {
        let v = self.asset_version();
        if v.is_empty() {
            return dm_webserver_sse::payload::<()>("server_hello", None);
        }
        let mut m = BTreeMap::new();
        m.insert("assetVersion", v);
        dm_webserver_sse::payload("server_hello", Some(&m))
    }
}

const SEQ: std::sync::atomic::Ordering = std::sync::atomic::Ordering::SeqCst;

fn reject_sub(mut st: dm_webserver_sse::Stream) {
    tokio::spawn(async move {
        st.data(br#"{"action":"subscribeRejected"}"#);
        st.flush().await;
    });
}

async fn parse_command_post(r: &Req) -> Result<CommandPostReq, Response> {
    if r.method != Method::POST {
        return Err(not_allowed());
    }
    let body = r.read_body(0).await.map_err(|e| fail_read(&e))?;
    let req: CommandPostReq = dm_gocompat::json::unmarshal(&body).map_err(|e| {
        let msg = dm_shared_httpreq::message(
            r.rid(),
            r.method.as_str(),
            &r.path,
            "invalid json",
            &dm_shared_httpreq::DecodeError::NotJson(e),
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
