//! AGENT_RECORD_DAEMON_SRS 단계 3 — 알람 판정의 조립 (FR-ARD-30~32, §3.3a). Go `attention.go`.

use std::sync::Arc;

use dm_gocompat::json::RawMessage;
use dm_shared_dmlog::warnf;
use dm_shared_toolhub::{ToolInfo, attention_allow_bell, attention_idle_threshold};
use dm_shared_toolipc::{AttnEvent, FEATURE_ATTENTION};
use dm_webserver_httpapi::{AttentionDaemon, DaemonCallError};
use dm_webserver_hub::{AttnTracker, LiveProbe};
use dm_webserver_toolclient::{AttnCallback, Error as ClientError, ToolClient};

use super::adapters::call_err;

/// 알람 판정에 쓰는 데몬 클라이언트의 부분이다.
pub(crate) trait AttnClient: Send + Sync {
    fn has_feature(&self, name: &str) -> bool;
    fn attn_config(&self, idle_ms: i64, allow_bell: bool) -> Result<(), ClientError>;
    fn report(&self, method: &str, body: &[u8]) -> Result<(), ClientError>;
    fn attend(&self, tool_id: &str, typed: bool) -> Result<(), ClientError>;
    fn attend_all(&self) -> Result<i64, ClientError>;
    fn set_on_attn(&self, cb: Option<AttnCallback>);
}

impl AttnClient for ToolClient {
    fn has_feature(&self, name: &str) -> bool {
        ToolClient::has_feature(self, name)
    }
    fn attn_config(&self, idle_ms: i64, allow_bell: bool) -> Result<(), ClientError> {
        ToolClient::attn_config(self, idle_ms, allow_bell)
    }
    fn report(&self, method: &str, body: &[u8]) -> Result<(), ClientError> {
        ToolClient::report(self, method, &RawMessage(body.to_vec()))
    }
    fn attend(&self, tool_id: &str, typed: bool) -> Result<(), ClientError> {
        ToolClient::attend(self, tool_id, typed)
    }
    fn attend_all(&self) -> Result<i64, ClientError> {
        ToolClient::attend_all(self)
    }
    fn set_on_attn(&self, cb: Option<AttnCallback>) {
        ToolClient::set_on_attn(self, cb)
    }
}

/// httpapi `AttentionDaemon` 이다. 판정 여부는 부를 때마다 데몬의 기능을 본다 — 다시 붙은 데몬이
/// 옛 판일 수 있다.
pub(crate) struct DaemonAttention<C: ?Sized>(pub(crate) Arc<C>);

impl<C: AttnClient + ?Sized> AttentionDaemon for DaemonAttention<C> {
    fn judges(&self) -> bool {
        self.0.has_feature(FEATURE_ATTENTION)
    }
    fn report(&self, method: &str, body: &[u8]) -> Result<(), DaemonCallError> {
        self.0.report(method, body).map_err(call_err)
    }
    fn attend(&self, tool_id: &str, typed: bool) -> Result<(), DaemonCallError> {
        self.0.attend(tool_id, typed).map_err(call_err)
    }
    fn attend_all(&self) -> Result<i64, DaemonCallError> {
        self.0.attend_all().map_err(call_err)
    }
}

/// 추적기를 데몬 판정의 거울로 잇고 판정 설정을 보낸다. 다시 붙을 때는 [`sync_attn_config`] 를
/// 다시 부른다.
pub(crate) fn wire_daemon_attention<C: AttnClient + 'static>(
    c: &Arc<C>,
    tr: &Arc<AttnTracker>,
) -> DaemonAttention<C> {
    let judge = Arc::clone(c);
    tr.set_mirror(move || judge.has_feature(FEATURE_ATTENTION));
    let mirror = Arc::clone(tr);
    c.set_on_attn(Some(Arc::new(move |ev: AttnEvent| mirror.apply_attn(&ev))));
    sync_attn_config(&**c);
    DaemonAttention(Arc::clone(c))
}

/// 서버가 읽은 판정 설정을 데몬에 보낸다 (FR-ARD-31). 두 값은 서버가 뜰 때 읽는 환경변수라 붙을
/// 때마다 보내면 된다.
pub(crate) fn sync_attn_config<C: AttnClient + ?Sized>(c: &C) {
    if !c.has_feature(FEATURE_ATTENTION) {
        return;
    }
    let idle = i64::try_from(attention_idle_threshold().as_millis()).unwrap_or(i64::MAX);
    if let Err(e) = c.attn_config(idle, attention_allow_bell()) {
        warnf!(None, "attention: 판정 설정을 데몬에 보내지 못했다: {e}");
    }
}

/// 목록을 믿을 수 있을 때만 답하는 허브의 부분이다 (Go `ListOK`).
pub(crate) trait ListOk: Send + Sync {
    fn list_ok(&self) -> Option<Vec<ToolInfo>>;
}

impl ListOk for ToolClient {
    fn list_ok(&self) -> Option<Vec<ToolInfo>> {
        ToolClient::list_ok(self)
    }
}

/// 알람 생존 검사다 (FR-ATL-6). **확인된 죽음만 거른다** (FR-ARD-2) — 데몬이 목록에 답하지 못하는
/// 동안 거르면 살아 있는 도구의 알람이 들어오는 브라우저에서 사라진다.
pub(crate) fn attn_live_probe(h: Arc<dyn ListOk>) -> LiveProbe {
    Arc::new(move |id: &str| match h.list_ok() {
        None => true,
        Some(tools) => tools.iter().any(|t| t.id == id),
    })
}
