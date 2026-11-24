//! Go 기준선 `dongminal/internal/shared/handover` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 데몬 교체(세션 유지 재시작)의 와이어다 (DAEMON_SESSION_KEEP_SRS).

use std::io::{self, Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use dm_gocompat::json::{self, Encoder, ErrorKind, RawMessage};
use dm_gocompat::oserr::go_error_string;
use dm_gocompat::strconv;
use dm_shared_agentrec::{Reply, Request, socket_path};
use dm_shared_platform::IpcStream;
use serde::{Deserialize, Serialize};

/// 인계 상태의 모양을 세는 판 (FR-DSK-18·D-DSK-11).
pub const VERSION: i64 = 1;

/// 보고 소켓의 교체 메서드 (FR-DSK-10·17).
pub const METHOD_RELOAD: &str = "daemon.reload";
pub const METHOD_HELLO: &str = "daemon.hello";

/// 거절 사유 코드 (FR-DSK-11·12·13).
pub const REASON_EXE: &str = "reload_exe";
pub const REASON_VERSION: &str = "reload_version";
pub const REASON_BUSY: &str = "reload_busy";
pub const REASON_UNSUPPORTED: &str = "reload_unsupported";
pub const REASON_PREFLIGHT: &str = "reload_preflight";
pub const REASON_STATE: &str = "reload_state";
/// 데몬이 답하지 않은 경우. 데몬이 내는 코드가 아니다.
pub const REASON_NO_REPLY: &str = "reload_no_reply";

/// 교체 요청 본문의 상한 (FR-DSK-19).
pub const MAX_REQUEST_BYTES: usize = 64 << 10;

/// 보고 소켓이 모르는 메서드에 답하는 문구. 바꾸면 옛 데몬을 알아보지 못한다 (FR-DSK-3).
pub const OLD_DAEMON_UNKNOWN_METHOD: &str = "보고 소켓이 받지 않는 메서드다";

/// 교체 요청의 본문 (FR-DSK-10).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "handover.ReloadRequest")]
pub struct ReloadRequest {
    pub exe: String,
    pub handover: i64,
}

/// 교체 요청의 결말.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 데몬이 교체를 받아들였다. 새 데몬이 떴는지는 따로 확인한다 (FR-DSK-17).
    Swapped,
    /// 데몬이 교체를 모른다 (FR-DSK-3).
    Unsupported,
    /// 데몬이 거절했거나 답하지 않았다. 아무것도 바뀌지 않았다 (FR-DSK-2).
    Refused,
}

/// 교체 요청 하나의 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub kind: Kind,
    pub reason: String,
    pub detail: String,
}

impl Outcome {
    fn new(kind: Kind, reason: &str, detail: &str) -> Self {
        Self {
            kind,
            reason: reason.to_owned(),
            detail: detail.to_owned(),
        }
    }
}

/// 데몬의 답을 결말로 가른다. read_err 는 답을 읽지 못한 오류의 문구다.
pub fn classify(reply: &Reply, read_err: Option<&str>) -> Outcome {
    if let Some(e) = read_err {
        return Outcome::new(Kind::Refused, REASON_NO_REPLY, e);
    }
    if reply.ok {
        return Outcome::new(Kind::Swapped, "", "");
    }
    if reply.error.starts_with(OLD_DAEMON_UNKNOWN_METHOD) {
        return Outcome::new(Kind::Unsupported, "", &reply.error);
    }
    if reply.error.is_empty() {
        return Outcome::new(Kind::Refused, REASON_NO_REPLY, "빈 답");
    }
    let (reason, detail) = reply.error.split_once(": ").unwrap_or((&reply.error, ""));
    Outcome::new(Kind::Refused, reason, detail)
}

/// home 의 데몬에 exe 로 교체하라고 요청한다. 보고 소켓에 붙지 못하면 Unsupported 다 (FR-DSK-3).
pub fn reload(home: &Path, exe: &str, within: Duration) -> Outcome {
    let body = match json::marshal(&ReloadRequest {
        exe: exe.to_owned(),
        handover: VERSION,
    }) {
        Ok(b) => b,
        Err(e) => return Outcome::new(Kind::Refused, REASON_EXE, &e.to_string()),
    };
    let mut c = match dial(home, within) {
        Ok(c) => c,
        Err(e) => return Outcome::new(Kind::Unsupported, "", &go_error_string(&e)),
    };
    match exchange(&mut c, METHOD_RELOAD, body, within) {
        Ok(reply) => classify(&reply, None),
        Err(e) => classify(&Reply::default(), Some(&e)),
    }
}

/// home 의 데몬이 보고 소켓에서 교체를 아는 판으로 답하는가 (FR-DSK-17).
pub fn hello(home: &Path, within: Duration) -> bool {
    let Ok(mut c) = dial(home, within) else {
        return false;
    };
    exchange(&mut c, METHOD_HELLO, b"{}".to_vec(), within).is_ok_and(|r| r.ok)
}

fn dial(home: &Path, within: Duration) -> io::Result<IpcStream> {
    dm_shared_platform::current()
        .ipc
        .dial(&socket_path(home), within)
}

/// 요청 한 줄을 쓰고 답 하나를 읽는다. 시한은 Go `SetDeadline` 처럼 전체에 걸린다.
fn exchange(
    c: &mut IpcStream,
    method: &str,
    body: Vec<u8>,
    within: Duration,
) -> Result<Reply, String> {
    let deadline = Instant::now() + within;
    let line = Encoder::new()
        .encode(&Request {
            method: method.to_owned(),
            body: RawMessage(body),
        })
        .map_err(|e| e.to_string())?;
    c.set_write_timeout(Some(remaining(deadline)))
        .map_err(|e| go_error_string(&e))?;
    c.write_all(&line).map_err(|e| go_error_string(&e))?;
    decode_one(c, deadline)
}

fn remaining(deadline: Instant) -> Duration {
    deadline
        .saturating_duration_since(Instant::now())
        .max(Duration::from_micros(1))
}

/// Go `json.NewDecoder(c).Decode(&reply)`: 값 하나가 끝날 때까지 읽는다.
fn decode_one(c: &mut IpcStream, deadline: Instant) -> Result<Reply, String> {
    let dec = json::Decoder::new();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if !buf.is_empty() {
            match dec.decode::<Reply>(&buf) {
                Err(e) if matches!(e.kind(), ErrorKind::UnexpectedEof) => {}
                r => return r.map_err(|e| e.to_string()),
            }
        }
        c.set_read_timeout(Some(remaining(deadline)))
            .map_err(|e| go_error_string(&e))?;
        match c.read(&mut chunk) {
            Ok(0) => return dec.decode::<Reply>(&buf).map_err(|e| e.to_string()),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(go_error_string(&e)),
        }
    }
}

/// 데몬 진입 인자 (`dongminal d …`, FR-DSK-12·20).
pub const ARG_VERSION: &str = "--handover-version";
pub const ARG_FD: &str = "--handover-fd";

/// `dongminal d` 뒤의 인자.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DaemonArgs {
    /// 인계 판만 말하고 끝내라는 뜻이다 (사전 확인).
    pub version_query: bool,
    /// 인계 상태를 담은 fd. 0 이면 일반 기동이다.
    pub handover_fd: i64,
}

/// `dongminal d` 뒤의 인자를 해석한다. fd 는 표준 입출력(0~2)일 수 없다.
pub fn parse_daemon_args(args: &[String]) -> Result<DaemonArgs, String> {
    let mut a = DaemonArgs::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            ARG_VERSION => a.version_query = true,
            ARG_FD => {
                let Some(v) = it.next() else {
                    return Err(format!("{ARG_FD} 뒤에 fd 가 없습니다"));
                };
                match atoi(v) {
                    Some(fd) if fd > 2 => a.handover_fd = fd,
                    _ => {
                        return Err(format!(
                            "{ARG_FD} 의 값이 fd 가 아닙니다: {}",
                            strconv::quote(v)
                        ));
                    }
                }
            }
            other => return Err(format!("알 수 없는 데몬 인자: {other}")),
        }
    }
    Ok(a)
}

/// Go `strconv.Atoi`: 선택적 부호와 십진 숫자만 받는다(64비트 범위).
fn atoi(s: &str) -> Option<i64> {
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

#[cfg(test)]
mod tests;
