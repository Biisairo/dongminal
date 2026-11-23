//! 브라우저 WebSocket 와이어의 op 코드와 타임아웃 상수. 쓰기 창구(SafeConn)는 2.2.3.

use std::time::Duration;

pub const OP_INPUT: u8 = 0x00;
pub const OP_RESIZE: u8 = 0x01;
pub const OP_OUTPUT: u8 = 0x00;
pub const OP_ERROR: u8 = 0x01;
pub const OP_EXIT: u8 = 0x02;
pub const OP_TOOL_ID: u8 = 0x03;
/// 좌표 통보. 페이로드 9 바이트 — 오프셋 8(빅엔디언) + 전량 재생 여부 1 (FR-TRS-6).
pub const OP_SEQ: u8 = 0x04;
/// PTY 크기 통보. 페이로드 4 바이트 — cols 2 + rows 2, 빅엔디언 (FR-M9-3).
pub const OP_SIZE: u8 = 0x05;
/// 답장 자격 통보. 페이로드 1 바이트 — 1=좌석의 주인 (TERM_REPLY_SEAT_SRS FR-RPS-3).
pub const OP_REPLY_SEAT: u8 = 0x06;

pub const PONG_WAIT: Duration = Duration::from_secs(60);
pub const PING_PERIOD: Duration = Duration::from_secs(54);

/// `OP_SIZE` 의 4 바이트다 (FR-M9-3).
pub fn size_payload(cols: u16, rows: u16) -> [u8; 4] {
    let [c0, c1] = cols.to_be_bytes();
    let [r0, r1] = rows.to_be_bytes();
    [c0, c1, r0, r1]
}
