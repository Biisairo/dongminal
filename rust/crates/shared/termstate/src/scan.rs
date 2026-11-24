//! 에뮬레이터 파서(vte 0.15)와 같은 걸음으로 바이트를 훑는다. alacritty 가 공개하지 않는 것 셋을 따라간다.
//!
//! - 끝나지 않은 시퀀스·UTF-8 바이트([`Scan::pending`]) (분할점이 시퀀스 한가운데인 경우, M2 §4 HIGH 위험).
//!   끝나지 않은 바이트는 화면을 바꾸지 않았으므로, 스냅숏의 오프셋을 그 앞([`Scan::rewind`])으로 물려
//!   받는 쪽이 온전한 바이트를 받게 한다. 시퀀스 안에서 C0 가 이미 실행됐으면(물리면 두 번 실행된다)
//!   물리지 않고 끝나지 않은 바이트를 스냅숏 끝에 그대로 붙인다. 이때 실행된 C0 는 넣지 않는다.
//! - 스크롤 영역(DECSTBM)과 SO/SI.
//!
//! 상태 전이는 vte 0.15 `Parser` 의 표를 그대로 옮겼다. 판을 올리면 분할점 시험을 다시 돌린다.

/// 끝나지 않은 시퀀스를 이만큼까지만 들고 있는다(끝나지 않는 OSC 로 메모리가 자라지 않게).
const PENDING_MAX: usize = 64 << 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
    #[default]
    Ground,
    Escape,
    EscapeIntermediate,
    Csi,
    DcsEntry,
    DcsPassthrough,
    Osc,
    SosPmApc,
}

#[derive(Debug, Default)]
pub(crate) struct Scan {
    state: State,
    pending: Vec<u8>,
    /// `pending` 을 물려 다시 보내도 되는가(그 사이 실행된 C0 가 없고 잘리지 않았다).
    rewindable: bool,
    /// DECSTBM `(top, bottom)` — 1부터, 둘 다 포함. `None` 은 화면 전체다.
    region: Option<(u16, u16)>,
    /// SO 로 G1 을 쓰는 중이다.
    shift_out: bool,
    /// 지난번 [`Scan::take_history_cleared`] 뒤로 ED3(CSI 3 J) 이나 RIS 가 왔다.
    history_cleared: bool,
}

const CAN: u8 = 0x18;
const SUB: u8 = 0x1A;
const ESC: u8 = 0x1B;

fn is_exec(b: u8) -> bool {
    matches!(b, 0x00..=0x17 | 0x19 | 0x1C..=0x1F)
}

impl Scan {
    pub(crate) fn pending(&self) -> &[u8] {
        &self.pending
    }

    /// 스냅숏 오프셋을 물릴 바이트 수다. 0 이면 [`Scan::pending`] 을 스냅숏 끝에 붙인다.
    pub(crate) fn rewind(&self) -> usize {
        if self.rewindable {
            self.pending.len()
        } else {
            0
        }
    }

    pub(crate) fn in_ground(&self) -> bool {
        self.state == State::Ground
    }

    pub(crate) fn region(&self) -> Option<(u16, u16)> {
        self.region
    }

    pub(crate) fn shift_out(&self) -> bool {
        self.shift_out
    }

    /// 기록을 지우는 시퀀스가 왔는지 읽고 지운다.
    pub(crate) fn take_history_cleared(&mut self) -> bool {
        std::mem::take(&mut self.history_cleared)
    }

    /// 크기가 바뀌면 alacritty 는 스크롤 영역을 화면 전체로 되돌린다.
    pub(crate) fn resized(&mut self) {
        self.region = None;
    }

    pub(crate) fn feed(&mut self, bytes: &[u8], rows: u16) {
        for &b in bytes {
            self.step(b, rows);
        }
    }

    fn push(&mut self, b: u8) {
        if self.pending.len() < PENDING_MAX {
            self.pending.push(b);
        } else {
            self.rewindable = false;
        }
    }

    fn enter_ground(&mut self) {
        self.state = State::Ground;
        self.pending.clear();
        self.rewindable = true;
    }

    fn exec(&mut self, b: u8) {
        if !self.pending.is_empty() {
            self.rewindable = false;
        }
        match b {
            0x0E => self.shift_out = true,
            0x0F => self.shift_out = false,
            _ => {}
        }
    }

    fn enter_escape(&mut self) {
        self.state = State::Escape;
        self.pending.clear();
        self.pending.push(ESC);
        self.rewindable = true;
    }

    /// CAN·SUB·ESC 는 어느 상태에서나 같다.
    fn anywhere(&mut self, b: u8) {
        match b {
            CAN | SUB => {
                self.exec(b);
                self.enter_ground();
            }
            ESC => self.enter_escape(),
            _ => {}
        }
    }

    fn step(&mut self, b: u8, rows: u16) {
        match self.state {
            State::Ground => self.ground(b),
            State::Escape => self.escape(b),
            State::EscapeIntermediate => match b {
                _ if is_exec(b) => self.exec(b),
                0x20..=0x2F => self.push(b),
                0x30..=0x7E => self.esc_dispatch(b),
                0x7F => {}
                _ => self.anywhere(b),
            },
            State::Csi => match b {
                _ if is_exec(b) => self.exec(b),
                0x20..=0x3F => self.push(b),
                0x40..=0x7E => self.csi_dispatch(b, rows),
                0x7F => {}
                _ => self.anywhere(b),
            },
            // 인자·중간 글자·무시 상태를 하나로 둔다. 어느 쪽이든 ESC·CAN·SUB 로만 끝난다.
            State::DcsEntry => match b {
                _ if is_exec(b) || b == 0x7F => {}
                0x20..=0x3F => self.push(b),
                0x40..=0x7E => {
                    self.push(b);
                    self.state = State::DcsPassthrough;
                }
                _ => self.anywhere(b),
            },
            State::SosPmApc => self.anywhere(b),
            State::DcsPassthrough => match b {
                CAN | SUB | ESC => self.anywhere(b),
                0x00..=0x7E => self.push(b),
                0x9C => self.enter_ground(),
                _ => {}
            },
            State::Osc => match b {
                0x07 => self.enter_ground(),
                CAN | SUB | ESC => self.anywhere(b),
                _ => self.push(b),
            },
        }
    }

    fn ground(&mut self, b: u8) {
        if b == ESC {
            self.enter_escape();
            return;
        }
        if self.pending.is_empty() {
            if b < 0x80 {
                self.exec(b);
            } else {
                self.utf8(b);
            }
            return;
        }
        self.utf8(b);
    }

    /// 바닥 상태의 UTF-8 이어 읽기다. 끝나지 않은 글자만 남긴다. 잘못된 바이트는 vte 처럼 버린다.
    fn utf8(&mut self, b: u8) {
        self.pending.push(b);
        match std::str::from_utf8(&self.pending) {
            Ok(_) => self.enter_ground(),
            Err(e) if e.error_len().is_none() => self.rewindable = true,
            Err(_) => {
                self.enter_ground();
                if b < 0x80 {
                    self.exec(b);
                }
            }
        }
    }

    fn escape(&mut self, b: u8) {
        match b {
            _ if is_exec(b) => self.exec(b),
            0x20..=0x2F => {
                self.push(b);
                self.state = State::EscapeIntermediate;
            }
            b'P' => {
                self.push(b);
                self.state = State::DcsEntry;
            }
            b'X' | b'^' | b'_' => {
                self.push(b);
                self.state = State::SosPmApc;
            }
            b'[' => {
                self.push(b);
                self.state = State::Csi;
            }
            b']' => {
                self.push(b);
                self.state = State::Osc;
            }
            0x30..=0x7E => self.esc_dispatch(b),
            CAN | SUB => self.anywhere(b),
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, b: u8) {
        // RIS: ESC c (가운데 글자 없음).
        if b == b'c' && self.pending == [ESC] {
            self.region = None;
            self.shift_out = false;
            self.history_cleared = true;
        }
        self.enter_ground();
    }

    fn csi_dispatch(&mut self, b: u8, rows: u16) {
        if b == b'r' {
            self.decstbm(rows);
        }
        if b == b'J' && self.pending.get(2..) == Some(b"3".as_slice()) {
            self.history_cleared = true;
        }
        self.enter_ground();
    }

    /// alacritty `set_scrolling_region` 과 같다. `pending` 은 `ESC [ 인자` 다.
    fn decstbm(&mut self, rows: u16) {
        let Some(args) = self.pending.get(2..) else {
            return;
        };
        if !args.iter().all(|c| c.is_ascii_digit() || *c == b';') {
            return;
        }
        let mut it = std::str::from_utf8(args).unwrap_or("").split(';');
        let num = |s: Option<&str>| s.and_then(|v| v.parse::<u32>().ok()).filter(|v| *v != 0);
        let top = num(it.next()).unwrap_or(1);
        let bottom = num(it.next()).unwrap_or(u32::from(rows));
        if top >= bottom {
            return;
        }
        let rows32 = u32::from(rows);
        let start = (top - 1).min(rows32);
        let end = bottom.min(rows32);
        self.region = if start == 0 && end == rows32 {
            None
        } else {
            Some((
                u16::try_from(start + 1).unwrap_or(u16::MAX),
                u16::try_from(end).unwrap_or(u16::MAX),
            ))
        };
    }
}
