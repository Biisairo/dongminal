//! 데몬이 도구마다 한 벌 드는 화면 상태다 (PERF SRS FR-TRM-1·7, D-13).
//!
//! 에뮬레이터(`alacritty_terminal =0.26.0`)는 `emu` 모듈 밖으로 나오지 않는다. 바깥에는 이 파일의
//! 값 타입과 [`Screen`] 만 보인다. 답장 사건(DA·DSR 등의 `PtyWrite`)은 어디에도 쓰지 않는다.

mod emu;
mod hist;
mod scan;
mod snap;

pub use emu::{EMU_KEEP, Screen};
pub use otter_shared_linestore::DEFAULT_CAP as HISTORY_CAP;

/// [`Screen::snapshot`] 의 결과다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// 새 터미널에 넣을 ANSI 다.
    pub bytes: Vec<u8>,
    /// 끝나지 않은 시퀀스·UTF-8 글자의 바이트 수다. 이어지는 출력은 `end - back` 부터 보낸다.
    pub back: usize,
    /// 스냅숏에 실린 가장 오래된 기록 줄의 절대 번호(줄 저장소 번호)다. 위로 받기는 이 앞을 묻는다.
    pub first_line: u64,
}

/// 셀의 색이다. 16색 이름 색도 번호로 적는다(xterm.js 와 같은 꼴).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Color {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// 셀의 글자 속성이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Attrs(u16);

impl Attrs {
    pub const BOLD: Self = Self(1);
    pub const DIM: Self = Self(1 << 1);
    pub const ITALIC: Self = Self(1 << 2);
    pub const UNDERLINE: Self = Self(1 << 3);
    pub const INVERSE: Self = Self(1 << 4);
    pub const HIDDEN: Self = Self(1 << 5);
    pub const STRIKE: Self = Self(1 << 6);
    pub const DOUBLE_UNDERLINE: Self = Self(1 << 7);
    pub const UNDERCURL: Self = Self(1 << 8);
    pub const DOTTED_UNDERLINE: Self = Self(1 << 9);
    pub const DASHED_UNDERLINE: Self = Self(1 << 10);
    /// 밑줄 종류 모두다.
    pub const ANY_UNDERLINE: Self = Self(
        Self::UNDERLINE.0
            | Self::DOUBLE_UNDERLINE.0
            | Self::UNDERCURL.0
            | Self::DOTTED_UNDERLINE.0
            | Self::DASHED_UNDERLINE.0,
    );

    pub fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub fn intersects(self, other: Self) -> bool {
        self.0 & other.0 != 0
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    #[must_use]
    pub fn with(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

/// OSC 8 링크다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub id: String,
    pub uri: String,
}

/// 화면 또는 기록의 셀 하나다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cell {
    /// 바탕 글자와 결합 문자다. 빈칸과 넓은 글자의 뒤칸은 `" "` 이다.
    pub text: String,
    /// 0 = 버릴 칸(넓은 글자의 뒤칸, 넓은 글자가 다음 행으로 넘어가 비운 행 끝 칸), 1, 2.
    /// 행 끝 칸은 xterm.js 에서 폭 1 빈칸이다. 논리 줄을 합칠 때 가짜 빈칸이 끼지 않게 0 으로 낸다.
    pub width: u8,
    pub fg: Color,
    pub bg: Color,
    pub attrs: Attrs,
    /// 밑줄 색이다. 정하지 않았으면 `Default`.
    pub underline: Color,
    pub link: Option<Link>,
}

/// 행 하나다. `wrapped` 는 이 행이 자동 줄바꿈으로 다음 행에 이어진다는 뜻이다(논리 줄, D-28).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub cells: Vec<Cell>,
    pub wrapped: bool,
}

/// 커서 자리(화면 기준, 0부터)와 보임이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub col: u16,
    pub row: u16,
    pub visible: bool,
}

/// 마우스 추적 방식이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseMode {
    #[default]
    None,
    /// 1000
    Click,
    /// 1002
    Drag,
    /// 1003
    Motion,
}

/// 앱이 켠 터미널 모드다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modes {
    pub alt_screen: bool,
    pub show_cursor: bool,
    pub app_cursor: bool,
    pub app_keypad: bool,
    pub bracketed_paste: bool,
    pub focus_report: bool,
    pub mouse: MouseMode,
    pub sgr_mouse: bool,
    pub utf8_mouse: bool,
    pub alternate_scroll: bool,
    pub origin: bool,
    pub autowrap: bool,
    pub insert: bool,
    pub line_feed_new_line: bool,
}

#[cfg(test)]
mod snap_tests;
#[cfg(test)]
mod tests;
