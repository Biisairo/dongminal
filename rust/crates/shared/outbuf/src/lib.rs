//! Go 기준선 `dongminal/internal/shared/outbuf` 의 Rust 포팅.
//!
//! PTY writer 와 MCP/WS reader 를 잇는 단일 진입점 바운디드 버퍼다 (S4 SRS).
//!
//! - `feed` 는 블록되지 않는다. 짧은 잠금만 잡는다.
//! - 읽을 수 있는 것은 마지막 `max` 바이트다 (`snapshot`·`since`·`len`).
//! - `Stats::total_bytes_drop` 은 종전 compaction 의 계산을 따른다 — 보유량이 `2*max` 를
//!   넘을 때 `max` 를 넘는 분량을 한꺼번에 센다. `max`~`2*max` 구간의 넘침은 세지 않는다.
//! - 저장은 `max` 바이트 링이다 (FR-OPT-3-3). 작게 시작해 `max` 까지 자란다.

use std::sync::Mutex;

/// 첫 `feed` 가 잡는 최소 용량이다. 그 뒤로는 두 배씩 `max` 까지 자란다.
const STREAM_INIT_CAP: usize = 4 << 10;

/// [`Stream::snapshot`] 이 함께 주는 통계다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stats {
    pub total_bytes_in: i64,
    pub total_bytes_drop: i64,
    pub retained: usize,
}

#[derive(Default)]
struct Inner {
    /// 차기 전: 입력 순서 그대로. 찬 뒤(`full`): 길이 `max` 인 링.
    buf: Vec<u8>,
    /// 링에서 가장 오래된 바이트의 자리다 (`full` 일 때만 뜻이 있다).
    head: usize,
    full: bool,
    /// 종전 구현의 보유량(`2*max` 까지 자라다 `max` 로 줄던 길이)이다.
    vlen: usize,
    total_in: i64,
    total_drop: i64,
}

/// 바운디드 출력 버퍼다.
pub struct Stream {
    max: usize,
    inner: Mutex<Inner>,
}

impl Stream {
    /// 최대 유지 바이트 `max` 로 만든다. 버퍼는 미리 잡지 않는다.
    pub fn new(max: usize) -> Self {
        Self {
            max,
            inner: Mutex::new(Inner::default()),
        }
    }

    /// 넘겨받은 화면 내용과 누적 좌표로 되세운다 (FR-DSK-22). `data` 가 `max` 보다 길면
    /// 끝 쪽만 남긴다.
    pub fn restore(max: usize, data: &[u8], offset: i64) -> Self {
        let s = Self::new(max);
        let data = &data[data.len().saturating_sub(max)..];
        {
            let mut g = s.lock();
            g.write(max, data);
            g.vlen = data.len();
            g.total_in = offset;
        }
        s
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// PTY 출력 한 청크를 넣는다. 종전 compaction 규칙으로 센 소실 바이트 수와,
    /// 이 청크를 포함한 **누적 입력 바이트**(`end`, FR-TRS-1)를 돌려준다.
    /// `p` 는 보관하지 않는다 — 복사한다.
    pub fn feed(&self, p: &[u8]) -> (usize, i64) {
        let max = self.max;
        let mut g = self.lock();
        g.total_in += p.len() as i64;
        let end = g.total_in;
        g.vlen += p.len();
        let mut dropped = 0;
        if g.vlen > max && g.vlen > 2 * max {
            dropped = g.vlen - max;
            g.vlen = max;
            g.total_drop += dropped as i64;
        }
        g.write(max, p);
        (dropped, end)
    }

    /// 지금까지의 누적 입력 바이트다 (FR-TRS-1).
    pub fn offset(&self) -> i64 {
        self.lock().total_in
    }

    /// 절대 오프셋 `off` 이후의 바이트 사본이다 (FR-TRS-2). `None` 은 "재개할 수 없다"
    /// 이고 호출자는 전량 재생으로 강등한다. `off == end` 는 빈 데이터의 `Some` 이다.
    /// 두 경우 모두 `end` 를 함께 준다.
    pub fn since(&self, off: i64) -> (Option<Vec<u8>>, i64) {
        let max = self.max;
        let g = self.lock();
        let end = g.total_in;
        if off < 0 || off > end {
            return (None, end);
        }
        let start = end - g.retained(max) as i64;
        if off < start {
            return (None, end);
        }
        (Some(g.tail(max, (end - off) as usize)), end)
    }

    /// 지금 유지된 꼬리의 사본과 통계다.
    pub fn snapshot(&self) -> (Vec<u8>, Stats) {
        let max = self.max;
        let g = self.lock();
        let out = g.tail(max, g.retained(max));
        let st = Stats {
            total_bytes_in: g.total_in,
            total_bytes_drop: g.total_drop,
            retained: out.len(),
        };
        (out, st)
    }

    /// 지금 유지된 바이트 수다.
    pub fn len(&self) -> usize {
        self.lock().retained(self.max)
    }

    /// 유지된 바이트가 없는가다.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 버퍼를 놓는다. 좌표(`offset`)는 그대로다. 이후 `feed` 는 빈 창에서 다시 쌓는다.
    pub fn close(&self) {
        let mut g = self.lock();
        g.buf = Vec::new();
        g.head = 0;
        g.full = false;
        g.vlen = 0;
    }

    #[cfg(test)]
    fn capacity(&self) -> usize {
        self.lock().buf.capacity()
    }

    #[cfg(test)]
    fn buf_ptr(&self) -> *const u8 {
        self.lock().buf.as_ptr()
    }
}

impl Inner {
    fn retained(&self, max: usize) -> usize {
        if self.full { max } else { self.buf.len() }
    }

    fn write(&mut self, max: usize, mut p: &[u8]) {
        if max == 0 || p.is_empty() {
            return;
        }
        if p.len() >= max {
            p = &p[p.len() - max..];
        }
        if !self.full {
            if self.buf.len() + p.len() < max {
                self.grow(max, self.buf.len() + p.len());
                self.buf.extend_from_slice(p);
                return;
            }
            // 이 feed 로 창이 찬다: 링으로 바꾼다. 남길 옛 꼬리를 앞에 놓고 p 를 잇는다.
            let keep = max - p.len();
            let old_len = self.buf.len();
            let mut ring = std::mem::take(&mut self.buf);
            if ring.capacity() == max {
                ring.copy_within(old_len - keep..old_len, 0);
                ring.truncate(keep);
            } else {
                let mut nb = Vec::with_capacity(max);
                nb.extend_from_slice(&ring[old_len - keep..]);
                ring = nb;
            }
            ring.extend_from_slice(p);
            self.buf = ring;
            self.head = 0;
            self.full = true;
            return;
        }
        let k = (max - self.head).min(p.len());
        self.buf[self.head..self.head + k].copy_from_slice(&p[..k]);
        self.buf[..p.len() - k].copy_from_slice(&p[k..]);
        self.head = (self.head + p.len()) % max;
    }

    fn grow(&mut self, max: usize, need: usize) {
        let cap = self.buf.capacity();
        if need <= cap {
            return;
        }
        let c = (2 * cap).max(STREAM_INIT_CAP).max(need).min(max);
        self.buf.reserve_exact(c - self.buf.len());
    }

    fn tail(&self, max: usize, n: usize) -> Vec<u8> {
        if !self.full {
            return self.buf[self.buf.len() - n..].to_vec();
        }
        let start = (self.head + max - n) % max;
        let mut out = Vec::with_capacity(n);
        let k = (max - start).min(n);
        out.extend_from_slice(&self.buf[start..start + k]);
        out.extend_from_slice(&self.buf[..n - k]);
        out
    }
}

#[cfg(test)]
mod tests;
