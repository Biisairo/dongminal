//! 실행 기록 (FR-GIT-5). Console 탭이 읽는 와이어다.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::error::Error;
use crate::exec::{DEFAULT_RECORD_CAP, Output};
use crate::remote::sanitize_remote;
use crate::write::is_write_command;

/// 실행 한 번의 구조화된 기록이다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Record {
    pub seq: u64,
    #[serde(rename = "atUnixMs")]
    pub at_unix_ms: i64,
    /// nil 이면 JSON `null` 이다 (Go `[]string(nil)`).
    pub argv: Option<Vec<String>>,
    pub cwd: String,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    #[serde(rename = "durationMs")]
    pub duration_ms: i64,
    pub stderr: String,
    #[serde(rename = "stdoutBytes")]
    pub stdout_bytes: usize,
    #[serde(rename = "stdoutTruncated")]
    pub stdout_truncated: bool,
    #[serde(rename = "stderrTruncated")]
    pub stderr_truncated: bool,
    /// 호출자의 선언(I5).
    pub destructive: bool,
    /// 하위 명령이 쓰기 목록에 있는지다 (FR-GIT-218).
    pub write: bool,
    /// 내용은 남기지 않는다 (I6).
    #[serde(rename = "stdinBytes")]
    pub stdin_bytes: usize,
    #[serde(skip_serializing_if = "dm_gocompat::json::is_empty")]
    pub err: String,
    /// 명령 화이트리스트를 지나지 않았다는 표식 (FR-GXU-5).
    #[serde(skip_serializing_if = "dm_gocompat::json::is_empty")]
    pub unguarded: bool,
    #[serde(skip_serializing_if = "dm_gocompat::json::is_empty")]
    pub reason: String,
}

impl Record {
    /// argv 를 슬라이스로 본다 (nil 은 빈 것).
    pub fn argv(&self) -> &[String] {
        self.argv.as_deref().unwrap_or(&[])
    }

    /// 화면으로 나갈 수 있는 사본이다. 원본을 건드리지 않는다.
    pub fn redacted(&self) -> Record {
        let mut out = self.clone();
        out.argv = Some(self.argv().iter().map(|a| redact_secrets(a)).collect());
        out.stderr = redact_secrets(&self.stderr);
        out.err = redact_secrets(&self.err);
        out
    }
}

pub(crate) fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 실행 결과를 기록 한 줄로 옮긴다. stdin 은 받지 않는다 (I6).
pub(crate) fn new_record<S: AsRef<str>>(
    dir: &str,
    argv: &[S],
    out: &Output,
    err: Option<&Error>,
) -> Record {
    Record {
        at_unix_ms: now_unix_ms(),
        write: is_write_command(argv),
        argv: (!argv.is_empty()).then(|| argv.iter().map(|a| a.as_ref().to_owned()).collect()),
        cwd: dir.to_owned(),
        exit_code: out.exit_code,
        duration_ms: out.duration_ms,
        stderr: out.stderr.clone(),
        stdout_bytes: out.stdout.len(),
        stdout_truncated: out.stdout_truncated,
        stderr_truncated: out.stderr_truncated,
        err: err.map(|e| e.to_string()).unwrap_or_default(),
        ..Record::default()
    }
}

/// Since 가 본 링의 범위다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecordSpan {
    pub first: u64,
    pub last: u64,
    pub gap: bool,
    pub epoch: String,
}

struct Ring {
    buf: Vec<Record>,
    next: usize,
    n: usize,
    seq: u64,
}

impl Ring {
    fn tail(&self, n: usize) -> Vec<Record> {
        let len = self.buf.len();
        let start = (self.next + 2 * len - n) % len;
        (0..n)
            .map(|i| self.buf[(start + i) % len].clone())
            .collect()
    }
}

/// 고정 길이 링 버퍼다.
pub struct Recorder {
    ring: Mutex<Ring>,
    epoch: String,
}

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const EPOCH_LEN: usize = 26;

/// Go `crypto/rand.Text()`.
fn rand_text() -> String {
    let mut b = [0u8; EPOCH_LEN];
    rand::fill(&mut b);
    b.iter()
        .map(|x| BASE32_ALPHABET[(x % 32) as usize] as char)
        .collect()
}

impl Recorder {
    /// cap 이 0 이면 DEFAULT_RECORD_CAP 이다.
    pub fn new(cap: usize) -> Self {
        let cap = if cap == 0 { DEFAULT_RECORD_CAP } else { cap };
        Recorder {
            ring: Mutex::new(Ring {
                buf: vec![Record::default(); cap],
                next: 0,
                n: 0,
                seq: 0,
            }),
            epoch: rand_text(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Ring> {
        self.ring.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 이 링의 세대다.
    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    /// Seq 를 부여해 기록한다. 링이 넘쳐도 Seq 는 되돌아가지 않는다.
    pub fn add(&self, mut rec: Record) {
        let mut r = self.lock();
        r.seq += 1;
        rec.seq = r.seq;
        let next = r.next;
        r.buf[next] = rec;
        r.next = (next + 1) % r.buf.len();
        if r.n < r.buf.len() {
            r.n += 1;
        }
    }

    /// 최신이 마지막인 복사본이다. n 이 0 이면 보유분 전부다.
    pub fn recent(&self, n: usize) -> Vec<Record> {
        let r = self.lock();
        let n = if n == 0 || n > r.n { r.n } else { n };
        r.tail(n)
    }

    /// Seq 가 after 보다 큰 기록과 링의 범위다 (FR-OPT-4-8). Gap 이면 보유분 전부다.
    pub fn since(&self, after: u64, epoch: &str) -> (Vec<Record>, RecordSpan) {
        let r = self.lock();
        let mut span = RecordSpan {
            first: r.seq - r.n as u64 + 1,
            last: r.seq,
            gap: false,
            epoch: self.epoch.clone(),
        };
        span.gap = after > span.last
            || after.saturating_add(1) < span.first
            || (!epoch.is_empty() && epoch != self.epoch);
        let n = if span.gap {
            r.n
        } else {
            (span.last - after) as usize
        };
        (r.tail(n), span)
    }

    pub fn len(&self) -> usize {
        self.lock().n
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// URL 에 박힌 자격증명을 `***` 로 바꾼다. 화면으로 나가는 경로가 쓴다 (FR-GIT-218).
/// 규칙은 sanitize_remote 하나다.
pub fn redact_secrets(s: &str) -> String {
    sanitize_remote(s)
}
