//! 터미널 모드의 추적과 복원 (TERMINAL_MODE_RESTORE_SRS 묶음 M·R).

use serde::{Deserialize, Serialize};

use crate::classify_esc;

const MODE_BRACKETED_PASTE: i64 = 2004;
const MODE_FOCUS_EVENT: i64 = 1004;
/// 대체 화면 신호다 (FR-TRS-18b). 관측만 하고 복원하지 않는다.
const ALT_SCREEN_MODES: [i64; 3] = [1049, 47, 1047];
const MOUSE_PROTOCOLS: [i64; 4] = [9, 1000, 1002, 1003];
const MOUSE_ENCODINGS: [i64; 3] = [1005, 1006, 1015];
/// 터무니없이 긴 수는 우리 것이 아니다.
const MAX_PARAM: i64 = 1 << 20;

/// 읽기 경계에 걸친 시퀀스의 이월 상한이다 (FR-TMR-6).
pub const MODE_MAX_CARRY: usize = 64;

/// 앱이 켜 둔 모드다. 기본값은 전부 꺼짐이다.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "toolhub.TermModes")]
pub struct TermModes {
    #[serde(rename = "bracketedPaste")]
    pub bracketed_paste: bool,
    /// `9`·`1000`·`1002`·`1003` 중 하나. 0 이면 없음.
    #[serde(rename = "mouseProtocol")]
    pub mouse_protocol: i64,
    /// `1005`·`1006`·`1015` 중 하나. 0 이면 기본.
    #[serde(rename = "mouseEncoding")]
    pub mouse_encoding: i64,
    #[serde(rename = "focusEvent")]
    pub focus_event: bool,
    /// 대체 화면 안인지다. 복원하지 않는다.
    #[serde(rename = "altScreen")]
    pub alt_screen: bool,
}

impl TermModes {
    /// 켜진 모드를 다시 세우는 바이트다 (FR-TMR-20·22·23). 프로토콜 → 인코딩 → 나머지.
    pub fn restore_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut set = |n: i64| out.extend_from_slice(format!("\x1b[?{n}h").as_bytes());
        if self.mouse_protocol != 0 {
            set(self.mouse_protocol);
        }
        if self.mouse_encoding != 0 {
            set(self.mouse_encoding);
        }
        if self.bracketed_paste {
            set(MODE_BRACKETED_PASTE);
        }
        if self.focus_event {
            set(MODE_FOCUS_EVENT);
        }
        out
    }

    /// 원자값(`AtomicU64`)으로 나르기 위한 포장이다 (FR-TMR-7). 0 은 전부 꺼짐이다.
    pub fn pack(&self) -> u64 {
        let mut v =
            u64::from(self.mouse_protocol as u16) | u64::from(self.mouse_encoding as u16) << 16;
        if self.bracketed_paste {
            v |= 1 << 32;
        }
        if self.focus_event {
            v |= 1 << 33;
        }
        if self.alt_screen {
            v |= 1 << 34;
        }
        v
    }

    pub fn unpack(v: u64) -> Self {
        Self {
            bracketed_paste: v & (1 << 32) != 0,
            mouse_protocol: i64::from(v as u16),
            mouse_encoding: i64::from((v >> 16) as u16),
            focus_event: v & (1 << 33) != 0,
            alt_screen: v & (1 << 34) != 0,
        }
    }
}

/// 청크마다 모드 설정을 관측하는 상태(이월)다. PTY 읽기 스레드 하나가 쥔다.
#[derive(Debug, Default)]
pub struct ModeObserver {
    carry: Vec<u8>,
    scratch: Vec<u8>,
}

impl ModeObserver {
    /// 청크를 관측해 cur 에서 바뀐 모드를 돌려준다.
    pub fn observe(&mut self, cur: TermModes, chunk: &[u8]) -> TermModes {
        self.observe_classified(cur, chunk, classify_esc(chunk, false).modes)
    }

    /// 청크 분류(`classify_esc(..).modes`)를 받는 `observe` 다 (FR-OPT-3-2).
    pub fn observe_classified(&mut self, cur: TermModes, chunk: &[u8], need: bool) -> TermModes {
        if self.carry.is_empty() && !need {
            return cur;
        }
        let (next, carry) = if self.carry.is_empty() {
            scan_modes(chunk, cur)
        } else {
            self.scratch.clear();
            self.scratch.extend_from_slice(&self.carry);
            self.scratch.extend_from_slice(chunk);
            scan_modes(&self.scratch, cur)
        };
        self.carry = carry.unwrap_or_default();
        next
    }
}

/// 청크의 DEC private mode 설정을 나오는 순서대로 적용한다 (FR-TMR-1·3). 둘째 값은 다음
/// 청크에 이어 붙일 꼬리다 (FR-TMR-6).
pub fn scan_modes(scan: &[u8], mut cur: TermModes) -> (TermModes, Option<Vec<u8>>) {
    let mut params = Vec::with_capacity(8);
    let mut i = 0;
    while i < scan.len() {
        let Some(j) = scan[i..].iter().position(|&c| c == 0x1b) else {
            return (cur, None);
        };
        let start = i + j;
        match parse_private_mode(&scan[start..], &mut params) {
            Parse::Ok { on, end } => {
                for &n in &params {
                    cur = apply_mode(cur, n, on);
                }
                i = start + end;
            }
            Parse::Incomplete if scan.len() - start < MODE_MAX_CARRY => {
                return (cur, Some(scan[start..].to_vec()));
            }
            _ => i = start + 1,
        }
    }
    (cur, None)
}

/// 출력 b 의 앞머리가 대체 화면 안이었는지다 (FR-TRS-10a). 전환이 없으면 alt_now.
pub fn alt_screen_at_head(b: &[u8], alt_now: bool) -> bool {
    let mut params = Vec::with_capacity(8);
    let mut i = 0;
    while i < b.len() {
        let Some(j) = b[i..].iter().position(|&c| c == 0x1b) else {
            break;
        };
        let start = i + j;
        let Parse::Ok { on, end } = parse_private_mode(&b[start..], &mut params) else {
            i = start + 1;
            continue;
        };
        if params.iter().any(|n| ALT_SCREEN_MODES.contains(n)) {
            return !on;
        }
        i = start + end;
    }
    alt_now
}

enum Parse {
    Ok {
        on: bool,
        end: usize,
    },
    /// 아직 끝나지 않았다 — 이월 대상이다.
    Incomplete,
    /// 우리가 찾는 모양이 아니다.
    Other,
}

/// `ESC[?<n>[;<n>…]<h|l>` 하나를 읽는다. 파라미터는 params 에 담는다.
fn parse_private_mode(b: &[u8], params: &mut Vec<i64>) -> Parse {
    params.clear();
    if b.len() < 3 {
        return if b"\x1b[?".starts_with(b) {
            Parse::Incomplete
        } else {
            Parse::Other
        };
    }
    if b[1] != b'[' || b[2] != b'?' {
        return Parse::Other;
    }
    let mut n: i64 = 0;
    let mut seen = false;
    for (i, &c) in b.iter().enumerate().skip(3) {
        match c {
            b'0'..=b'9' => {
                n = n * 10 + i64::from(c - b'0');
                seen = true;
                if n > MAX_PARAM {
                    return Parse::Other;
                }
            }
            b';' => {
                params.push(n);
                n = 0;
                seen = false;
            }
            b'h' | b'l' => {
                if seen || !params.is_empty() {
                    params.push(n);
                }
                if params.is_empty() {
                    return Parse::Other;
                }
                return Parse::Ok {
                    on: c == b'h',
                    end: i + 1,
                };
            }
            _ => return Parse::Other,
        }
    }
    Parse::Incomplete
}

/// 설정 하나를 적용한다. 관심 밖이면 그대로다 (FR-TMR-5). 갈래의 끄기는 갈래를 비운다 (FR-TMR-4).
fn apply_mode(mut m: TermModes, n: i64, on: bool) -> TermModes {
    if n == MODE_BRACKETED_PASTE {
        m.bracketed_paste = on;
    } else if n == MODE_FOCUS_EVENT {
        m.focus_event = on;
    } else if MOUSE_PROTOCOLS.contains(&n) {
        m.mouse_protocol = if on { n } else { 0 };
    } else if ALT_SCREEN_MODES.contains(&n) {
        m.alt_screen = on;
    } else if MOUSE_ENCODINGS.contains(&n) {
        m.mouse_encoding = if on { n } else { 0 };
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modes_after(chunks: &[&str]) -> TermModes {
        let mut o = ModeObserver::default();
        let mut m = TermModes::default();
        for c in chunks {
            m = o.observe(m, c.as_bytes());
        }
        m
    }

    #[test]
    fn bundled_params() {
        let m = modes_after(&["\x1b[?1002;1006h"]);
        assert_eq!((m.mouse_protocol, m.mouse_encoding), (1002, 1006));
    }

    #[test]
    fn last_protocol_wins() {
        assert_eq!(
            modes_after(&["\x1b[?1002h", "\x1b[?1003h"]).mouse_protocol,
            1003
        );
        assert_eq!(
            modes_after(&["\x1b[?1006h", "\x1b[?1015h"]).mouse_encoding,
            1015
        );
    }

    #[test]
    fn any_reset_clears_group() {
        assert_eq!(
            modes_after(&["\x1b[?1002h", "\x1b[?1000l"]).mouse_protocol,
            0
        );
        assert_eq!(
            modes_after(&["\x1b[?1006h", "\x1b[?1005l"]).mouse_encoding,
            0
        );
        assert!(!modes_after(&["\x1b[?2004h", "\x1b[?2004l"]).bracketed_paste);
    }

    #[test]
    fn ignores_others() {
        let m = modes_after(&["\x1b[?2004h", "\x1b[?25h", "\x1b[?1049h", "\x1b[?7l"]);
        assert!(m.bracketed_paste);
        assert_eq!(
            (m.mouse_protocol, m.mouse_encoding, m.focus_event),
            (0, 0, false)
        );
    }

    #[test]
    fn split_across_reads() {
        let full = "\x1b[?1000;1002;1003;1006h";
        for cut in 1..full.len() {
            let m = modes_after(&[&full[..cut], &full[cut..]]);
            assert_eq!(
                (m.mouse_protocol, m.mouse_encoding),
                (1003, 1006),
                "cut={cut}"
            );
        }
    }

    #[test]
    fn restore_bytes() {
        let m = TermModes {
            bracketed_paste: true,
            mouse_protocol: 1002,
            mouse_encoding: 1006,
            focus_event: true,
            alt_screen: false,
        };
        assert_eq!(
            m.restore_bytes(),
            b"\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h"
        );
        assert!(TermModes::default().restore_bytes().is_empty());
    }

    #[test]
    fn restore_round_trips() {
        let want = TermModes {
            bracketed_paste: true,
            mouse_protocol: 1003,
            mouse_encoding: 1015,
            focus_event: true,
            alt_screen: false,
        };
        let restored = String::from_utf8(want.restore_bytes()).unwrap();
        assert_eq!(modes_after(&[&restored]), want);
        assert_eq!(TermModes::unpack(want.pack()), want);
    }

    #[test]
    fn alt_screen_observed_not_restored() {
        for n in ["\x1b[?1049h", "\x1b[?47h", "\x1b[?1047h"] {
            assert!(modes_after(&[n]).alt_screen, "{n:?}");
        }
        assert!(!modes_after(&["\x1b[?1049h", "\x1b[?1049l"]).alt_screen);
        let m = TermModes {
            alt_screen: true,
            bracketed_paste: true,
            ..Default::default()
        };
        assert_eq!(m.restore_bytes(), b"\x1b[?2004h");
    }

    #[test]
    fn alt_screen_at_head_cases() {
        assert!(alt_screen_at_head(b"x\x1b[?1049lprompt", false));
        assert!(!alt_screen_at_head(b"x\x1b[?1049hvim", true));
        assert!(alt_screen_at_head(b"plain", true));
    }
}
