//! 응답 좌석 (TERM_REPLY_SEAT_SRS 묶음 A·B). 같은 도구에 붙은 연결 중 첫 번째만 앱의
//! 질의에 답한다. 서버가 권위로 들고 디스크에 남기지 않는다 (D-4).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use otter_shared_toolhub::OP_REPLY_SEAT;

use crate::lock;

/// 좌석 통보를 보낼 연결이 이미 닫혔다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeatClosed;

/// 좌석 통보를 받을 수 있는 연결이다. 채널의 터미널 sid 하나가 이것을 만족한다.
pub trait SeatConn: Send + Sync {
    fn send<'a>(&'a self, op: u8, payload: &'a [u8]) -> BoxFuture<'a, Result<(), SeatClosed>>;
}

/// 도구마다 붙은 연결을 붙은 순서대로 든다. 좌석의 주인은 언제나 첫 번째다 (FR-RPS-1).
#[derive(Default)]
pub struct ReplySeats {
    by_tool: Mutex<HashMap<String, Vec<Arc<dyn SeatConn>>>>,
}

fn same(a: &Arc<dyn SeatConn>, b: &Arc<dyn SeatConn>) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
}

impl ReplySeats {
    pub fn new() -> ReplySeats {
        ReplySeats::default()
    }

    /// 연결을 목록 끝에 붙이고 그 도구의 모두에게 좌석을 다시 통보한다.
    pub async fn join(&self, tool_id: &str, c: Arc<dyn SeatConn>) {
        let snap = {
            let mut g = lock(&self.by_tool);
            let v = g.entry(tool_id.to_owned()).or_default();
            v.push(c);
            v.clone()
        };
        notify_seats(&snap).await;
    }

    /// 연결을 빼고 남은 모두에게 다시 통보한다. 승계는 이 통보다 (FR-RPS-5). 모르는 도구·연결은
    /// 아무 일도 아니다.
    pub async fn leave(&self, tool_id: &str, c: &Arc<dyn SeatConn>) {
        let snap = {
            let mut g = lock(&self.by_tool);
            let mut v = g.remove(tool_id).unwrap_or_default();
            if let Some(i) = v.iter().position(|x| same(x, c)) {
                v.remove(i);
            }
            if !v.is_empty() {
                g.insert(tool_id.to_owned(), v.clone());
            }
            v
        };
        notify_seats(&snap).await;
    }
}

/// 첫 번째에게 1, 나머지에게 0 을 보낸다. 통보는 락 밖에서 하고 실패는 삼킨다 (FR-RPS-6).
async fn notify_seats(cls: &[Arc<dyn SeatConn>]) {
    for (i, c) in cls.iter().enumerate() {
        let owns = [u8::from(i == 0)];
        let _ = c.send(OP_REPLY_SEAT, &owns).await;
    }
}
