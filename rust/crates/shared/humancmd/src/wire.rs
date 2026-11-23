use std::io::{ErrorKind, Read, Write};
use std::time::Duration;

use dm_gocompat::json;

use crate::{Error, Frame};

/// 도우미 소켓 왕복 한 번(연결·쓰기·읽기)의 상한이다 (REFACTOR3_GO_STRUCT_SRS FR-RGS-41).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);

/// 도우미 소켓 한 줄의 상한이다.
pub const MAX_LINE: usize = 64 << 10;

const READ_CHUNK: usize = 4096;

/// 요청 프레임 한 줄을 쓰고 응답 한 줄을 읽는다. 연결 하나에 요청 하나다.
///
/// 연결·마감 시각은 부르는 쪽이 정한다(Go `Client.roundTrip` 의 Dial·SetDeadline). 쓰기·읽기
/// 실패, 줄이 없거나 [`MAX_LINE`] 을 넘음, 해석 실패는 모두 `no_helper` 다.
pub fn round_trip<S: Read + Write>(stream: &mut S, req: &Frame) -> Result<Frame, Error> {
    let mut line = json::marshal(req).map_err(|_| Error::no_helper())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|_| Error::no_helper())?;
    let resp = scan_line(stream).ok_or_else(Error::no_helper)?;
    json::unmarshal::<Frame>(&resp).map_err(|_| Error::no_helper())
}

/// Go `bufio.Scanner`(ScanLines, 버퍼 상한 MAX_LINE) 의 첫 토큰이다. 끝의 `\r` 은 뗀다.
/// 줄바꿈 없이 MAX_LINE 바이트가 차면 `None`(ErrTooLong)이다.
fn scan_line<R: Read>(r: &mut R) -> Option<Vec<u8>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; READ_CHUNK];
    loop {
        if let Some(i) = buf.iter().position(|&c| c == b'\n') {
            buf.truncate(i);
            return Some(drop_cr(buf));
        }
        if buf.len() >= MAX_LINE {
            return None;
        }
        let want = (MAX_LINE - buf.len()).min(READ_CHUNK);
        match r.read(&mut chunk[..want]) {
            Ok(n) if n > 0 => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            // EOF 와 읽기 오류(마감 초과 포함)는 같다: 남은 조각이 있으면 그것이 토큰이다.
            _ => return (!buf.is_empty()).then(|| drop_cr(buf)),
        }
    }
}

fn drop_cr(mut b: Vec<u8>) -> Vec<u8> {
    if b.last() == Some(&b'\r') {
        b.pop();
    }
    b
}
