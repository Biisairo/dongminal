use super::procparse::*;
use super::*;
use otter_shared_cadence::SYSSTAT_WARMUP_GAP;
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

fn ticks(user: u64, system: u64, idle: u64, nice: u64) -> CpuTicks {
    CpuTicks {
        user,
        system,
        idle,
        nice,
    }
}

// ── cpu_percent (FR-STAT-1)

#[test]
fn cpu_percent_cases() {
    let z = CpuTicks::default();
    let cases = [
        ("절반 busy", z, ticks(50, 0, 50, 0), Some(50.0)),
        ("nice 는 busy", z, ticks(10, 10, 60, 20), Some(40.0)),
        (
            "차분만 본다",
            ticks(1000, 500, 8500, 0),
            ticks(1030, 510, 8560, 0),
            Some(40.0),
        ),
        ("전부 idle", z, ticks(0, 0, 100, 0), Some(0.0)),
        ("전부 busy", z, ticks(100, 0, 0, 0), Some(100.0)),
        ("소수 1자리", z, ticks(1, 0, 2, 0), Some(33.3)),
        (
            "tick 증가 없음",
            ticks(10, 0, 10, 0),
            ticks(10, 0, 10, 0),
            None,
        ),
        (
            "total 감소",
            ticks(100, 0, 100, 0),
            ticks(10, 0, 10, 0),
            None,
        ),
        (
            "busy 만 감소",
            ticks(100, 0, 100, 0),
            ticks(50, 0, 200, 0),
            None,
        ),
    ];
    for (name, prev, cur, want) in cases {
        assert_eq!(cpu_percent(prev, cur), want, "{name}");
    }
}

#[test]
fn cpu_ticks_busy_total() {
    let t = ticks(1, 2, 4, 8);
    assert_eq!((t.busy(), t.total()), (11, 15));
}

#[test]
fn unsupported_message() {
    assert_eq!(
        Error::Unsupported.to_string(),
        "sysstat: 이 빌드/플랫폼에서 지원되지 않는 지표"
    );
}

// ── fake Reader

#[derive(Default)]
struct FakeState {
    ticks: Vec<CpuTicks>,
    tick_idx: usize,
    tick_err: Option<Error>,
    mem: MemInfo,
    mem_err: Option<Error>,
    boot: Option<SystemTime>,
    boot_err: Option<Error>,
    boot_calls: usize,
    disk: f64,
    disk_err: Option<Error>,
    disk_path: String,
    calls: usize,
}

#[derive(Default, Clone)]
struct Fake(Arc<Mutex<FakeState>>);

impl Fake {
    fn with(f: impl FnOnce(&mut FakeState)) -> Self {
        let s = Fake::default();
        f(&mut s.0.lock().unwrap());
        s
    }
    fn st(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.0.lock().unwrap()
    }
}

impl Reader for Fake {
    fn cpu_ticks(&self) -> Result<CpuTicks, Error> {
        let mut s = self.st();
        s.calls += 1;
        if let Some(e) = &s.tick_err {
            return Err(e.clone());
        }
        if s.tick_idx >= s.ticks.len() {
            return Ok(s.ticks.last().copied().unwrap_or_default());
        }
        let v = s.ticks[s.tick_idx];
        s.tick_idx += 1;
        Ok(v)
    }
    fn mem(&self) -> Result<MemInfo, MemError> {
        let s = self.st();
        match &s.mem_err {
            Some(e) => Err(MemError {
                total: s.mem.total,
                error: e.clone(),
            }),
            None => Ok(s.mem),
        }
    }
    fn boot_time(&self) -> Result<SystemTime, Error> {
        let mut s = self.st();
        s.boot_calls += 1;
        if let Some(e) = &s.boot_err {
            return Err(e.clone());
        }
        s.boot.ok_or(Error::Os("no boot".into()))
    }
    fn disk_percent(&self, path: &str) -> Result<f64, Error> {
        let mut s = self.st();
        s.disk_path = path.to_owned();
        match &s.disk_err {
            Some(e) => Err(e.clone()),
            None => Ok(s.disk),
        }
    }
}

fn sampler(f: &Fake) -> Sampler {
    Sampler::new(Box::new(f.clone()), Duration::from_secs(3600), "/")
}

fn at(sec: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(sec)
}

// FR-STAT-12
#[test]
fn sampler_cpu_needs_two_samples() {
    let f = Fake::with(|s| {
        s.ticks = vec![ticks(0, 0, 0, 0), ticks(30, 0, 70, 0)];
        s.mem = MemInfo {
            total: 100,
            used: 20,
        };
        s.boot = Some(at(1000));
        s.disk = 42.0;
    });
    let s = sampler(&f);
    s.sample();
    let snap = s.snapshot();
    assert!(!snap.cpu_valid, "첫 샘플에 CPU 가 유효하다");
    assert!(
        snap.mem_valid && snap.boot_valid() && snap.disk_valid,
        "{snap:?}"
    );
    s.sample();
    let snap = s.snapshot();
    assert!(snap.cpu_valid);
    assert_eq!(snap.cpu, 30.0);
}

// FR-STAT-7
#[test]
fn sampler_partial_failure_isolated() {
    let f = Fake::with(|s| {
        s.mem_err = Some(Error::Os("boom".into()));
        s.boot = Some(at(2000));
        s.disk = 10.0;
        s.ticks = vec![ticks(0, 0, 1, 0), ticks(0, 0, 2, 0)];
    });
    let s = sampler(&f);
    s.sample();
    s.sample();
    let snap = s.snapshot();
    assert!(!snap.mem_valid);
    assert!(
        snap.boot_valid() && snap.disk_valid && snap.cpu_valid,
        "{snap:?}"
    );
}

// FR-STAT-7
#[test]
fn sampler_keeps_last_valid_on_failure() {
    let f = Fake::with(|s| {
        s.mem = MemInfo {
            total: 100,
            used: 40,
        };
        s.ticks = vec![ticks(0, 0, 1, 0)];
    });
    let s = sampler(&f);
    s.sample();
    assert_eq!(s.snapshot().mem_used, 40);
    {
        let mut st = f.st();
        st.mem_err = Some(Error::Os("transient".into()));
        st.mem = MemInfo::default();
    }
    s.sample();
    let snap = s.snapshot();
    assert!(snap.mem_valid);
    assert_eq!(snap.mem_used, 40);
}

#[test]
fn sampler_unsupported_is_not_fatal() {
    let f = Fake::with(|s| {
        s.tick_err = Some(Error::Unsupported);
        s.mem_err = Some(Error::Unsupported);
        s.boot = Some(at(3000));
        s.disk = 55.5;
    });
    let s = sampler(&f);
    s.sample();
    s.sample();
    let snap = s.snapshot();
    assert!(!snap.cpu_valid && !snap.mem_valid);
    assert!(snap.boot_valid() && snap.disk_valid);
    assert_eq!(snap.disk_pct, 55.5);
}

// TC-ATF-44
#[test]
fn sampler_keeps_mem_total_on_partial_success() {
    const TOTAL: u64 = 16 << 30;
    let f = Fake::with(|s| {
        s.mem = MemInfo {
            total: TOTAL,
            used: 0,
        };
        s.mem_err = Some(Error::Unsupported);
    });
    let s = sampler(&f);
    s.sample();
    let snap = s.snapshot();
    assert!(snap.mem_total_valid && snap.mem_total == TOTAL, "{snap:?}");
    assert!(!snap.mem_valid);

    let s2 = sampler(&Fake::with(|s| s.mem_err = Some(Error::Unsupported)));
    s2.sample();
    let snap = s2.snapshot();
    assert!(!snap.mem_total_valid && !snap.mem_valid);
}

// FR-STAT-11
#[test]
fn sampler_snapshot_does_not_read_kernel() {
    let f = Fake::with(|s| s.ticks = vec![ticks(0, 0, 1, 0), ticks(0, 0, 2, 0)]);
    let s = sampler(&f);
    s.sample();
    let before = f.st().calls;
    for _ in 0..100 {
        s.snapshot();
    }
    assert_eq!(f.st().calls, before);
}

fn sampler_every(f: &Fake) -> Arc<Sampler> {
    Arc::new(Sampler::new(Box::new(f.clone()), DEFAULT_INTERVAL, "/"))
}

fn counting(f: &Fake) {
    let mut st = f.st();
    st.ticks = (0..64).map(|i| ticks(i, 0, 2 * i, 0)).collect();
    st.mem = MemInfo {
        total: 100,
        used: 20,
    };
    st.boot = Some(at(1000));
    st.disk = 42.0;
}

// PERF 4.10 (S2): 구독이 없으면 샘플러는 커널을 읽지 않는다.
#[tokio::test(start_paused = true)]
async fn idle_sampler_reads_nothing() {
    let f = Fake::default();
    counting(&f);
    let _s = sampler_every(&f);
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(f.st().calls, 0, "구독이 없는데 커널을 읽었다");
}

// PERF 4.10 (S2), FR-STAT-13: resume 으로 돌고 pause 로 멈춘다. 두 번 resume 해도 한 벌이다.
#[tokio::test(start_paused = true)]
async fn subscribe_starts_unsubscribe_stops() {
    let f = Fake::default();
    counting(&f);
    let s = sampler_every(&f);
    s.resume();
    s.resume();
    s.warmed().await;
    assert_eq!(f.st().calls, 2, "예열 표본은 둘이다");
    tokio::time::sleep(DEFAULT_INTERVAL * 3 + Duration::from_millis(1)).await;
    assert_eq!(f.st().calls, 5, "구독 중에는 주기마다 한 번 읽는다");

    s.pause();
    assert!(!s.snapshot().cpu_valid, "멈춘 샘플러의 CPU 가 남았다");
    let after = f.st().calls;
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(f.st().calls, after, "멈춘 뒤에도 샘플링이 계속됐다");

    s.resume();
    s.warmed().await;
    assert_eq!(f.st().calls, after + 2, "다시 띄우면 다시 예열한다");
    assert!(s.snapshot().cpu_valid);
}

// PERF 4.10 (S2): 예열 간격 하나만 기다리면 CPU 가 있다.
#[tokio::test(start_paused = true)]
async fn first_frame_has_cpu() {
    let f = Fake::default();
    counting(&f);
    let s = sampler_every(&f);
    let t0 = tokio::time::Instant::now();
    s.resume();
    s.warmed().await;
    assert_eq!(t0.elapsed(), SYSSTAT_WARMUP_GAP);
    let snap = s.snapshot();
    assert!(snap.cpu_valid, "{snap:?}");
    assert_eq!(snap.cpu, 33.3);
}

// PERF 4.10 (S2): 쉬는 샘플러의 warmed 는 곧바로 풀린다.
#[tokio::test(start_paused = true)]
async fn warmed_is_immediate_when_idle() {
    let f = Fake::default();
    let s = sampler_every(&f);
    let t0 = tokio::time::Instant::now();
    s.warmed().await;
    assert_eq!(t0.elapsed(), Duration::ZERO);
    s.resume();
    s.pause();
    s.warmed().await;
    assert_eq!(t0.elapsed(), Duration::ZERO, "멈춘 예열을 기다렸다");
}

// PERF 4.10 (Q6, FR-STAT-9 개정): GET 은 mem·disk·boot 를 그 자리에서 재고 CPU 는 구독 중 값만 싣는다.
#[tokio::test(start_paused = true)]
async fn measure_reads_now_and_cpu_only_while_running() {
    let f = Fake::default();
    counting(&f);
    let s = sampler_every(&f);
    let m = s.measure();
    assert!(m.mem_valid && m.disk_valid && m.boot_valid(), "{m:?}");
    assert!(!m.cpu_valid);
    assert_eq!(f.st().calls, 0, "measure 가 CPU tick 을 읽었다");
    f.st().mem.used = 30;
    assert_eq!(s.measure().mem_used, 30, "그 자리에서 재지 않았다");

    s.resume();
    s.warmed().await;
    let m = s.measure();
    assert!(m.cpu_valid && m.mem_valid, "{m:?}");
    s.pause();
    assert!(!s.measure().cpu_valid);
}

#[test]
fn sampler_defaults() {
    let f = Fake::default();
    let s = Sampler::new(Box::new(f.clone()), Duration::ZERO, "");
    assert_eq!(s.interval(), DEFAULT_INTERVAL);
    assert_eq!(DEFAULT_INTERVAL, Duration::from_secs(2));
    s.sample();
    assert_eq!(f.st().disk_path, "/");
}

#[test]
fn sampler_disk_rounding() {
    let f = Fake::with(|s| s.disk = 42.06);
    let s = sampler(&f);
    s.sample();
    assert_eq!(s.snapshot().disk_pct, 42.1);
}

// FR-OPT-8-6
#[test]
fn sampler_boot_time_read_once() {
    let f = Fake::with(|s| {
        s.boot = Some(at(1000));
        s.boot_err = Some(Error::Os("아직".into()));
    });
    let s = sampler(&f);
    s.sample();
    assert!(!s.snapshot().boot_valid());
    f.st().boot_err = None;
    for _ in 0..5 {
        s.sample();
    }
    assert_eq!(f.st().boot_calls, 2, "실패 1 + 성공 1");
    assert_eq!(s.snapshot().boot_time, Some(at(1000)));
}

// ── procparse

const PROC_STAT: &str = "cpu  120000 500 30000 900000 2000 100 200 0 0 0
cpu0 60000 250 15000 450000 1000 50 100 0 0 0
intr 12345
ctxt 987654
btime 1756400000
processes 4242
";

#[test]
fn proc_stat_cpu() {
    let got = parse_proc_stat_cpu(PROC_STAT).unwrap();
    assert_eq!(got, ticks(120000, 30000, 902000, 500));
    assert_eq!(got.busy(), 150500);
}

#[test]
fn proc_stat_cpu_errors() {
    assert!(parse_proc_stat_cpu("intr 1\nbtime 2\n").is_err());
    assert!(parse_proc_stat_cpu("cpu  a b c d\n").is_err());
}

#[test]
fn proc_stat_boot_time() {
    assert_eq!(
        parse_proc_stat_boot_time(PROC_STAT).unwrap(),
        at(1756400000)
    );
    assert!(parse_proc_stat_boot_time("cpu 1 2 3 4\n").is_err());
}

#[test]
fn proc_meminfo_prefers_mem_available() {
    let got = parse_proc_meminfo(
        "MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:   10000000 kB\nBuffers:          200000 kB\nCached:          6000000 kB\n",
    )
    .unwrap();
    assert_eq!(got.total, 16000000 * 1024);
    assert_eq!(got.used, 6000000 * 1024);
}

#[test]
fn proc_meminfo_fallback() {
    let got = parse_proc_meminfo(
        "MemTotal:       16000000 kB\nMemFree:          500000 kB\nBuffers:          200000 kB\nCached:          6000000 kB\n",
    )
    .unwrap();
    assert_eq!(got.used, (16000000 - 6700000) * 1024);
}

#[test]
fn proc_meminfo_errors_and_clamp() {
    assert!(parse_proc_meminfo("MemFree: 100 kB\n").is_err());
    assert_eq!(
        parse_proc_meminfo("MemTotal: 1000 kB\nMemAvailable: 9999 kB\n")
            .unwrap()
            .used,
        0
    );
}

#[test]
fn sysctl_u64() {
    assert_eq!(
        parse_sysctl_u64(&34359738368u64.to_le_bytes()).unwrap(),
        34359738368
    );
    assert_eq!(parse_sysctl_u64(&4096u64.to_le_bytes()[..2]).unwrap(), 4096);
    assert!(parse_sysctl_u64(&[]).is_err());
}

// ── 실제 커널 스모크 (범위·불변식만 본다)

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod real {
    use super::*;

    #[test]
    fn mem_in_range() {
        let m = new_reader().mem().expect("mem");
        assert!(
            m.total >= 1 << 30 && m.total <= 4 << 40,
            "total={}",
            m.total
        );
        assert!(m.used > 0 && m.used <= m.total);
    }

    #[test]
    fn cpu_ticks_monotonic() {
        let r = new_reader();
        let a = r.cpu_ticks().expect("cpu");
        assert!(a.total() > 0);
        std::thread::sleep(Duration::from_millis(50));
        let b = r.cpu_ticks().expect("cpu #2");
        assert!(b.total() >= a.total());
        if let Some(p) = cpu_percent(a, b) {
            assert!((0.0..=100.0).contains(&p));
        }
    }

    #[test]
    fn boot_time_sane() {
        let bt = new_reader().boot_time().expect("boot");
        assert!(bt <= SystemTime::now());
        // 2015-01-01 이전이면 tv_sec 해석이 어긋난 것이다.
        assert!(bt > at(1_420_070_400));
    }

    #[test]
    fn disk_percent_in_range_and_bad_path() {
        let r = new_reader();
        let p = r.disk_percent("/").expect("disk");
        assert!((0.0..=100.0).contains(&p));
        let e = r.disk_percent("/definitely/not/a/mount/point").unwrap_err();
        assert_eq!(
            e.to_string(),
            "statfs /definitely/not/a/mount/point: no such file or directory"
        );
    }
}
