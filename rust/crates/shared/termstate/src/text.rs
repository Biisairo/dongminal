//! 화면 상태의 글자다 (read-screen, PERF FR-TRM-8, D-22).

use crate::{Row, Screen};

/// 줄 저장소를 거꾸로 읽는 한 번의 줄 수다.
const STORE_CHUNK: u64 = 256;

fn push_row(cur: &mut String, row: &Row) {
    for c in row.cells.iter().filter(|c| c.width != 0) {
        cur.push_str(&c.text);
    }
}

impl Screen {
    /// 화면과 그 위 기록의 글자다. 자동 줄바꿈으로 나뉜 행은 논리 줄 하나로 잇고, 줄 끝 공백과 마지막
    /// 내용 아래의 빈 줄은 버린다. 줄마다 `\n` 으로 끝난다. 대체 화면이면 그 화면만 낸다.
    /// `bytes` 가 0 보다 크면 끝의 `bytes` 바이트 안에서 글자 경계부터 낸다. 0 이면 전부다.
    pub fn text(&self, bytes: usize) -> String {
        let (_, rows) = self.size();
        let alt = self.modes().alt_screen;
        let hist = if alt { 0 } else { self.history_len() };
        let mut lines = Vec::new();
        let mut cur = String::new();
        let top = -i32::try_from(hist).unwrap_or(i32::MAX);
        for line in top..i32::from(rows) {
            let Some(row) = self.row(line) else { continue };
            push_row(&mut cur, &row);
            if !row.wrapped {
                lines.push(std::mem::take(&mut cur));
            }
        }
        if !cur.is_empty() {
            lines.push(cur);
        }
        for l in &mut lines {
            l.truncate(l.trim_end().len());
        }
        while lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        let mut size: usize = lines.iter().map(|l| l.len() + 1).sum();
        let mut older = Vec::new();
        if !alt {
            let store = self.store();
            let mut end = store.end();
            while end > store.first() && (bytes == 0 || size < bytes) {
                let from = end.saturating_sub(STORE_CHUNK).max(store.first());
                let count = usize::try_from(end - from).unwrap_or(0);
                let (_, got) = store.lines(from, count);
                for l in got.iter().rev() {
                    let t = l.text().trim_end();
                    size += t.len() + 1;
                    older.push(t.to_string());
                }
                end = from;
            }
        }
        let mut out = String::with_capacity(size);
        for l in older.iter().rev().chain(&lines) {
            out.push_str(l);
            out.push('\n');
        }
        if bytes > 0 && out.len() > bytes {
            let mut at = out.len() - bytes;
            while !out.is_char_boundary(at) {
                at += 1;
            }
            out.drain(..at);
        }
        out
    }
}
