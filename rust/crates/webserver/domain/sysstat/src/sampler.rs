use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, Instant, SystemTime};

use crate::{CpuTicks, Reader, cpu_percent, round1};

/// 샘플 주기다 (SYSTEM_STATS_SRS D-3).
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);

const DEFAULT_DISK_PATH: &str = "/";

/// 샘플러가 유지하는 최신 지표다. 실패한 지표는 마지막 유효값을 유지하고, 한 번도 유효하지
/// 않았던 지표는 `*_valid` 가 거짓이다 (FR-STAT-7).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Snapshot {
    pub cpu: f64,
    pub cpu_valid: bool,
    pub mem_total: u64,
    pub mem_used: u64,
    pub mem_valid: bool,
    /// 총량만이라도 유효한가다. `mem_valid` 이면 늘 참이다 (FR-ATF-44).
    pub mem_total_valid: bool,
    pub disk_pct: f64,
    pub disk_valid: bool,
    pub boot_time: Option<SystemTime>,
}

impl Snapshot {
    /// 부팅 시각이 유효한가다.
    pub fn boot_valid(&self) -> bool {
        self.boot_time.is_some()
    }
}

#[derive(Default)]
struct CpuBase {
    prev: Option<CpuTicks>,
}

/// 커널 값을 주기적으로 읽어 [`Snapshot`] 을 갱신한다. 요청 경로에서 커널을 부르지 않는다
/// (FR-STAT-9). 커널 호출은 접속 수와 무관하게 주기당 한 번이다 (FR-STAT-11).
pub struct Sampler {
    r: Box<dyn Reader>,
    interval: Duration,
    disk_path: String,
    snap: RwLock<Snapshot>,
    /// CPU tick 차분의 기준점이다. 한 번에 한 샘플만 돌게 하는 잠금이기도 하다.
    base: Mutex<CpuBase>,
}

/// [`Sampler::start`] 가 띄운 스레드를 멈춘다. 떨어뜨려도 멈춘다 (FR-STAT-13).
pub struct Stopper {
    _tx: mpsc::Sender<()>,
}

impl Stopper {
    /// 샘플링을 멈춘다.
    pub fn stop(self) {}
}

impl Sampler {
    /// `interval` 이 0 이면 [`DEFAULT_INTERVAL`], `disk_path` 가 비면 `/` 를 쓴다.
    pub fn new(r: Box<dyn Reader>, interval: Duration, disk_path: &str) -> Self {
        Self {
            r,
            interval: if interval.is_zero() {
                DEFAULT_INTERVAL
            } else {
                interval
            },
            disk_path: if disk_path.is_empty() {
                DEFAULT_DISK_PATH
            } else {
                disk_path
            }
            .to_owned(),
            snap: RwLock::new(Snapshot::default()),
            base: Mutex::new(CpuBase::default()),
        }
    }

    /// 곧바로 한 번 샘플링한 뒤 주기 샘플링 스레드를 띄운다. CPU 는 두 번째 샘플부터
    /// 유효하다 (FR-STAT-12).
    pub fn start(self: &Arc<Self>) -> Stopper {
        self.sample();
        let (tx, rx) = mpsc::channel::<()>();
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let mut next = Instant::now() + me.interval;
            loop {
                let wait = next.saturating_duration_since(Instant::now());
                match rx.recv_timeout(wait) {
                    Err(RecvTimeoutError::Timeout) => {
                        me.sample();
                        // Go time.Ticker 처럼 밀린 틱은 버리고 다음 주기에 맞춘다.
                        let now = Instant::now();
                        while next <= now {
                            next += me.interval;
                        }
                    }
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        });
        Stopper { _tx: tx }
    }

    /// 최신 스냅샷의 사본이다. 잠금 구간에 커널 호출이 없다 (FR-STAT-10).
    pub fn snapshot(&self) -> Snapshot {
        *self.snap.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// 한 주기의 수집이다. 지표마다 따로 처리한다 (FR-STAT-7).
    pub(crate) fn sample(&self) {
        let mut base = self.base.lock().unwrap_or_else(PoisonError::into_inner);
        let cur = self.r.cpu_ticks();
        let mem = self.r.mem();
        // FR-OPT-8-6: 부팅 시각은 바뀌지 않는다 — 한 번 읽히면 다시 읽지 않는다.
        let boot = if self.snapshot().boot_valid() {
            None
        } else {
            self.r.boot_time().ok()
        };
        let disk = self.r.disk_percent(&self.disk_path);

        let mut s = self.snap.write().unwrap_or_else(PoisonError::into_inner);
        if let Ok(cur) = cur {
            if let Some(prev) = base.prev
                && let Some(pct) = cpu_percent(prev, cur)
            {
                s.cpu = pct;
                s.cpu_valid = true;
            }
            base.prev = Some(cur);
        }
        match mem {
            Ok(m) => {
                s.mem_total = m.total;
                s.mem_used = m.used;
                s.mem_valid = true;
                s.mem_total_valid = true;
            }
            Err(e) if e.total > 0 => {
                s.mem_total = e.total;
                s.mem_total_valid = true;
            }
            Err(_) => {}
        }
        if boot.is_some() {
            s.boot_time = boot;
        }
        if let Ok(d) = disk {
            s.disk_pct = round1(d);
            s.disk_valid = true;
        }
    }

    #[cfg(test)]
    pub(crate) fn interval(&self) -> Duration {
        self.interval
    }
}
