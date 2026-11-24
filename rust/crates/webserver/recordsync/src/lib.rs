//! Go 기준선 `otterminal/internal/webserver/recordsync` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 서버가 에이전트 기록을 데몬에 쓰는 큐다 (AGENT_RECORD_DAEMON_SRS FR-ARD-11, §3.1a).
//! 쓰기는 부르는 쪽을 막지 않는다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use otter_gocompat::json::{self, RawMessage};
use otter_shared_toolipc::{CODE_NOT_FOUND, RpcError};
use serde::Serialize;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// 보내기의 오류다. 데몬이 거절한 것은 [`RpcError`] 를 싣는다.
pub type SendError = Box<dyn std::error::Error + Send + Sync>;

/// 기록 하나를 데몬에 보낸다 (toolclient `record_set`).
pub type Sender = Box<dyn Fn(&str, &str, RawMessage) -> Result<(), SendError> + Send + Sync>;

type Key = (String, String);

/// (kind, tool) 마다 마지막 값 하나를 두고 보낸다.
///   - 연결 오류로 실패한 값은 남겨 두었다가 다음 `put`·`flush` 때 다시 보낸다
///   - 데몬이 거절한 값([`RpcError`])은 버린다
///
/// Go 의 nil Writer(records 를 모르는 옛 데몬, FR-ARD-14)는 `Option<Arc<Writer>>` 의 `None` 이다.
pub struct Writer {
    send: Sender,
    kick: Notify,
    pending: Mutex<HashMap<Key, RawMessage>>,
    // 보내기를 한 줄로 세운다 — 배경 작업과 flush 가 겹치지 않는다.
    send_mu: Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Writer {
    pub fn new(send: Sender) -> Arc<Writer> {
        Arc::new(Writer {
            send,
            kick: Notify::new(),
            pending: Mutex::new(HashMap::new()),
            send_mu: Mutex::new(()),
        })
    }

    /// `put` 을 받아 보내는 작업을 띄운다. `stop` 이 취소되면 멈춘다. 보내기는 동기 RPC 라
    /// blocking 스레드에서 한다.
    pub fn start(self: &Arc<Self>, stop: CancellationToken) {
        let w = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = w.kick.notified() => {
                        let w2 = w.clone();
                        let _ = tokio::task::spawn_blocking(move || w2.flush()).await;
                    }
                    _ = stop.cancelled() => return,
                }
            }
        });
    }

    /// `v` 를 JSON 으로 바꿔 줄에 넣는다. `v` 가 `()`·`None` 이면(JSON `null`) 그 기록을 지우는 쓰기다.
    pub fn put<T: Serialize + ?Sized>(&self, kind: &str, tool: &str, v: &T) {
        let raw = match json::marshal(v) {
            Ok(b) => b,
            Err(e) => {
                otter_shared_otterlog::errorf!(None, "recordsync: {kind}/{tool} 부호화 실패: {e}");
                return;
            }
        };
        lock(&self.pending).insert((kind.to_owned(), tool.to_owned()), RawMessage(raw));
        self.kick.notify_one();
    }

    /// 줄에 있는 값을 지금 보낸다. 연결 오류가 나면 그 값을 남기고 멈춘다.
    pub fn flush(&self) {
        let _g = lock(&self.send_mu);
        while let Some((k, v)) = self.take() {
            let err = match (self.send)(&k.0, &k.1, v.clone()) {
                Ok(()) => continue,
                Err(e) => e,
            };
            if let Some(rpc) = err.downcast_ref::<RpcError>() {
                // 끝난 도구의 쓰기(종료 때의 ended 활동)는 데몬이 이미 지운 뒤라 없다고 답한다.
                if rpc.code != CODE_NOT_FOUND {
                    otter_shared_otterlog::warnf!(
                        None,
                        "recordsync: 데몬이 {}/{} 를 거절했다 — 거울에만 남는다: {err}",
                        k.0,
                        k.1
                    );
                }
                continue;
            }
            self.restore(k, v);
            return;
        }
    }

    fn take(&self) -> Option<(Key, RawMessage)> {
        let mut g = lock(&self.pending);
        let k = g.keys().next()?.clone();
        g.remove_entry(&k)
    }

    /// 보내지 못한 값을 되돌린다. 그사이 새 값이 왔으면 새 값을 둔다.
    fn restore(&self, k: Key, v: RawMessage) {
        lock(&self.pending).entry(k).or_insert(v);
    }

    #[cfg(test)]
    fn pending_of(&self, kind: &str, tool: &str) -> Option<Vec<u8>> {
        lock(&self.pending)
            .get(&(kind.to_owned(), tool.to_owned()))
            .map(|r| r.0.clone())
    }
}

#[cfg(test)]
mod tests;
