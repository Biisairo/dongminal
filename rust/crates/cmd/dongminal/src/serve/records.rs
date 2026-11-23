//! AGENT_RECORD_DAEMON_SRS 단계 1 — 에이전트 기록의 조립 (FR-ARD-11~14, §3.1a). Go `records.go`.

use std::sync::Arc;
use std::sync::mpsc::{self, TrySendError};

use dm_gocompat::json::RawMessage;
use dm_shared_dmlog::warnf;
use dm_shared_toolhub::AgentState;
use dm_shared_toolipc::{FEATURE_RECORDS, RECORD_AGENT, RecordsResult, ReportEvent};
use dm_webserver_hub::AttnTracker;
use dm_webserver_recordsync::{Sender, Writer};
use dm_webserver_toolclient::{Error as ClientError, ToolClient};

/// 기록에 쓰는 데몬 클라이언트의 부분이다.
pub(crate) trait RecordClient: Send + Sync {
    fn has_feature(&self, name: &str) -> bool;
    fn record_set(&self, kind: &str, tool: &str, v: RawMessage) -> Result<(), ClientError>;
    fn records(&self) -> Result<RecordsResult, ClientError>;
}

impl RecordClient for ToolClient {
    fn has_feature(&self, name: &str) -> bool {
        ToolClient::has_feature(self, name)
    }
    fn record_set(&self, kind: &str, tool: &str, v: RawMessage) -> Result<(), ClientError> {
        ToolClient::record_set(self, kind, tool, v)
    }
    fn records(&self) -> Result<RecordsResult, ClientError> {
        ToolClient::records(self)
    }
}

/// 스냅샷을 받아 반영하는 거울이다 (Go `recordMirror`).
pub(crate) trait RecordMirror: Send + Sync {
    fn apply_records(&self, res: &RecordsResult);
}

/// 보낼 때마다 데몬의 기능을 본다 — 다시 붙은 데몬이 옛 판일 수 있다 (FR-ARD-14). 말하지 않으면
/// 보내지 않고 거울만 남는다. 데몬이 거절한 오류는 [`dm_shared_toolipc::RpcError`] 로 넘겨
/// Writer 가 버리게 한다.
pub(crate) fn record_sender<C: RecordClient + ?Sized + 'static>(c: Arc<C>) -> Sender {
    Box::new(move |kind, tool, v| {
        if !c.has_feature(FEATURE_RECORDS) {
            return Ok(());
        }
        c.record_set(kind, tool, v).map_err(|e| match e {
            ClientError::Rpc(r) => Box::new(r) as dm_webserver_recordsync::SendError,
            other => Box::new(other),
        })
    })
}

/// (다시) 붙었을 때의 재동기다 (FR-ARD-13). 끊긴 동안 거울에만 반영된 쓰기를 먼저 보내야 낡은
/// 스냅샷이 그것을 덮지 않는다.
pub(crate) fn sync_records<C: RecordClient + ?Sized, M: RecordMirror + ?Sized>(
    c: &C,
    w: &Writer,
    m: &M,
) {
    if !c.has_feature(FEATURE_RECORDS) {
        return;
    }
    w.flush();
    match c.records() {
        Ok(res) => m.apply_records(&res),
        Err(e) => {
            warnf!(
                None,
                "records: 데몬의 스냅샷을 받지 못했다 — 거울을 그대로 둔다: {e}"
            );
        }
    }
}

/// 추적기의 판정 결과를 데몬에 쓰는 큐를 만든다.
pub(crate) fn new_record_writer<C: RecordClient + ?Sized + 'static>(
    c: Arc<C>,
    t: &AttnTracker,
) -> Arc<Writer> {
    let w = Writer::new(record_sender(c));
    let put = Arc::clone(&w);
    t.set_on_change(Some(Arc::new(move |id: &str, st: AgentState| {
        put.put(RECORD_AGENT, id, &st)
    })));
    w
}

/// 처리를 기다리는 report push 의 상한이다.
pub(crate) const REPORT_QUEUE_SIZE: usize = 1024;

/// report push 를 받은 순서대로 스레드 하나가 apply 로 처리하게 한다 (§3.2a). push 는 읽기 루프에서
/// 오는데, 처리 중에 데몬 RPC 를 기다리면 응답을 읽을 루프가 자기 자신이라 교착이다. 줄이 차면
/// 버리고 로그를 남긴다 — 버린 보고도 데몬 기록에는 남는다.
pub(crate) fn new_report_queue(
    apply: impl Fn(&str, &[u8]) + Send + 'static,
) -> impl Fn(ReportEvent) + Send + Sync + 'static {
    let (tx, rx) = mpsc::sync_channel::<ReportEvent>(REPORT_QUEUE_SIZE);
    std::thread::spawn(move || {
        for ev in rx {
            apply(&ev.method, &ev.body.0);
        }
    });
    move |ev: ReportEvent| {
        if let Err(TrySendError::Full(ev)) = tx.try_send(ev) {
            warnf!(None, "report: 처리 줄이 차서 {} 보고를 버렸다", ev.method);
        }
    }
}
