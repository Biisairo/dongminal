//! recovery hint (FR-GIT-92·93).

use std::sync::Mutex;

use serde::Serialize;

use crate::exec::Service;
use crate::record::now_unix_ms;

/// 세션 동안 들고 있을 hint 수다.
pub const DEFAULT_HINT_CAP: usize = 200;

/// 파괴적 동작 직전에 기록한 복구 수단이다 (FR-GIT-92).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Hint {
    pub seq: u64,
    #[serde(rename = "atUnixMs")]
    pub at_unix_ms: i64,
    pub repo: String,
    pub action: String,
    /// nil 이면 JSON `null` 이다.
    pub targets: Option<Vec<String>>,
    pub values: Option<Vec<String>>,
    pub command: String,
    pub note: String,
}

#[derive(Default)]
struct HintRing {
    buf: Vec<Hint>,
    next: usize,
    n: usize,
    seq: u64,
}

/// 세션 동안의 hint 다 (FR-GIT-93). 기본값도 쓸 수 있다 — 첫 add 가 자리를 잡는다.
#[derive(Default)]
pub struct HintLog {
    ring: Mutex<HintRing>,
    cap: usize,
}

impl HintLog {
    /// cap 이 0 이면 DEFAULT_HINT_CAP 이다.
    pub fn new(cap: usize) -> Self {
        HintLog {
            ring: Mutex::default(),
            cap,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HintRing> {
        self.ring.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Seq 를 채워 기록하고 그 값을 돌려준다. 시각이 비어 있으면 채운다.
    pub fn add(&self, mut h: Hint) -> Hint {
        let mut l = self.lock();
        if l.buf.is_empty() {
            let size = if self.cap == 0 {
                DEFAULT_HINT_CAP
            } else {
                self.cap
            };
            l.buf = vec![Hint::default(); size];
        }
        l.seq += 1;
        h.seq = l.seq;
        if h.at_unix_ms == 0 {
            h.at_unix_ms = now_unix_ms();
        }
        let next = l.next;
        l.buf[next] = h.clone();
        l.next = (next + 1) % l.buf.len();
        if l.n < l.buf.len() {
            l.n += 1;
        }
        h
    }

    /// 최신이 마지막인 복사본이다. n 이 0 이면 보유분 전부다.
    pub fn recent(&self, n: usize) -> Vec<Hint> {
        let l = self.lock();
        let n = if n == 0 || n > l.n { l.n } else { n };
        if n == 0 {
            return Vec::new();
        }
        let len = l.buf.len();
        let start = (l.next + 2 * len - n) % len;
        (0..n).map(|i| l.buf[(start + i) % len].clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.lock().n
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Service {
    /// 파괴적 동작 직전의 복구 수단을 기록한다 (FR-GIT-92).
    pub fn add_hint(&self, h: Hint) -> Hint {
        self.hints.add(h)
    }

    /// 세션 동안 기록된 hint 다 (최신이 마지막). n 이 0 이면 보유분 전부다.
    pub fn hints(&self, n: usize) -> Vec<Hint> {
        self.hints.recent(n)
    }
}
