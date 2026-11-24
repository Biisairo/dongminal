//! 브라우저 터미널 프레임의 op 코드와 쓰기 마감 (채널 `[op][sid][payload]`, CHANNEL_PROTOCOL §4.2).

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

/// `OP_SIZE` 의 4 바이트다 (FR-M9-3).
pub fn size_payload(cols: u16, rows: u16) -> [u8; 4] {
    let [c0, c1] = cols.to_be_bytes();
    let [r0, r1] = rows.to_be_bytes();
    [c0, c1, r0, r1]
}

/// 쓰기 한 번의 마감이다(Go `writeWait`).
pub const WRITE_WAIT: Duration = Duration::from_secs(10);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_payload_is_big_endian() {
        assert_eq!(size_payload(0x0102, 0x0304), [1, 2, 3, 4]);
    }
}
