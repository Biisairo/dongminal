//! 줄 저장소 검색 — 찾기 줄의 "이전 기록에서 찾기"(PERF D-21). 브라우저 버퍼 위(앵커 앞)의 줄만 찾는다.

use otter_shared_linestore::BLOCK_LINES;
use regex::{Regex, RegexBuilder};

use crate::Tool;

/// 찾은 줄 글자를 이만큼(글자 수)까지만 싣는다.
pub const HIT_TEXT_MAX: usize = 512;

/// 찾기 줄의 선택지(정규식·대소문자·낱말)를 담은 검색어다.
pub struct Query {
    re: Regex,
    word: bool,
}

/// 일치 하나다. `col` 은 줄 글자에서 일치가 시작하는 글자(코드 포인트) 자리다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub line: u64,
    pub col: usize,
    pub text: String,
}

impl Query {
    /// 정규식이 아니면 글자 그대로 찾는다. 깨진 정규식은 오류다.
    pub fn new(pattern: &str, regex: bool, case: bool, word: bool) -> Result<Self, regex::Error> {
        let p = if regex {
            pattern.to_owned()
        } else {
            regex::escape(pattern)
        };
        let re = RegexBuilder::new(&p).case_insensitive(!case).build()?;
        Ok(Self { re, word })
    }

    /// 첫 일치의 바이트 자리다. 낱말 단위면 앞뒤가 낱말 글자가 아닌 일치만 센다.
    fn find(&self, text: &str) -> Option<usize> {
        self.re
            .find_iter(text)
            .find(|m| {
                !self.word
                    || (!text[..m.start()].chars().next_back().is_some_and(is_word)
                        && !text[m.end()..].chars().next().is_some_and(is_word))
            })
            .map(|m| m.start())
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl Tool {
    /// 줄 저장소에서 번호 `before` 앞의 줄을 새 줄부터 찾아 `limit` 개까지 준다. 블록 하나씩 잠그므로 찾는 동안
    /// 출력 공급을 오래 막지 않는다. 터미널이 없는 도구는 `None` 이다.
    pub fn search(&self, q: &Query, before: u64, limit: usize) -> Option<Vec<SearchHit>> {
        let mut hits = Vec::new();
        let mut stop = self.with_screen(|s, _| before.min(s.store().end()))?;
        while hits.len() < limit {
            let from = stop.saturating_sub(BLOCK_LINES as u64);
            let Some((start, lines)) =
                self.with_screen(|s, _| s.store().lines(from, (stop - from) as usize))
            else {
                break;
            };
            if lines.is_empty() {
                break;
            }
            for (i, l) in lines.iter().enumerate().rev() {
                if let Some(b) = q.find(l.text()) {
                    hits.push(SearchHit {
                        line: start + i as u64,
                        col: l.text()[..b].chars().count(),
                        text: l.text().chars().take(HIT_TEXT_MAX).collect(),
                    });
                    if hits.len() == limit {
                        break;
                    }
                }
            }
            if start == 0 || start >= stop {
                break;
            }
            stop = start;
        }
        Some(hits)
    }
}
