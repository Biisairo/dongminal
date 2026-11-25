use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::{Duration, SystemTime};

use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use crate::{CpuTicks, Reader, cpu_percent, round1};

pub use otter_shared_cadence::SYSSTAT_SAMPLE_EVERY as DEFAULT_INTERVAL;
pub use otter_shared_cadence::SYSSTAT_WARMUP_GAP as WARMUP_GAP;

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

/// 커널 값을 주기적으로 읽어 [`Snapshot`] 을 갱신한다. `stats:*` 구독이 있는 동안만 돈다 —
/// 부르는 쪽이 [`Sampler::resume`]·[`Sampler::pause`] 로 알린다 (PERF D-61). 도는 동안 커널 호출은
/// 접속 수와 무관하게 주기당 한 번이다 (FR-STAT-11).
pub struct Sampler {
    r: Box<dyn Reader>,
    interval: Duration,
    disk_path: String,
    snap: RwLock<Snapshot>,
    /// CPU tick 차분의 기준점이다. 한 번에 한 샘플만 돌게 하는 잠금이기도 하다.
    base: Mutex<CpuBase>,
    /// 도는 샘플링 작업의 멈춤 손잡이다. 떨어뜨리면 작업이 끝난다. 없으면 쉰다.
    run: Mutex<Option<oneshot::Sender<()>>>,
    /// 멈출 때마다 오른다. 멈춘 회차의 늦은 표본이 스냅샷을 덮지 않게 한다.
    epoch: AtomicU64,
    /// 예열 중인가다. [`Sampler::warmed`] 가 기다린다.
    warming: watch::Sender<bool>,
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
            run: Mutex::new(None),
            epoch: AtomicU64::new(0),
            warming: watch::Sender::new(false),
        }
    }

    /// 주기 샘플링을 띄운다 — 곧바로 한 번, [`WARMUP_GAP`] 뒤 한 번(예열), 그 뒤 주기마다 읽는다.
    /// 이미 돌고 있거나 tokio 런타임 밖이면 아무것도 하지 않는다 (PERF D-61).
    pub fn resume(self: &Arc<Self>) {
        let mut run = self.run.lock().unwrap_or_else(PoisonError::into_inner);
        if run.is_some() {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let (tx, mut rx) = oneshot::channel::<()>();
        *run = Some(tx);
        let epoch = self.epoch.load(Ordering::SeqCst);
        self.warming.send_replace(true);
        let me = Arc::clone(self);
        rt.spawn(async move {
            me.sample_in(epoch);
            let mut next = Instant::now() + WARMUP_GAP;
            let mut warm = true;
            loop {
                tokio::select! {
                    _ = &mut rx => return,
                    _ = tokio::time::sleep_until(next) => {
                        if !me.sample_in(epoch) {
                            return;
                        }
                        if std::mem::take(&mut warm) {
                            me.warming.send_replace(false);
                        }
                        // 밀린 틱은 버리고 다음 주기에 맞춘다.
                        let now = Instant::now();
                        while next <= now {
                            next += me.interval;
                        }
                    }
                }
            }
        });
    }

    /// 주기 샘플링을 멈추고 CPU 값을 버린다 — CPU 는 도는 동안의 값만 낸다 (PERF D-61, FR-STAT-13).
    pub fn pause(&self) {
        let mut run = self.run.lock().unwrap_or_else(PoisonError::into_inner);
        if run.take().is_none() {
            return;
        }
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let mut base = self.base.lock().unwrap_or_else(PoisonError::into_inner);
        base.prev = None;
        let mut s = self.snap.write().unwrap_or_else(PoisonError::into_inner);
        s.cpu = 0.0;
        s.cpu_valid = false;
        self.warming.send_replace(false);
    }

    /// 예열(표본 둘)이 끝나면 풀린다. 쉬고 있으면 곧바로 풀린다.
    pub fn warmed(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut rx = self.warming.subscribe();
        async move {
            let _ = rx.wait_for(|w| !*w).await;
        }
    }

    /// `GET /api/stats` 의 값이다. mem·disk·boot 는 지금 읽고, CPU 는 샘플링이 도는 동안의 값만
    /// 싣는다 (Q6, FR-STAT-9 개정). 실패한 지표는 마지막 유효값을 유지한다 (FR-STAT-7).
    pub fn measure(&self) -> Snapshot {
        let _base = self.base.lock().unwrap_or_else(PoisonError::into_inner);
        self.read_rest();
        self.snapshot()
    }

    /// 최신 스냅샷의 사본이다. 잠금 구간에 커널 호출이 없다 (FR-STAT-10).
    pub fn snapshot(&self) -> Snapshot {
        *self.snap.read().unwrap_or_else(PoisonError::into_inner)
    }

    /// 한 주기의 수집이다. 지표마다 따로 처리한다 (FR-STAT-7).
    #[cfg(test)]
    pub(crate) fn sample(&self) {
        self.sample_in(self.epoch.load(Ordering::SeqCst));
    }

    /// `epoch` 회차의 수집이다. 그 사이 멈췄으면 읽지 않고 거짓이다.
    fn sample_in(&self, epoch: u64) -> bool {
        let mut base = self.base.lock().unwrap_or_else(PoisonError::into_inner);
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return false;
        }
        if let Ok(cur) = self.r.cpu_ticks() {
            if let Some(prev) = base.prev
                && let Some(pct) = cpu_percent(prev, cur)
            {
                let mut s = self.snap.write().unwrap_or_else(PoisonError::into_inner);
                s.cpu = pct;
                s.cpu_valid = true;
            }
            base.prev = Some(cur);
        }
        self.read_rest();
        true
    }

    /// CPU 를 뺀 지표(mem·boot·disk)를 읽는다. 부르는 쪽이 `base` 잠금을 쥔다.
    fn read_rest(&self) {
        let mem = self.r.mem();
        // FR-OPT-8-6: 부팅 시각은 바뀌지 않는다 — 한 번 읽히면 다시 읽지 않는다.
        let boot = if self.snapshot().boot_valid() {
            None
        } else {
            self.r.boot_time().ok()
        };
        let disk = self.r.disk_percent(&self.disk_path);

        let mut s = self.snap.write().unwrap_or_else(PoisonError::into_inner);
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
