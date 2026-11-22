//! Go 기준선 `dongminal/internal/helper/toolline` 의 Rust 포팅.
//!
//! dmctl 과 MCP(list_workspace / who_am_i)가 함께 쓰는 한 줄 출력 렌더러다
//! (DMCTL_WHO_AM_I_SRS FR-PL-1~3). 두 채널의 출력이 바이트 단위로 같아야 한다.

use std::fmt::Write;

use dm_gocompat::strconv::append_quote;

/// 한 줄의 필드다. 0·빈 값인 선택 열은 생략한다 (FR-PL-2).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Line {
    pub focus_marker: bool,
    pub label: String,
    pub uuid: String,
    pub short: String,
    pub tool_id: String,
    pub shell_pid: i64,
    pub size_cols: i64,
    pub size_rows: i64,
    pub window: String,
    pub tab: String,
    pub window_uuid: String,
    pub pane_uuid: String,
    /// FR-WGR-34 · FR-ORD-31.
    pub group: String,
    pub win_index: i64,
    pub win_count: i64,
    pub tab_index: i64,
    pub tab_count: i64,
}

impl Line {
    /// FR-PL-1 의 표준 줄이다. 개행은 붙이지 않는다.
    pub fn render(&self) -> String {
        let mut b = String::new();
        b.push_str(if self.focus_marker { "▶ " } else { "  " });
        // String 에 쓰는 write! 는 실패하지 않는다.
        let _ = write!(b, "label={}", self.label);
        if !self.uuid.is_empty() {
            let _ = write!(b, "  uuid={}", self.uuid);
        }
        if !self.short.is_empty() {
            let _ = write!(b, "  short={}", self.short);
        }
        let _ = write!(b, "  toolId={}  shellPid={}", self.tool_id, self.shell_pid);
        if self.size_cols != 0 || self.size_rows != 0 {
            let _ = write!(b, "  size={}x{}", self.size_cols, self.size_rows);
        }
        b.push_str("  window=");
        append_quote(&mut b, &self.window);
        b.push_str("  tab=");
        append_quote(&mut b, &self.tab);
        if !self.window_uuid.is_empty() {
            let _ = write!(b, "  window_uuid={}", self.window_uuid);
        }
        if !self.pane_uuid.is_empty() {
            let _ = write!(b, "  pane_uuid={}", self.pane_uuid);
        }
        if !self.group.is_empty() {
            b.push_str("  group=");
            append_quote(&mut b, &self.group);
        }
        if self.win_count != 0 {
            let _ = write!(b, "  win_pos={}/{}", self.win_index, self.win_count);
        }
        if self.tab_count != 0 {
            let _ = write!(b, "  tab_pos={}/{}", self.tab_index, self.tab_count);
        }
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> String {
        v.to_owned()
    }

    // TC-PL-1
    #[test]
    fn render_full() {
        let l = Line {
            focus_marker: true,
            label: s("W1.P1.T1"),
            uuid: s("550e8400-e29b-41d4-a716-446655440003"),
            short: s("550e8400"),
            tool_id: s("12"),
            shell_pid: 12345,
            size_cols: 80,
            size_rows: 24,
            window: s("Main"),
            tab: s("Shell"),
            window_uuid: s("550e8400-e29b-41d4-a716-446655440001"),
            pane_uuid: s("550e8400-e29b-41d4-a716-446655440002"),
            ..Default::default()
        };
        let want = "▶ label=W1.P1.T1  uuid=550e8400-e29b-41d4-a716-446655440003  short=550e8400  toolId=12  shellPid=12345  size=80x24  window=\"Main\"  tab=\"Shell\"  window_uuid=550e8400-e29b-41d4-a716-446655440001  pane_uuid=550e8400-e29b-41d4-a716-446655440002";
        assert_eq!(l.render(), want);
    }

    // TC-PL-2
    #[test]
    fn render_omit_uuid_short() {
        let l = Line {
            label: s("W1.P1.T1"),
            tool_id: s("12"),
            shell_pid: 1,
            size_cols: 80,
            size_rows: 24,
            window: s("x"),
            tab: s("y"),
            ..Default::default()
        };
        assert_eq!(l.render(), "  label=W1.P1.T1  toolId=12  shellPid=1  size=80x24  window=\"x\"  tab=\"y\"");
    }

    // TC-PL-3
    #[test]
    fn render_omit_window_pane_uuid() {
        let l = Line {
            label: s("W1.P1.T1"),
            uuid: s("u"),
            short: s("s"),
            tool_id: s("1"),
            shell_pid: 2,
            size_cols: 1,
            size_rows: 2,
            window: s("a"),
            tab: s("b"),
            ..Default::default()
        };
        assert_eq!(l.render(), "  label=W1.P1.T1  uuid=u  short=s  toolId=1  shellPid=2  size=1x2  window=\"a\"  tab=\"b\"");
    }

    // TC-PL-4
    #[test]
    fn render_omit_zero_size() {
        let l = Line {
            label: s("L"),
            tool_id: s("1"),
            shell_pid: 1,
            window: s("a"),
            tab: s("b"),
            ..Default::default()
        };
        assert_eq!(l.render(), r#"  label=L  toolId=1  shellPid=1  window="a"  tab="b""#);
    }

    // TC-PL-5
    #[test]
    fn render_unfocused_marker() {
        let l = Line {
            label: s("L"),
            tool_id: s("1"),
            ..Default::default()
        };
        assert!(l.render().starts_with("  label="));
    }

    // TC-PL-6
    #[test]
    fn render_quote_escape() {
        let l = Line {
            label: s("L"),
            tool_id: s("1"),
            shell_pid: 1,
            window: s("a\"b"),
            tab: s("탭\n\u{202e}"),
            ..Default::default()
        };
        let got = l.render();
        assert!(got.contains(r#"window="a\"b""#), "{got}");
        assert!(got.contains("tab=\"탭\\n\\u202e\""), "{got}");
    }

    #[test]
    fn render_group_and_positions() {
        let l = Line {
            label: s("L"),
            tool_id: s("1"),
            window: s("w"),
            tab: s("t"),
            group: s("g 1"),
            win_index: 2,
            win_count: 3,
            tab_index: 1,
            tab_count: 4,
            ..Default::default()
        };
        assert_eq!(
            l.render(),
            "  label=L  toolId=1  shellPid=0  window=\"w\"  tab=\"t\"  group=\"g 1\"  win_pos=2/3  tab_pos=1/4"
        );
    }

    #[test]
    fn render_deterministic() {
        let l = Line {
            label: s("L"),
            uuid: s("u"),
            window_uuid: s("su"),
            pane_uuid: s("ru"),
            ..Default::default()
        };
        assert_eq!(l.render(), l.render());
    }
}
