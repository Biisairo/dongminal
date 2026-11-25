//! 전경 이름 알림 (CONVENIENCE_SRS FR-TAN-7·8). 조회는 데몬이 한다.

use std::sync::Arc;

use crate::{CommandBroker, payloads::tool_foreground_payload};

/// 전경 이름 변화를 SSE 로 내보내는 콜백이다 (FR-TAN-7).
pub fn broadcast_foreground(hub: Arc<dyn CommandBroker>) -> impl Fn(&str, &str) + Send + Sync {
    move |tool_id, name| {
        hub.broadcast(&tool_foreground_payload(tool_id, name));
    }
}
