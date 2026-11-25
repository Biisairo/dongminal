//! 도구 주의 탐지(PANE_ATTENTION_NOTIFY_SRS)의 순수 부분: L1 알림 시퀀스·cwd 보고 탐지와 공통 상수.

use std::time::Duration;

use otter_gocompat::json;
use otter_shared_activity as activity;
use otter_shared_otterenv as otterenv;
use serde::{Deserialize, Serialize};

/// 읽기 경계에 걸친 끝나지 않은 OSC 조각의 이월 상한이다. 넘으면 버린다.
pub const ATTN_MAX_CARRY: usize = 512;
/// L2 유휴 임계값의 기본이다. 0 은 끄기다 (사용자 결정 `U-24`).
const ATTN_DEFAULT_IDLE_MS: u64 = 0;
pub use otter_shared_cadence::ATTENTION_SWEEP_EVERY as ATTENTION_SWEEP_INTERVAL;
/// 활동 보고 `working` 을 믿어 주는 기한(unix-nanos)이다 (FR-ATF-10·AS-1). 5분.
pub const ATTN_WORKING_STALE: i64 = 5 * 60 * 1_000_000_000;

/// L2 유휴 임계값: `OTTERMINAL_ATTENTION_IDLE_MS` 또는 기본값. 0 은 끄기다.
pub fn attention_idle_threshold() -> Duration {
    otterenv::millis_env(
        otterenv::ENV_ATTENTION_IDLE_MS,
        Duration::from_millis(ATTN_DEFAULT_IDLE_MS),
        0,
    )
}

/// 맨 BEL 을 주의 신호로 칠지다. 기본은 끔이다 (FR-HPR-17).
pub fn attention_allow_bell() -> bool {
    otterenv::flag_env(otterenv::ENV_ATTENTION_BELL)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.ActivityState")]
pub struct ActivityState {
    pub state: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub tool: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub detail: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.ActivitySnap")]
pub struct ActivitySnap {
    #[serde(rename = "toolId")]
    pub tool_id: String,
    pub state: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub tool: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub detail: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

/// 에이전트가 일한다고 말했고 그 말이 믿을 만큼 최근인가다 (FR-ATF-10·12). now 는 unix-nanos.
pub fn activity_still_working(a: Option<&ActivityState>, now: i64) -> bool {
    a.is_some_and(|a| a.state == activity::WORKING && now - a.updated_at < ATTN_WORKING_STALE)
}

fn index_byte(b: &[u8], c: u8) -> Option<usize> {
    b.iter().position(|&x| x == c)
}

/// b(이전 이월을 앞에 붙인 것)에서 알림 시퀀스(OSC 9·99·777;notify, allow_bell 이면 맨 BEL)를 찾는다.
/// 신호 여부와 다음 청크에 붙일 이월(끝나지 않은 꼬리, max_carry 를 넘으면 버린다)을 돌려준다.
pub fn detect_attention_signal(
    b: &[u8],
    allow_bell: bool,
    max_carry: usize,
) -> (bool, Option<Vec<u8>>) {
    let n = b.len();
    let mut i = 0;
    let mut bel = if allow_bell {
        index_byte(b, 0x07)
    } else {
        None
    };
    while i < n {
        if let Some(p) = bel
            && p < i
        {
            bel = index_byte(&b[i..], 0x07).map(|k| i + k);
        }
        let esc = index_byte(&b[i..], 0x1b).map(|k| i + k);
        if let Some(p) = bel
            && esc.is_none_or(|e| p < e)
        {
            return (true, None);
        }
        let Some(e) = esc else {
            return (false, None);
        };
        i = e;
        if i + 1 >= n {
            return (false, bounded_carry(&b[i..], max_carry));
        }
        if b[i + 1] == b']' {
            let Some((end, term_len)) = find_osc_terminator(b, i + 2) else {
                return (false, bounded_carry(&b[i..], max_carry));
            };
            if is_attention_osc(&b[i + 2..end]) {
                return (true, None);
            }
            i = end + term_len;
        } else {
            i += 2;
        }
    }
    (false, None)
}

/// 셸 훅의 cwd 보고(`ESC ] 777 ; Cwd ; <경로>`, BEL 또는 ST)를 읽는다. 마지막 것이 이긴다. 없으면 "".
pub fn detect_cwd_report(b: &[u8]) -> String {
    const MARKER: &[u8] = b"777;Cwd;";
    let mut out: &[u8] = b"";
    let (mut i, n) = (0, b.len());
    while i < n {
        let Some(j) = index_byte(&b[i..], 0x1b) else {
            break;
        };
        i += j;
        if i + 1 >= n || b[i + 1] != b']' {
            i += 1;
            continue;
        }
        let Some((end, term_len)) = find_osc_terminator(b, i + 2) else {
            break;
        };
        if let Some(v) = b[i + 2..end].strip_prefix(MARKER)
            && !v.is_empty()
        {
            out = v;
        }
        i = end + term_len;
    }
    String::from_utf8_lossy(out).into_owned()
}

/// from 이후 OSC 종결자(BEL=1, ST "ESC \"=2)의 자리와 길이. 끝나지 않았으면 None.
fn find_osc_terminator(b: &[u8], from: usize) -> Option<(usize, usize)> {
    for k in from..b.len() {
        match b[k] {
            0x07 => return Some((k, 1)),
            0x1b => {
                return (k + 1 < b.len() && b[k + 1] == b'\\').then_some((k, 2));
            }
            _ => {}
        }
    }
    None
}

fn is_attention_osc(body: &[u8]) -> bool {
    let (id, rest): (&[u8], &[u8]) = match index_byte(body, b';') {
        Some(s) => (&body[..s], &body[s + 1..]),
        None => (body, b""),
    };
    match id {
        b"99" => true,
        // ConEmu 확장(첫 필드가 숫자뿐)은 제어 명령이다 (HOST_PARITY_SRS FR-HPR-1·2).
        b"9" => !is_conemu_extension(rest),
        b"777" => {
            let sub = index_byte(rest, b';').map_or(rest, |j| &rest[..j]);
            sub == b"notify"
        }
        _ => false,
    }
}

fn is_conemu_extension(rest: &[u8]) -> bool {
    let head = index_byte(rest, b';').map_or(rest, |i| &rest[..i]);
    !head.is_empty() && head.iter().all(u8::is_ascii_digit)
}

fn bounded_carry(frag: &[u8], max_carry: usize) -> Option<Vec<u8>> {
    (frag.len() <= max_carry).then(|| frag.to_vec())
}

/// 청크에 관측할 거리가 있는지다 (FR-OPT-3-2). 거짓이면 그 탐지기는 이월 없이 건너뛸 수 있다.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EscClass {
    /// ESC ] · 끝의 ESC · (allow_bell 이면) BEL — 주의·cwd 탐지기.
    pub osc: bool,
    /// ESC [ ? · 끝의 ESC · 끝의 ESC [ — 모드 탐지기.
    pub modes: bool,
}

/// 청크의 ESC 를 한 번 훑어 두 탐지기가 돌아야 하는지 가른다.
pub fn classify_esc(b: &[u8], allow_bell: bool) -> EscClass {
    let mut c = EscClass {
        osc: allow_bell && index_byte(b, 0x07).is_some(),
        modes: false,
    };
    let mut i = 0;
    while i < b.len() {
        let Some(j) = index_byte(&b[i..], 0x1b) else {
            return c;
        };
        i += j;
        if i + 1 >= b.len() {
            c.osc = true;
            c.modes = true;
        } else if b[i + 1] == b']' {
            c.osc = true;
        } else if b[i + 1] == b'[' && (i + 2 >= b.len() || b[i + 2] == b'?') {
            c.modes = true;
        }
        if c.osc && c.modes {
            return c;
        }
        i += 1;
    }
    c
}

#[cfg(test)]
mod tests;
