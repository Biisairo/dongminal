//! 끊긴 순간의 기록 (Go `diag_snapshot.go`, CONNECTIVITY_RESILIENCE_SRS 묶음 B, FR-CNR-8~13).
//!
//! 주기마다 한 줄을 남긴다. 요청이 오지 않은 구간과 서버가 멈춘 구간을 `reqAge` 로 가른다.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use otter_shared_otterlog::infof;
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::handlers_diag::{alloc_mb, live_tasks};

/// 스냅샷 주기다. 60초에 한 줄이면 하루 1,440줄이다.
pub const DIAG_SNAPSHOT_EVERY: Duration = Duration::from_secs(60);

/// 경고 임계다 (FR-CNR-13). `hold` 의 32 는 대기 상한과 같은 값이다 (FR-STA-9).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DiagWarn {
    pub(crate) goroutines: usize,
    pub(crate) alloc_mb: u64,
    pub(crate) ws: i64,
    pub(crate) hold: i64,
}

pub(crate) const DIAG_WARN: DiagWarn = DiagWarn {
    goroutines: 500,
    alloc_mb: 256,
    ws: 100,
    hold: 32,
};

/// 넘은 항목의 이름들이다. 없으면 빈 문자열이다.
pub(crate) fn diag_warnings(
    th: &DiagWarn,
    goroutines: usize,
    alloc_mb: u64,
    ws: i64,
    hold: i64,
) -> String {
    let mut over = Vec::new();
    if goroutines > th.goroutines {
        over.push("goroutines");
    }
    if alloc_mb > th.alloc_mb {
        over.push("allocMB");
    }
    if ws > th.ws {
        over.push("ws");
    }
    if hold > th.hold {
        over.push("hold");
    }
    over.join(",")
}

/// 단조가 아닌 벽시계 나노초를 "몇 초 전" 으로 옮긴다. 한 번도 없었으면 `-` 다 — 0 으로 적으면
/// 방금 왔다로 읽힌다.
pub(crate) fn age_of(ns: i64) -> String {
    if ns == 0 {
        return "-".to_owned();
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_nanos()).unwrap_or(i64::MAX))
        .unwrap_or_default();
    let d = u64::try_from(now.saturating_sub(ns)).unwrap_or(0);
    otter_gocompat::time::format_std_duration(Duration::from_secs(d / 1_000_000_000))
}

/// 주기마다 `tick` 을 부른다. `ctx` 가 끝나면 함께 끝난다 (FR-CNR-12).
pub(crate) async fn diag_loop(ctx: CancellationToken, every: Duration, mut tick: impl FnMut()) {
    let mut t = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
    loop {
        tokio::select! {
            _ = ctx.cancelled() => return,
            _ = t.tick() => tick(),
        }
    }
}

impl Server {
    /// Go `runDiagSnapshots`.
    pub(crate) async fn run_diag_snapshots(
        self: Arc<Self>,
        ctx: CancellationToken,
        every: Duration,
    ) {
        // 도구 수가 데몬 RPC 를 탈 수 있어 블로킹 자리에서 센다.
        diag_loop(ctx, every, || {
            let s = Arc::clone(&self);
            tokio::task::spawn_blocking(move || s.log_diag_snapshot());
        })
        .await;
    }

    /// 한 줄을 남긴다. 값이 변하지 않아도 남긴다 (FR-CNR-9).
    pub(crate) fn log_diag_snapshot(&self) {
        infof!(None, "{}", self.diag_line(&DIAG_WARN));
    }

    /// 스냅샷 한 줄이다. 경고는 같은 줄에 붙는다 (FR-CNR-13).
    pub(crate) fn diag_line(&self, th: &DiagWarn) -> String {
        let ws = self.conn.ws_open.load(Ordering::Relaxed);
        let hold = self.conn.holds.load(Ordering::Relaxed);
        let (goroutines, alloc) = (live_tasks(), alloc_mb());
        let mut warn = diag_warnings(th, goroutines, alloc, ws, hold);
        if !warn.is_empty() {
            warn = format!(" warn={warn}");
        }
        format!(
            "diag reqAge={} wsAge={} ws={ws} tools={} miss={} hold={hold} goroutines={goroutines} allocMB={alloc}{warn}",
            age_of(self.conn.last_req.load(Ordering::Relaxed)),
            age_of(self.conn.last_ws.load(Ordering::Relaxed)),
            self.tool_count(),
            self.conn.misses.size(),
        )
    }

    /// 살아 있는 도구 수다. 도구 허브가 없으면 -1 이다 — 0 은 "도구가 없다" 로 읽힌다.
    fn tool_count(&self) -> i64 {
        match self.deps.tools.as_ref() {
            Some(t) => i64::try_from(t.list().len()).unwrap_or(i64::MAX),
            None => -1,
        }
    }
}
