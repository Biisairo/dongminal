//! 기록·알람·간선·채팅 — 데몬이 해당 기능을 말할 때만 부르는 RPC 와 그 push 콜백이다.

use std::time::Duration;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_toolipc::{
    AttendAllResult, AttendParams, AttnConfigParams, ChatParams, ChatResult, EdgeParams,
    EdgePortParams, EdgeResult, FEATURE_CHAT, FEATURE_EDGE, METHOD_ATTEND, METHOD_ATTEND_ALL,
    METHOD_ATTN_CONFIG, METHOD_CHAT, METHOD_EDGE, METHOD_EDGE_PORT, METHOD_RECORD_SET,
    METHOD_RECORDS, METHOD_REPORT, RecordSetParams, RecordsResult, ReportParams,
};
use serde::Serialize;

use crate::client::{
    AttnCallback, ChatCallback, EdgesCallback, ReportCallback, ResyncCallback, ToolClient, lock,
};
use crate::error::Error;
use crate::wire::Empty;

/// edge 한 번의 상한이다. 데몬의 상한(30초)보다 길어야 한다 — 시한을 넘긴 호출은 연결 전체를 끊는다.
pub const EDGE_CALL_WITHIN: Duration = Duration::from_secs(35);

impl ToolClient {
    /// 기록 하나를 데몬에 쓴다 (FR-ARD-11). value 가 비면 `null` 로 나가 지운다. 데몬이 거절하면
    /// [`Error::Rpc`] 다.
    pub fn record_set(&self, kind: &str, tool: &str, value: RawMessage) -> Result<(), Error> {
        let params = RecordSetParams {
            kind: kind.to_owned(),
            tool: tool.to_owned(),
            value,
        };
        self.call_raw(METHOD_RECORD_SET, &params).map(drop)
    }

    /// 데몬의 기록 전부다 (FR-ARD-13).
    pub fn records(&self) -> Result<RecordsResult, Error> {
        self.call(METHOD_RECORDS, &Empty {})
    }

    /// 재접속 뒤 기록 재동기 콜백이다. 출력·종료의 재동기가 끝난 뒤 감독 스레드에서 돈다.
    pub fn set_on_resync(&self, cb: Option<ResyncCallback>) {
        lock(&self.inner.st).cbs.on_resync = cb;
    }

    /// report push 콜백이다 (§3.2a). 읽기 루프에서 돌므로 데몬 RPC 를 기다리면 안 된다.
    pub fn set_on_report(&self, cb: Option<ReportCallback>) {
        lock(&self.inner.st).cbs.on_report = cb;
    }

    /// 판정 설정을 보낸다 (FR-ARD-31).
    pub fn attn_config(&self, idle_ms: i64, allow_bell: bool) -> Result<(), Error> {
        let params = AttnConfigParams {
            idle_ms,
            allow_bell,
        };
        self.call_raw(METHOD_ATTN_CONFIG, &params).map(drop)
    }

    /// 도구 하나의 알람 해제다 (FR-ARD-32).
    pub fn attend(&self, tool_id: &str, typed: bool) -> Result<(), Error> {
        let params = AttendParams {
            tool: tool_id.to_owned(),
            typed,
        };
        self.call_raw(METHOD_ATTEND, &params).map(drop)
    }

    /// 알람 전부의 해제다. 해제한 수를 돌려준다.
    pub fn attend_all(&self) -> Result<i64, Error> {
        self.call::<AttendAllResult, _>(METHOD_ATTEND_ALL, &Empty {})
            .map(|r| r.cleared)
    }

    /// 서버 HTTP 로 온 보고를 데몬에 넘긴다.
    pub fn report<B: Serialize + ?Sized>(&self, method: &str, body: &B) -> Result<(), Error> {
        let raw = json::marshal(body).map_err(Error::Json)?;
        let params = ReportParams {
            method: method.to_owned(),
            body: RawMessage(raw),
        };
        self.call_raw(METHOD_REPORT, &params).map(drop)
    }

    /// attn push 콜백이다. 배선 전에 온 push 는 놓친다 — 붙은 직후의 스냅샷이 그 상태를 싣는다.
    pub fn set_on_attn(&self, cb: Option<AttnCallback>) {
        lock(&self.inner.st).cbs.on_attn = cb;
    }

    /// 붙은 데몬이 노드 기능을 말하는가다 (FR-PDM-50). 데몬이 바뀔 수 있으므로 부를 때마다 묻는다.
    pub fn edge_ready(&self) -> bool {
        self.has_feature(FEATURE_EDGE)
    }

    /// 로컬 API 연산 하나를 데몬의 노드에 넘긴다 (FR-PDM-30).
    pub fn edge(&self, p: &EdgeParams) -> Result<EdgeResult, Error> {
        self.call_within(METHOD_EDGE, p, EDGE_CALL_WITHIN)
    }

    /// 서버가 연 노드 포트의 상태를 데몬에 알린다 (FR-PDM-14).
    pub fn edge_port(&self, p: &EdgePortParams) -> Result<(), Error> {
        self.call_raw(METHOD_EDGE_PORT, p).map(drop)
    }

    /// edges push 콜백이다. 읽기 루프에서 돈다.
    pub fn set_on_edges(&self, cb: Option<EdgesCallback>) {
        lock(&self.inner.st).cbs.on_edges = cb;
    }

    /// 재접속 뒤의 간선 재동기 콜백이다 (FR-PDM-33). 감독 스레드에서 돈다.
    pub fn set_on_edge_resync(&self, cb: Option<ResyncCallback>) {
        lock(&self.inner.st).cbs.on_edge_resync = cb;
    }

    /// 붙은 데몬이 chat 기능을 말하는가다.
    pub fn chat_ready(&self) -> bool {
        self.has_feature(FEATURE_CHAT)
    }

    /// 사람 참가자의 연산 하나를 데몬에 넘긴다 (PEER_CHAT_SRS §3.11).
    pub fn chat(&self, p: &ChatParams) -> Result<ChatResult, Error> {
        self.call(METHOD_CHAT, p)
    }

    /// chat push 콜백이다. 읽기 루프에서 돈다.
    pub fn set_on_chat(&self, cb: Option<ChatCallback>) {
        lock(&self.inner.st).cbs.on_chat = cb;
    }

    /// 재접속 뒤의 채팅 콜백이다. 끊긴 동안의 바뀜을 화면이 다시 읽게 한다.
    pub fn set_on_chat_resync(&self, cb: Option<ResyncCallback>) {
        lock(&self.inner.st).cbs.on_chat_resync = cb;
    }
}
