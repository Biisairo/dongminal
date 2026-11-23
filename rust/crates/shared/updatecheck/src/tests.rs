//! Go `checker_test.go` 이식. 실제 GitHub 으로 나가지 않는다 (TC-UPD-14).

use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};

const SETTLE_WAIT: Duration = Duration::from_secs(3);
const QUIET_WAIT: Duration = Duration::from_millis(150);

/// 릴리스 자리를 흉내내며 몇 번 물었는지 센다 (UPDATE_NOTICE_SRS §3.4).
struct Probe {
    url: String,
    hits: Arc<AtomicUsize>,
    tag: Arc<Mutex<String>>,
    fail: Arc<AtomicBool>,
    /// false 인 동안 응답을 붙잡는다.
    open: watch::Sender<bool>,
}

impl Probe {
    fn count(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
    fn set_tag(&self, t: &str) {
        *self.tag.lock().unwrap() = t.to_owned();
    }
}

/// 격리 규칙(C-RSP-1): 60147 이상의 포트만 쓴다.
async fn listen() -> (TcpListener, u16) {
    for port in 60147u16..64000 {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", port)).await {
            return (l, port);
        }
    }
    panic!("빈 포트가 없다");
}

async fn new_probe(tag: &str, open: bool) -> Probe {
    let (l, port) = listen().await;
    let hits = Arc::new(AtomicUsize::new(0));
    let tag = Arc::new(Mutex::new(tag.to_owned()));
    let fail = Arc::new(AtomicBool::new(false));
    let (open_tx, open_rx) = watch::channel(open);
    let (h, t, f) = (Arc::clone(&hits), Arc::clone(&tag), Arc::clone(&fail));
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            let (h, t, f, mut gate) = (
                Arc::clone(&h),
                Arc::clone(&t),
                Arc::clone(&f),
                open_rx.clone(),
            );
            tokio::spawn(async move {
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    match c.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => req.extend_from_slice(&buf[..n]),
                    }
                }
                h.fetch_add(1, Ordering::SeqCst);
                let _ = gate.wait_for(|o| *o).await;
                let resp = if f.load(Ordering::SeqCst) {
                    "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
                } else {
                    let cur = t.lock().unwrap().clone();
                    let body =
                        format!(r#"{{"tag_name":"{cur}","html_url":"https://example/rel/{cur}"}}"#);
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                };
                let _ = c.write_all(resp.as_bytes()).await;
            });
        }
    });
    Probe {
        url: format!("http://127.0.0.1:{port}/"),
        hits,
        tag,
        fail,
        open: open_tx,
    }
}

struct Fixture {
    c: Checker,
    settled: mpsc::UnboundedReceiver<()>,
    _home: tempfile::TempDir,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.c.stop();
    }
}

fn new_checker(p: &Probe, mut opt: Options) -> Fixture {
    let home = tempfile::tempdir().unwrap();
    if opt.home.as_os_str().is_empty() {
        opt.home = home.path().to_owned();
    }
    if opt.current.is_empty() {
        opt.current = "v1.0.0".into();
    }
    if opt.interval.is_zero() {
        opt.interval = Duration::from_secs(3600);
    }
    opt.endpoint = p.url.clone();
    let c = Checker::new(opt);
    let (tx, settled) = mpsc::unbounded_channel();
    c.on_settle(Arc::new(move || {
        let _ = tx.send(());
    }));
    Fixture {
        c,
        settled,
        _home: home,
    }
}

impl Fixture {
    async fn wait_settle(&mut self) {
        tokio::time::timeout(SETTLE_WAIT, self.settled.recv())
            .await
            .expect("확인이 끝나지 않았다");
    }
    async fn quiet(&mut self) {
        let r = tokio::time::timeout(QUIET_WAIT, self.settled.recv()).await;
        assert!(r.is_err(), "돌지 않아야 할 확인이 돌았다");
    }
}

fn enabled() -> Options {
    Options {
        enabled: true,
        ..Options::default()
    }
}

// ── §1.2 불변 조항: 끈 것은 실제로 나가지 않아야 한다 ──

// TC-UPD-1
#[tokio::test(flavor = "multi_thread")]
async fn disabled_never_leaves() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(&p, Options::default());
    f.c.start();
    f.c.trigger();
    f.quiet().await;
    assert_eq!(p.count(), 0, "꺼져 있는데 나갔다");
}

// TC-UPD-2: 환경변수는 다른 모든 계층을 이긴다 (FR-UPD-11).
#[tokio::test(flavor = "multi_thread")]
async fn env_kill_switch_wins() {
    let p = new_probe("v9.9.9", true).await;
    let getenv: Getenv = Arc::new(|k: &str| {
        if k == dm_shared_dmenv::ENV_NO_CHECK {
            "1".into()
        } else {
            String::new()
        }
    });
    let mut f = new_checker(
        &p,
        Options {
            getenv: Some(getenv),
            ..enabled()
        },
    );
    f.c.start();
    f.c.trigger();
    f.quiet().await;
    assert_eq!(p.count(), 0, "킬스위치를 켰는데 나갔다");
    assert!(!f.c.snapshot().enabled, "막혀 있는데 켜졌다고 답한다");
}

// TC-UPD-15
#[tokio::test(flavor = "multi_thread")]
async fn disabled_survives_all_triggers() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(
        &p,
        Options {
            interval: Duration::from_millis(20),
            ..Options::default()
        },
    );
    f.c.start();
    for _ in 0..50 {
        f.c.trigger();
    }
    f.quiet().await;
    assert_eq!(p.count(), 0);
}

// ── 트리거 넷 (FR-UPD-2) ──

// TC-UPD-3
#[tokio::test(flavor = "multi_thread")]
async fn start_checks_once() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(&p, enabled());
    f.c.start();
    f.wait_settle().await;
    assert_eq!(p.count(), 1);
}

// TC-UPD-3a
#[tokio::test(flavor = "multi_thread")]
async fn trigger_checks() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(&p, enabled());
    f.c.trigger();
    f.wait_settle().await;
    assert_eq!(p.count(), 1);
}

// TC-UPD-3b: 동시 트리거 열 번에도 요청은 1건이다 (FR-UPD-2b).
#[tokio::test(flavor = "multi_thread")]
async fn concurrent_triggers_collapse() {
    let p = new_probe("v9.9.9", false).await;
    let mut f = new_checker(&p, enabled());
    let mut joins = Vec::new();
    for _ in 0..10 {
        let c = f.c.clone();
        joins.push(std::thread::spawn(move || c.trigger()));
    }
    for j in joins {
        j.join().unwrap();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    p.open.send_replace(true);
    f.wait_settle().await;
    assert_eq!(p.count(), 1, "single-flight 아님");
}

// TC-UPD-3c: 순차 트리거는 트리거마다 갱신한다.
#[tokio::test(flavor = "multi_thread")]
async fn sequential_triggers_each_check() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(&p, enabled());
    for _ in 0..3 {
        f.c.trigger();
        f.wait_settle().await;
    }
    assert_eq!(p.count(), 3);
}

// TC-UPD-3g·3h: 타이머는 확인이 끝날 때마다 다시 걸린다 (FR-UPD-2c).
#[tokio::test(flavor = "multi_thread")]
async fn timer_rearms() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(
        &p,
        Options {
            interval: Duration::from_millis(40),
            ..enabled()
        },
    );
    f.c.start();
    for _ in 0..3 {
        f.wait_settle().await;
    }
    assert!(p.count() >= 3, "타이머가 다시 걸리지 않았다: {}", p.count());
}

// ── 판정 (FR-UPD-9b, TC-UPD-5·6) ──

#[tokio::test(flavor = "multi_thread")]
async fn newer_version_is_reported() {
    let p = new_probe("v1.10.0", true).await;
    let mut f = new_checker(
        &p,
        Options {
            current: "v1.9.0".into(),
            ..enabled()
        },
    );
    f.c.trigger();
    f.wait_settle().await;
    let s = f.c.snapshot();
    assert!(s.newer, "v1.10.0 > v1.9.0 을 놓쳤다: {s:?}");
    assert_eq!(s.latest, "v1.10.0");
    assert_eq!(s.link, "https://example/rel/v1.10.0");
    assert!(dm_gocompat::time::parse_rfc3339(&s.checked_at).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn same_version_is_not_newer() {
    let p = new_probe("v1.0.0", true).await;
    let mut f = new_checker(&p, enabled());
    f.c.trigger();
    f.wait_settle().await;
    assert!(!f.c.snapshot().newer);
}

// TC-UPD-6
#[tokio::test(flavor = "multi_thread")]
async fn dev_build_never_newer() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(
        &p,
        Options {
            current: "dev".into(),
            ..enabled()
        },
    );
    f.c.trigger();
    f.wait_settle().await;
    assert!(!f.c.snapshot().newer);
}

// ── 실패 (FR-UPD-2e, TC-UPD-3d·3e·3f) ──

#[tokio::test(flavor = "multi_thread")]
async fn failure_keeps_previous_result() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(&p, enabled());
    f.c.trigger();
    f.wait_settle().await;
    let before = f.c.snapshot();
    p.fail.store(true, Ordering::SeqCst);
    f.c.trigger();
    f.wait_settle().await;
    let after = f.c.snapshot();
    assert_eq!(
        (&after.latest, after.newer),
        (&before.latest, before.newer),
        "실패가 직전 결과를 덮었다"
    );
    assert!(after.failed);
}

#[tokio::test(flavor = "multi_thread")]
async fn failure_without_prior_is_unknown() {
    let p = new_probe("v9.9.9", true).await;
    p.fail.store(true, Ordering::SeqCst);
    let mut f = new_checker(&p, enabled());
    f.c.trigger();
    f.wait_settle().await;
    let s = f.c.snapshot();
    assert!(
        !s.newer && s.latest.is_empty(),
        "모르는 것을 안다고 했다: {s:?}"
    );
    assert!(s.failed);
}

// TC-UPD-3f: 백오프가 없다.
#[tokio::test(flavor = "multi_thread")]
async fn failure_retries_on_next_trigger() {
    let p = new_probe("v9.9.9", true).await;
    p.fail.store(true, Ordering::SeqCst);
    let mut f = new_checker(&p, enabled());
    f.c.trigger();
    f.wait_settle().await;
    p.fail.store(false, Ordering::SeqCst);
    f.c.trigger();
    f.wait_settle().await;
    assert!(f.c.snapshot().newer);
    assert_eq!(p.count(), 2);
}

// ── 방송 (FR-UPD-8a·8b, TC-UPD-7a·7b) ──

#[tokio::test(flavor = "multi_thread")]
async fn broadcasts_only_on_change() {
    let p = new_probe("v1.0.0", true).await;
    let casts = Arc::new(AtomicUsize::new(0));
    let c2 = Arc::clone(&casts);
    let mut f = new_checker(
        &p,
        Options {
            broadcast: Some(Arc::new(move || {
                c2.fetch_add(1, Ordering::SeqCst);
            })),
            ..enabled()
        },
    );
    f.c.trigger();
    f.wait_settle().await;
    assert_eq!(casts.load(Ordering::SeqCst), 1, "첫 결과를 알리지 않았다");
    f.c.trigger();
    f.wait_settle().await;
    assert_eq!(casts.load(Ordering::SeqCst), 1, "바뀌지 않았는데 방송했다");
    p.set_tag("v2.0.0");
    f.c.trigger();
    f.wait_settle().await;
    assert_eq!(casts.load(Ordering::SeqCst), 2, "바뀌었는데 알리지 않았다");
}

// ── 토글 (FR-UPD-13·14, TC-UPD-8·9·9a) ──

#[tokio::test(flavor = "multi_thread")]
async fn set_enabled_persists_and_stops() {
    let p = new_probe("v9.9.9", true).await;
    let home = tempfile::tempdir().unwrap();
    let mut f = new_checker(
        &p,
        Options {
            home: home.path().to_owned(),
            interval: Duration::from_millis(30),
            ..enabled()
        },
    );
    f.c.start();
    f.wait_settle().await;
    f.c.set_enabled(false).unwrap();
    f.quiet().await;
    let data = std::fs::read_to_string(home.path().join(dm_shared_serverconf::FILE_NAME)).unwrap();
    assert!(
        data.contains(r#""updateCheck": false"#),
        "server.json 에 남지 않았다: {data}"
    );
    assert!(!f.c.snapshot().enabled);
}

// TC-UPD-9: 끔→켬 은 트리거 ④ 다.
#[tokio::test(flavor = "multi_thread")]
async fn set_enabled_true_checks() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(&p, Options::default());
    f.c.set_enabled(true).unwrap();
    f.wait_settle().await;
    assert_eq!(p.count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn set_enabled_true_when_already_on_does_not_check() {
    let p = new_probe("v9.9.9", true).await;
    let mut f = new_checker(&p, enabled());
    f.c.set_enabled(true).unwrap();
    f.quiet().await;
    assert_eq!(p.count(), 0);
}

// TC-UPD-9a: 도는 중에 끄면 그 결과를 쓰지 않는다 (§1.2).
#[tokio::test(flavor = "multi_thread")]
async fn disable_during_flight_discards_result() {
    let p = new_probe("v9.9.9", false).await;
    let mut f = new_checker(&p, enabled());
    f.c.trigger();
    tokio::time::sleep(Duration::from_millis(80)).await;
    f.c.set_enabled(false).unwrap();
    p.open.send_replace(true);
    f.wait_settle().await;
    let s = f.c.snapshot();
    assert!(
        !s.newer && s.latest.is_empty(),
        "끈 뒤에도 결과를 썼다: {s:?}"
    );
}

// NFR-UPD-3, TC-UPD-7
#[tokio::test(flavor = "multi_thread")]
async fn snapshot_never_fetches() {
    let p = new_probe("v9.9.9", true).await;
    let f = new_checker(&p, enabled());
    for _ in 0..100 {
        let _ = f.c.snapshot();
    }
    assert_eq!(p.count(), 0);
}

// 화면이 받는 JSON 꼴(Go `json:"..."` 태그, omitempty).
#[test]
fn snapshot_json_shape() {
    let s = Snapshot {
        enabled: true,
        current: "v1.0.0".into(),
        ..Snapshot::default()
    };
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal(&s).unwrap()).unwrap(),
        r#"{"enabled":true,"current":"v1.0.0","newer":false,"failed":false}"#
    );
    let s = Snapshot {
        latest: "v2".into(),
        newer: true,
        link: "l".into(),
        checked_at: "t".into(),
        failed: true,
        ..s
    };
    assert_eq!(
        String::from_utf8(dm_gocompat::json::marshal(&s).unwrap()).unwrap(),
        r#"{"enabled":true,"current":"v1.0.0","latest":"v2","newer":true,"link":"l","checkedAt":"t","failed":true}"#
    );
}

// 런타임 밖에서 만든 확인기도 OS 스레드로 돈다.
#[test]
fn works_without_runtime() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let p = rt.block_on(new_probe("v9.9.9", true));
    let mut f = new_checker(&p, enabled());
    f.c.trigger();
    rt.block_on(f.wait_settle());
    assert!(f.c.snapshot().newer);
}

#[derive(Clone, Default)]
struct LogBuf(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for LogBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// FR-UPD-4: 실패는 로그에만 남는다. 전송 오류는 Go `*url.Error` 문구다(이슈 1.6).
#[tokio::test(flavor = "multi_thread")]
async fn failure_is_logged_with_go_error_text() {
    let buf = LogBuf::default();
    dm_shared_dmlog::init(dm_shared_dmlog::Options {
        level: "warn".into(),
        out: Some(Box::new(buf.clone())),
    });
    let port = (64000u16..=65000)
        .rev()
        .find(|&p| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok())
        .unwrap();
    let url = format!("http://127.0.0.1:{port}/");
    let c = Checker::new(Options {
        home: std::env::temp_dir(),
        current: "v1.0.0".into(),
        endpoint: url.clone(),
        interval: Duration::from_secs(3600),
        ..enabled()
    });
    let (tx, mut settled) = mpsc::unbounded_channel();
    c.on_settle(Arc::new(move || {
        let _ = tx.send(());
    }));
    c.trigger();
    tokio::time::timeout(SETTLE_WAIT, settled.recv())
        .await
        .unwrap();
    c.stop();
    let text = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
    dm_shared_dmlog::reset();
    let want = format!(
        "판 확인 실패: Get \"{url}\": dial tcp 127.0.0.1:{port}: connect: connection refused"
    );
    let want = format!("msg={}", dm_gocompat::strconv::quote(&want));
    assert!(text.contains(&want), "{text}");
}
