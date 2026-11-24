//! 줄 저장소 (FR-TRM-2, NFR-PRF-10, D-14·D-28).
//!
//! 에뮬레이터 기록 상한을 넘은 줄을 받아 둔다. 줄은 감싼 행을 합친 논리 줄([`Line`])이고,
//! [`BLOCK_LINES`] 줄마다 deflate 한 블록으로 묶는다. 최근 블록 하나는 풀린 채로 둔다.
//! 줄마다 절대 줄 번호(저장소에 들어온 줄의 누적 수, 0 부터)가 붙는다. 지워도 번호는 이어 간다.

mod codec;
mod line;
mod split;

use std::collections::VecDeque;

pub use line::{Cell, Cells, Color, Line, LineBuilder, Link, Style, flags};
pub use split::split_for_rows;

/// 기본 상한(D-7, D-25 `termHistoryLines`).
pub const DEFAULT_CAP: usize = 50_000;
/// 블록 하나의 줄 수. 버릴 때도 이 단위로 버린다.
pub const BLOCK_LINES: usize = 256;

struct Block {
    first: u64,
    count: usize,
    data: Vec<u8>,
}

pub struct LineStore {
    cap: usize,
    blocks: VecDeque<Block>,
    hot: Vec<Line>,
    /// 가장 오래 남은 줄의 번호.
    first: u64,
    /// 다음에 들어올 줄의 번호.
    end: u64,
}

impl LineStore {
    /// `cap` 줄을 늘 남긴다. 넘으면 가장 오래된 블록부터 버리므로 실제로는 `cap + BLOCK_LINES` 줄 미만까지 든다.
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            blocks: VecDeque::new(),
            hot: Vec::with_capacity(BLOCK_LINES),
            first: 0,
            end: 0,
        }
    }

    pub fn cap(&self) -> usize {
        self.cap
    }

    pub fn first(&self) -> u64 {
        self.first
    }

    pub fn end(&self) -> u64 {
        self.end
    }

    pub fn len(&self) -> usize {
        (self.end - self.first) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.end == self.first
    }

    /// 줄 하나를 넣고 그 줄의 번호를 돌려준다.
    pub fn push(&mut self, line: Line) -> u64 {
        let no = self.end;
        self.hot.push(line);
        self.end += 1;
        if self.hot.len() >= BLOCK_LINES {
            let lines = std::mem::replace(&mut self.hot, Vec::with_capacity(BLOCK_LINES));
            self.blocks.push_back(Block {
                first: self.end - lines.len() as u64,
                count: lines.len(),
                data: codec::compress(&lines),
            });
        }
        self.trim();
        no
    }

    /// 상한을 바꾼다(D-25 `termHistoryLines`). 줄이면 넘는 블록을 곧바로 버리고, 올리면 그 뒤로 더 쌓는다.
    pub fn set_cap(&mut self, cap: usize) {
        self.cap = cap;
        self.trim();
    }

    fn trim(&mut self) {
        while let Some(b) = self.blocks.front() {
            if self.len() - b.count < self.cap {
                break;
            }
            self.first += b.count as u64;
            self.blocks.pop_front();
        }
    }

    /// 데몬 교체(D-27)로 넘길 그림이다. 블록과 절대 줄 번호를 그대로 담고, 풀린 블록은 압축해 담는다.
    pub fn export(&self) -> Vec<u8> {
        let hot = (!self.hot.is_empty()).then(|| codec::compress(&self.hot));
        let mut blocks: Vec<(u64, usize, &[u8])> = self
            .blocks
            .iter()
            .map(|b| (b.first, b.count, b.data.as_slice()))
            .collect();
        if let Some(h) = &hot {
            blocks.push((self.end - self.hot.len() as u64, self.hot.len(), h));
        }
        codec::write_image(self.first, self.end, &blocks)
    }

    /// [`export`](Self::export) 의 그림을 상한 `cap` 으로 되세운다. 형식이 다르거나 깨졌으면 `None` 이다.
    pub fn import(cap: usize, image: &[u8]) -> Option<Self> {
        let (first, end, raw) = codec::read_image(image)?;
        let mut s = Self::new(cap);
        s.first = first;
        s.end = end;
        s.blocks = raw
            .into_iter()
            .map(|(first, count, data)| Block { first, count, data })
            .collect();
        s.trim();
        Some(s)
    }

    /// ED3(기록 지우기). 줄은 모두 버리고 번호는 이어 간다.
    pub fn clear(&mut self) {
        self.blocks.clear();
        self.hot = Vec::with_capacity(BLOCK_LINES);
        self.first = self.end;
    }

    /// 번호 `from` 부터 `count` 줄. 남아 있는 구간 `[first, end)` 로 잘라, 실제 첫 번호와 줄을 돌려준다.
    pub fn lines(&self, from: u64, count: usize) -> (u64, Vec<Line>) {
        let start = from.max(self.first);
        let stop = from.saturating_add(count as u64).min(self.end);
        let mut out = Vec::with_capacity(stop.saturating_sub(start) as usize);
        let mut no = start;
        for b in &self.blocks {
            let b_end = b.first + b.count as u64;
            if no >= stop {
                break;
            }
            if b_end <= no {
                continue;
            }
            // 블록은 이 crate 가 만든 것만 든다. 풀리지 않으면 그 구간을 비운 채 넘어간다.
            let lines = codec::decompress(&b.data).unwrap_or_default();
            let lo = (no - b.first) as usize;
            let hi = ((stop.min(b_end)) - b.first) as usize;
            out.extend(lines.into_iter().take(hi).skip(lo));
            no = b_end.min(stop);
        }
        let hot_first = self.end - self.hot.len() as u64;
        if no < stop {
            let lo = (no.max(hot_first) - hot_first) as usize;
            let hi = (stop - hot_first) as usize;
            out.extend(self.hot[lo..hi].iter().cloned());
        }
        (start, out)
    }

    /// 저장소가 쥔 힙 바이트의 어림(압축 블록 + 풀린 블록).
    pub fn heap_bytes(&self) -> usize {
        self.blocks.iter().map(|b| b.data.capacity()).sum::<usize>()
            + self.blocks.capacity() * std::mem::size_of::<Block>()
            + self.hot.capacity() * std::mem::size_of::<Line>()
            + self.hot.iter().map(Line::heap_bytes).sum::<usize>()
    }
}

impl Default for LineStore {
    fn default() -> Self {
        Self::new(DEFAULT_CAP)
    }
}

#[cfg(test)]
mod tests;
