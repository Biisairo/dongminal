//! 진단 (Go `diag_snapshot_test.go`·`handlers_diag_test.go`).
//!
//! 스냅샷 줄은 `diag_line` 으로 직접 읽는다 — Go 는 전역 로그를 가로채 읽었다. 임계는 전역 값을
//! 낮추는 대신 인자로 넘긴다. 로그로 실제 나가는지는 한 시험만 전역 로그를 가로채 본다.
//! `TestDiagSnapshotQuietWhenNormal` 의 `runtime.GC()` 는 Rust 에 대응이 없어 옮기지 않았다(alloc 은
//! 늘 0 이다).

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use otter_shared_toolhub::Placement;
use tokio_util::sync::CancellationToken;

use super::fakes::FakeHub;
use super::support::{LOCAL, call, server};
use crate::diag_snapshot::{DIAG_WARN, DiagWarn, age_of, diag_loop, diag_warnings};
use crate::{Deps, Server, ToolHub};

fn bare() -> (tempfile::TempDir, Arc<Server>) {
    let d = tempfile::tempdir().unwrap();
    let s = server(d.path(), Deps::default());
    (d, s)
}

// V-CNR-7 (FR-CNR-8): 한 줄에 항목이 모두 있다.
#[test]
fn snapshot_has_all_fields() {
    let (_d, s) = bare();
    let line = s.diag_line(&DIAG_WARN);
    for key in [
        "diag ",
        "reqAge=",
        "wsAge=",
        "ws=",
        "tools=",
        "miss=",
        "goroutines=",
        "allocMB=",
    ] {
        assert!(line.contains(key), "스냅샷에 {key:?} 가 없다: {line}");
    }
    // 도구 허브가 없으면 셀 수 없었다는 뜻의 -1 이다.
    assert!(line.contains(" tools=-1 "), "{line}");
}

#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>);

impl Write for Buf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// V-CNR-8 (FR-CNR-9): 값이 그대로여도 매번 남긴다 — 실제 로그로 나간다.
#[test]
fn snapshot_repeats_when_unchanged() {
    let (_d, s) = bare();
    let buf = Buf::default();
    otter_shared_otterlog::init(otter_shared_otterlog::Options {
        level: String::new(),
        out: Some(Box::new(buf.clone())),
    });
    s.log_diag_snapshot();
    s.log_diag_snapshot();
    s.log_diag_snapshot();
    otter_shared_otterlog::reset();
    let out = String::from_utf8_lossy(&buf.0.lock().unwrap()).into_owned();
    assert_eq!(out.matches("diag reqAge=").count(), 3, "{out}");
}

// V-CNR-9 (FR-CNR-11): 로그에서 빠지는 요청도 reqAge 를 갱신한다.
#[tokio::test]
async fn last_request_updated_by_filtered_path() {
    let (_d, s) = bare();
    assert_eq!(s.conn.last_req.load(Ordering::Relaxed), 0);
    assert!(!crate::serve::should_log_request("/api/ping", 200));
    let r = call(&s, "GET", "/api/ping", &[], "", LOCAL).await;
    assert_eq!(r.status, 200);
    assert_ne!(s.conn.last_req.load(Ordering::Relaxed), 0);
    assert!(!s.diag_line(&DIAG_WARN).contains("reqAge=-"));
}

// FR-CNR-8: 요청이 온 적 없으면 reqAge 는 "-" 다.
#[test]
fn never_requested_shows_dash() {
    let (_d, s) = bare();
    assert!(s.diag_line(&DIAG_WARN).contains("reqAge=- wsAge=- "));
}

#[test]
fn age_of_truncates_to_seconds() {
    assert_eq!(age_of(0), "-");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64;
    assert_eq!(age_of(now - 90_500_000_000), "1m30s");
    // 미래 시각은 0 으로 접는다.
    assert_eq!(age_of(now + 10_000_000_000), "0s");
}

// V-CNR-10 (FR-CNR-12): 문맥이 끝나면 회차도 끝난다.
#[tokio::test]
async fn loop_stops_with_context() {
    let ctx = CancellationToken::new();
    let n = Arc::new(AtomicUsize::new(0));
    let c = n.clone();
    let h = tokio::spawn(diag_loop(
        ctx.clone(),
        Duration::from_millis(10),
        move || {
            c.fetch_add(1, Ordering::Relaxed);
        },
    ));
    tokio::time::sleep(Duration::from_millis(30)).await;
    ctx.cancel();
    tokio::time::timeout(Duration::from_secs(2), h)
        .await
        .expect("문맥이 끝났는데 회차가 살아 있다")
        .unwrap();
}

// FR-CNR-9·12: 주기마다 실제로 남는다.
#[tokio::test]
async fn loop_writes_periodically() {
    let ctx = CancellationToken::new();
    let n = Arc::new(AtomicUsize::new(0));
    let c = n.clone();
    let h = tokio::spawn(diag_loop(
        ctx.clone(),
        Duration::from_millis(10),
        move || {
            c.fetch_add(1, Ordering::Relaxed);
        },
    ));
    tokio::time::sleep(Duration::from_millis(120)).await;
    ctx.cancel();
    h.await.unwrap();
    assert!(
        n.load(Ordering::Relaxed) >= 2,
        "{}",
        n.load(Ordering::Relaxed)
    );
}

// FR-CNR-13: 임계를 넘으면 같은 줄에 무엇이 넘었는지 붙는다.
#[test]
fn snapshot_warns_over_threshold() {
    let (_d, s) = bare();
    let th = DiagWarn {
        goroutines: 0,
        ..DIAG_WARN
    };
    // 런타임 밖이라 task 수가 0 이다 — 판정은 순수 함수로 본다.
    assert_eq!(diag_warnings(&th, 1, 0, 0), "goroutines");
    assert_eq!(
        diag_warnings(&DIAG_WARN, 501, 257, 101),
        "goroutines,allocMB,ws"
    );
    s.conn.ws_open.store(1, Ordering::Relaxed);
    let line = s.diag_line(&DiagWarn { ws: 0, ..DIAG_WARN });
    assert!(line.ends_with(" warn=ws"), "{line}");
}

// 평시에는 울지 않는다.
#[test]
fn snapshot_quiet_when_normal() {
    let (_d, s) = bare();
    assert!(!s.diag_line(&DIAG_WARN).contains("warn="));
}

#[test]
fn diag_warn_defaults() {
    assert_eq!(
        DIAG_WARN,
        DiagWarn {
            goroutines: 500,
            alloc_mb: 256,
            ws: 100
        }
    );
}

fn diag_srv(hub: Option<Arc<FakeHub>>, version: &str) -> (tempfile::TempDir, Arc<Server>) {
    let d = tempfile::tempdir().unwrap();
    let s = Server::new(
        crate::Config {
            data_dir: d.path().to_path_buf(),
            version: version.to_owned(),
            ..crate::Config::default()
        },
        Deps {
            tools: hub.map(|h| h as Arc<dyn ToolHub>),
            ..Deps::default()
        },
    );
    (d, s)
}

async fn diag_of(s: &Arc<Server>) -> serde_json::Value {
    let r = super::support::get(s, "/api/diag").await;
    assert_eq!(r.status, 200);
    serde_json::from_str(&r.body).expect("JSON 이 아니다")
}

// TC-OBS-9: 표의 필드를 전부 낸다.
#[tokio::test]
async fn diag_has_all_fields() {
    let (_d, s) = diag_srv(Some(Arc::new(FakeHub::default())), "v-test");
    let r = super::support::get(&s, "/api/diag").await;
    let m: serde_json::Value = serde_json::from_str(&r.body).unwrap();
    for k in [
        "tools",
        "ws",
        "goroutines",
        "allocMB",
        "persistErr",
        "gate",
        "reconnects",
        "uptime",
        "version",
        "logLevel",
    ] {
        assert!(m.get(k).is_some(), "필드 {k:?} 가 없다: {m}");
    }
    assert!(m["gate"].get("access").is_some() && m["gate"].get("request").is_some());
    assert_eq!(m["version"], "v-test");
    // 필드 순서는 Go 구조체 순서다.
    let keys: Vec<&str> = r
        .body
        .split('"')
        .skip(1)
        .step_by(2)
        .filter(|k| {
            [
                "tools",
                "ws",
                "goroutines",
                "allocMB",
                "persistErr",
                "gate",
                "reconnects",
                "uptime",
                "version",
                "logLevel",
            ]
            .contains(k)
        })
        .collect();
    assert_eq!(
        keys,
        [
            "tools",
            "ws",
            "goroutines",
            "allocMB",
            "persistErr",
            "gate",
            "reconnects",
            "uptime",
            "version",
            "logLevel"
        ]
    );
}

// TC-OBS-10: 거절 수가 실제 거절에 따라 오른다.
#[tokio::test]
async fn diag_gate_counters_rise() {
    let (_d, s) = diag_srv(Some(Arc::new(FakeHub::default())), "");
    let before = diag_of(&s).await["gate"].clone();
    // 출처 거절(쓰기 요청에 낯선 Origin)과 기기 거절(허용 목록 밖 출발지).
    let r = call(
        &s,
        "POST",
        "/api/ping",
        &[
            ("Origin", "http://evil.example"),
            ("Content-Type", "application/json"),
        ],
        "{}",
        LOCAL,
    )
    .await;
    assert_eq!(r.status, 403, "{}", r.body);
    crate::access_api::ACCESS_DENIES.fetch_add(1, Ordering::Relaxed);
    let after = diag_of(&s).await["gate"].clone();
    assert!(after["request"].as_i64() > before["request"].as_i64());
    assert!(after["access"].as_i64() > before["access"].as_i64());
}

// TC-OBS-11: 개별 식별 정보를 싣지 않는다 (FR-OBS-13 / D-OBS-5).
#[tokio::test]
async fn diag_carries_no_identifying_info() {
    let hub = Arc::new(FakeHub::default());
    hub.create("/Users/secret/project", 80, 24, &Placement::default())
        .unwrap();
    let (_d, s) = diag_srv(Some(hub), "");
    let r = call(&s, "GET", "/api/diag", &[], "", "127.0.0.1:5555").await;
    assert_eq!(r.status, 200);
    assert!(r.body.contains("\"tools\":1,"), "{}", r.body);
    for leak in ["127.0.0.1:5555", "/Users/secret", "fake1", "Fake"] {
        assert!(
            !r.body.contains(leak),
            "{leak:?} 가 응답에 실렸다: {}",
            r.body
        );
    }
}

// FR-OBS-14: 헬스와 겹치지 않는다.
#[tokio::test]
async fn diag_does_not_duplicate_health() {
    let (_d, s) = diag_srv(Some(Arc::new(FakeHub::default())), "");
    let m = diag_of(&s).await;
    for k in ["daemon", "workspace", "mismatch"] {
        assert!(m.get(k).is_none(), "헬스의 것이 진단에 있다: {k}");
    }
}
