//! 계층별·항목별 검사의 보고 형식이다. `doctor` 와 `verify` 가 함께 딛는다 — 형식이 한 벌인 것이
//! 요구사항이다 (E2E_UNIFICATION_SRS FR-E2R-1).

use std::fmt::Display;
use std::io::Write;

pub(crate) struct CheckReport<'a> {
    out: &'a mut dyn Write,
    pub(crate) fail: usize,
    /// 실패 줄을 모은다. 사용자가 꼬리만 붙여도 답이 실리게 마지막에 다시 찍는다.
    pub(crate) bads: Vec<String>,
}

impl<'a> CheckReport<'a> {
    pub(crate) fn new(out: &'a mut dyn Write) -> Self {
        Self {
            out,
            fail: 0,
            bads: Vec::new(),
        }
    }

    pub(crate) fn ok(&mut self, line: impl Display) {
        let _ = writeln!(self.out, "  ✅ {line}");
    }

    pub(crate) fn info(&mut self, line: impl Display) {
        let _ = writeln!(self.out, "  ·  {line}");
    }

    pub(crate) fn bad(&mut self, line: impl Display) {
        let line = line.to_string();
        let _ = writeln!(self.out, "  ❌ {line}");
        self.bads.push(line);
        self.fail += 1;
    }

    pub(crate) fn section(&mut self, title: impl Display) {
        let _ = writeln!(self.out, "\n▶ {title}");
    }
}
