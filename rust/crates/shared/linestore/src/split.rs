//! 에뮬레이터에 넣기 전 청크 나누기 — 한 조각이 기록으로 밀어 올리는 행이 `max_rows` 를 넘지 않게 한다.
//!
//! 한 조각이 밀어 올리는 행의 상한 = 줄바꿈(LF·VT·FF) 수 + 바이트 수 / `cols` + 1.
//! 셀 하나는 적어도 1 바이트라 자동 줄바꿈 행은 `바이트 / cols + 1` 을 넘지 않는다.
//! 이스케이프로 미는 행(CSI S, IND·NEL, 화면 지우기)은 세지 않는다.

const NEWLINES: [u8; 3] = [b'\n', 0x0b, 0x0c];

/// 이어 붙이면 `chunk` 가 되는 조각들. 에뮬레이터 파서는 조각 사이의 이스케이프·UTF-8 을 이어 읽는다.
pub fn split_for_rows(chunk: &[u8], cols: usize, max_rows: usize) -> Vec<&[u8]> {
    let cols = cols.max(1);
    // 1 바이트 조각의 상한이 3 이라 그보다 작으면 나아가지 못한다.
    let max_rows = max_rows.max(3);
    let mut out = Vec::new();
    let mut start = 0;
    let mut newlines = 0;
    for (i, b) in chunk.iter().enumerate() {
        let nl = usize::from(NEWLINES.contains(b));
        let bytes = i + 1 - start;
        if i > start && newlines + nl + bytes / cols + 1 > max_rows {
            out.push(&chunk[start..i]);
            start = i;
            newlines = 0;
        }
        newlines += nl;
    }
    if start < chunk.len() {
        out.push(&chunk[start..]);
    }
    out
}

#[cfg(test)]
#[path = "split_tests.rs"]
mod tests;
