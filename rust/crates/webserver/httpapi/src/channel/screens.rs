//! 깨움 스냅숏을 도구마다 한 번만 만든다 (PERF M2 §2.5). 같은 도구를 여럿이 한꺼번에 깨우면 먼저 온
//! 요청 하나만 데몬에 묻고, 그 답을 나머지가 함께 받는다. 함께 받은 쪽의 구독이 스냅숏 오프셋보다
//! 늦게 섰으면 그 사이 바이트는 중계의 틈 메우기(`resync`)가 링에서 잇는다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use otter_shared_toolhub::ToolScreen;
use tokio::sync::oneshot;

use crate::toolhub::{ToolError, ToolHub};

/// 깨움 스냅숏에 싣는 기록 행 수 (FR-TRM-4, D-7).
pub(crate) const WAKE_HISTORY: usize = 5_000;

pub(crate) type ScreenResult = Result<Arc<ToolScreen>, ToolError>;

type Waiters = HashMap<String, Vec<oneshot::Sender<ScreenResult>>>;

#[derive(Default)]
pub(crate) struct ScreenFlights(Arc<Mutex<Waiters>>);

impl ScreenFlights {
    /// `tool` 의 스냅숏. 이미 묻는 중이면 그 답을 함께 받는다. 묻기는 따로 띄운 일이 하므로 부른
    /// 쪽이 도중에 멈춰도 기다리던 쪽은 답을 받는다.
    pub(crate) async fn get(&self, hub: &Arc<dyn ToolHub>, tool: &str) -> ScreenResult {
        let (tx, rx) = oneshot::channel();
        let lead = {
            let mut g = self.0.lock().unwrap_or_else(|e| e.into_inner());
            let waiters = g.entry(tool.to_owned()).or_default();
            waiters.push(tx);
            waiters.len() == 1
        };
        if lead {
            let (map, hub, id, key) = (
                self.0.clone(),
                hub.clone(),
                tool.to_owned(),
                tool.to_owned(),
            );
            tokio::spawn(async move {
                let r = tokio::task::spawn_blocking(move || hub.screen_tool(&id, WAKE_HISTORY))
                    .await
                    .unwrap_or_else(|e| Err(ToolError::Other(e.to_string())))
                    .map(Arc::new);
                let waiters = map
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&key)
                    .unwrap_or_default();
                for w in waiters {
                    let _ = w.send(r.clone());
                }
            });
        }
        rx.await
            .unwrap_or_else(|e| Err(ToolError::Other(e.to_string())))
    }
}
