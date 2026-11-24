//! 전경 이름 조회 (CONVENIENCE_SRS FR-TAN-7·8).

use std::sync::Arc;
use std::time::Duration;

use otter_shared_toolhub::ToolInfo;
use otter_shared_toolipc::FEATURE_FOREGROUND_TICK;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{CommandBroker, payloads::tool_foreground_payload};

/// 전경 이름 조회를 돌리는 주기다 (FR-TAN-8). toolhub 쪽 캐시와 같은 값이다.
pub const FOREGROUND_INTERVAL: Duration = otter_shared_toolhub::FOREGROUND_REFRESH_INTERVAL;

/// 전경 조회가 쓰는 도구 허브의 부분이다 (Go `toolhub.ToolHub` 중 `HasFeature`·`List`).
/// 구현(toolclient)은 동기 RPC 다.
pub trait ForegroundSource: Send + Sync {
    fn has_feature(&self, name: &str) -> bool;
    fn list(&self) -> Vec<ToolInfo>;
}

/// 전경 이름 변화를 SSE 로 내보내는 콜백이다 (FR-TAN-7).
pub fn broadcast_foreground(hub: Arc<dyn CommandBroker>) -> impl Fn(&str, &str) + Send + Sync {
    move |tool_id, name| {
        hub.broadcast(&tool_foreground_payload(tool_id, name));
    }
}

/// 틱마다 `list()` 를 불러 데몬이 전경 이름을 조회하게 한다. 전경 티커를 도는
/// 데몬(FEATURE_FOREGROUND_TICK)에는 아무것도 하지 않는다 (FR-OPT-2-1). 판정은 틱마다 한다.
pub fn start_foreground_poll(
    tools: Option<Arc<dyn ForegroundSource>>,
    stop: CancellationToken,
    mut tick: mpsc::Receiver<()>,
) {
    let Some(tools) = tools else {
        return;
    };
    tokio::spawn(async move {
        loop {
            tokio::select! {
                t = tick.recv() => {
                    if t.is_none() {
                        return;
                    }
                    let tools = tools.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        if !tools.has_feature(FEATURE_FOREGROUND_TICK) {
                            tools.list();
                        }
                    })
                    .await;
                }
                _ = stop.cancelled() => return,
            }
        }
    });
}

/// `period` 마다 틱을 하나 보내는 채널이다. 받는 쪽이 늦으면 밀린 틱을 버린다(Go `time.Ticker`).
/// `stop` 이 취소되면 채널이 닫힌다.
pub fn ticker(period: Duration, stop: CancellationToken) -> mpsc::Receiver<()> {
    let (tx, rx) = mpsc::channel(1);
    tokio::spawn(async move {
        let mut iv = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = iv.tick() => { let _ = tx.try_send(()); }
                _ = stop.cancelled() => return,
            }
        }
    });
    rx
}
