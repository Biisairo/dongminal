//! 계층별·항목별 검사의 보고 형식이다. `doctor` 와 `verify` 가 함께 딛는다 — 형식이 한 벌인 것이
//! 요구사항이다 (E2E_UNIFICATION_SRS FR-E2R-1).

use std::fmt::Display;
use std::io::Write;

pub(crate) struct CheckReport<'a> {
    out: &'a mut dyn Write,
    pub(crate) fail: usize,
    pub(crate) skip: usize,
    /// 실패 줄을 모은다. 사용자가 꼬리만 붙여도 답이 실리게 마지막에 다시 찍는다.
    pub(crate) bads: Vec<String>,
}

impl<'a> CheckReport<'a> {
    pub(crate) fn new(out: &'a mut dyn Write) -> Self {
        Self {
            out,
            fail: 0,
            skip: 0,
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

    /// 검사를 돌리지 않았음을 **남긴다** — 침묵과 구별되는 것이 요점이다 (FR-E2S-4).
    pub(crate) fn skipped(&mut self, name: &str, reason: &str) {
        let _ = writeln!(self.out, "  ⏭  {name} — {reason}");
        self.skip += 1;
    }

    /// 보고서가 쓰는 출력이다 — 요약처럼 형식 밖의 줄을 같은 자리에 쓴다.
    pub(crate) fn out(&mut self) -> &mut dyn Write {
        self.out
    }

    pub(crate) fn section(&mut self, title: impl Display) {
        let _ = writeln!(self.out, "\n▶ {title}");
    }
}
