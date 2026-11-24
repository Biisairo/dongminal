//! Go 기준선 `dongminal/internal/webserver/domain/sysstat` 의 Rust 포팅.
//!
//! 상태바 지표(CPU·메모리·디스크·부팅시각)를 커널에서 직접 읽는다. 외부 프로세스를
//! 띄우지 않는다 (FR-STAT-6). OS 호출은 `os` 모듈 하나에만 있고, `unsafe` 도 그
//! 모듈에만 있다 (C-RSP-4 예외).
#![deny(unsafe_code)]

mod procparse;
mod sampler;

#[allow(unsafe_code)]
mod os;

use std::fmt;
use std::time::SystemTime;

pub use os::new_reader;
pub use sampler::{DEFAULT_INTERVAL, Sampler, Snapshot, Stopper};

/// 지표 읽기의 실패다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// 이 플랫폼에서 읽을 수 없는 지표다. 호출자는 그 지표만 비운다 (FR-STAT-7).
    Unsupported,
    /// 커널 호출·해석의 실패다.
    Os(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Unsupported => f.write_str("sysstat: 이 빌드/플랫폼에서 지원되지 않는 지표"),
            Error::Os(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for Error {}

/// 커널이 보고하는 **누적** CPU tick 이다. 두 시점의 차분으로만 백분율이 나온다 (FR-STAT-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CpuTicks {
    pub user: u64,
    pub system: u64,
    pub idle: u64,
    pub nice: u64,
}

impl CpuTicks {
    /// idle 을 뺀 tick 합이다.
    pub fn busy(&self) -> u64 {
        self.user + self.system + self.nice
    }

    /// 전체 tick 합이다.
    pub fn total(&self) -> u64 {
        self.busy() + self.idle
    }
}

/// 한 시점의 메모리 상태다. `used` 는 Activity Monitor 의 "사용된 메모리"(wired + active +
/// compressed)와 맞춘다 (FR-STAT-15, D-2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MemInfo {
    pub total: u64,
    pub used: u64,
}

/// 메모리 읽기의 실패다. `total` 이 0 이 아니면 총량만은 유효하다 (FR-ATF-44).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemError {
    pub total: u64,
    pub error: Error,
}

/// 커널 접근면이다. 메서드마다 따로 실패할 수 있다 (FR-STAT-7).
pub trait Reader: Send + Sync {
    fn cpu_ticks(&self) -> Result<CpuTicks, Error>;
    fn mem(&self) -> Result<MemInfo, MemError>;
    fn boot_time(&self) -> Result<SystemTime, Error>;
    fn disk_percent(&self, path: &str) -> Result<f64, Error>;
}

/// 두 누적 tick 읽기 사이의 busy 비율(0~100, 소수 1자리)이다. total 이나 busy 가 줄었거나
/// tick 이 늘지 않았으면 정의되지 않으므로 `None` 이다.
pub fn cpu_percent(prev: CpuTicks, cur: CpuTicks) -> Option<f64> {
    if cur.total() < prev.total() || cur.busy() < prev.busy() {
        return None;
    }
    let d_total = cur.total() - prev.total();
    if d_total == 0 {
        return None;
    }
    let d_busy = cur.busy() - prev.busy();
    let pct = (d_busy as f64 / d_total as f64 * 100.0).clamp(0.0, 100.0);
    Some(round1(pct))
}

/// 백분율 표시용 소수 1자리 반올림이다 (Go `math.Round(v*10)/10`).
pub(crate) fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests;
