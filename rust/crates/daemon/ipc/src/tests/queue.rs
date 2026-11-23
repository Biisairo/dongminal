//! 읽기 루프 밖의 일 — 도구별 직렬 큐(paste·write·input)와 느린 생성 (paste_async_test.go ·
//! notify_async_test.go).

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use dm_shared_toolhub::Placement;

use super::fake::{Hold, fake_tools, get};
use super::{curr, daemon, raw};
use crate::conn::{PANED_SLOW_MAX, SERIAL_QUEUE_MAX, SerialQueue, lock};

const PASTE_TEXT: &[u8] = b"hi";

fn paste(id: i64, tool: &str) -> String {
    format!(
        r#"{{"id":{id},"method":"paste","params":{{"id":"{tool}","data":"aGk=","submit":true}}}}"#
    )
}

/// 풀릴 때까지 닫힌 문이다.
#[derive(Clone, Default)]
struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    fn wait(&self) {
        let (m, cv) = &*self.0;
        let mut open = lock(m);
        while !*open {
            open = cv.wait(open).unwrap_or_else(|p| p.into_inner());
        }
    }

    fn open(&self) {
        *lock(&self.0.0) = true;
        self.0.1.notify_all();
    }
}

/// paste 의 글(hi)을 쓰기 직전에 문을 기다린다. 들어올 때마다 entered 로 알린다.
fn hold_paste(gate: &Gate) -> (Hold, mpsc::Receiver<()>) {
    let (tx, rx) = mpsc::channel();
    let g = gate.clone();
    let tx = Mutex::new(tx);
    let h: Hold = Arc::new(move |_: &str, b: &[u8]| {
        if b == PASTE_TEXT {
            let _ = lock(&tx).send(());
            g.wait();
        }
    });
    (h, rx)
}

fn wait_until(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !f() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// paste 가 제출 틈을 기다리는 동안에도 이 연결의 다른 요청은 바로 답한다 (S6).
#[tokio::test(flavor = "multi_thread")]
async fn paste_does_not_block_dispatch() {
    let d = daemon("b");
    let gate = Gate::default();
    let (h, _entered) = hold_paste(&gate);
    let _reg = fake_tools(&d.srv.inner.pm, Some(h), &["a"]);
    let mut c = raw(&d.sock);
    c.send(&paste(1, "a"));
    c.send(r#"{"id":2,"method":"busy","params":{"id":"a"}}"#);
    assert_eq!(c.recv(), r#"{"id":2,"result":{"busy":false}}"#);
    gate.open();
    assert_eq!(c.recv(), r#"{"id":1,"result":{}}"#);
}

/// 같은 도구의 paste 끼리는 겹치지 않는다. 다른 도구는 기다리지 않는다 (S6).
#[tokio::test(flavor = "multi_thread")]
async fn paste_serialized_per_tool() {
    let d = daemon("b");
    let in_a = Arc::new(AtomicI64::new(0));
    let max_a = Arc::new(AtomicI64::new(0));
    let probes = Arc::new(AtomicI64::new(0));
    let (ia, ma, pr) = (Arc::clone(&in_a), Arc::clone(&max_a), Arc::clone(&probes));
    let h: Hold = Arc::new(move |id: &str, b: &[u8]| {
        if b != PASTE_TEXT {
            return;
        }
        pr.fetch_add(1, Ordering::SeqCst);
        if id == "a" {
            let n = ia.fetch_add(1, Ordering::SeqCst) + 1;
            ma.fetch_max(n, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(20));
            ia.fetch_sub(1, Ordering::SeqCst);
        }
    });
    let _reg = fake_tools(&d.srv.inner.pm, Some(h), &["a", "b"]);
    let mut c = raw(&d.sock);
    c.send(&paste(1, "a"));
    c.send(&paste(2, "a"));
    c.send(&paste(3, "b"));
    let mut got: Vec<String> = (0..3).map(|_| c.recv()).collect();
    got.sort();
    assert_eq!(
        got,
        [
            r#"{"id":1,"result":{}}"#,
            r#"{"id":2,"result":{}}"#,
            r#"{"id":3,"result":{}}"#
        ]
    );
    assert_eq!(
        max_a.load(Ordering::SeqCst),
        1,
        "같은 도구의 paste 가 겹쳤다"
    );
    assert_eq!(probes.load(Ordering::SeqCst), 3);
}

/// 같은 키의 일은 넣은 순서대로 하나씩 돈다. 다른 키는 기다리지 않는다. 다 돌면 키를 지운다.
#[test]
fn serial_queue_fifo() {
    let q = Arc::new(SerialQueue::default());
    let order = Arc::new(Mutex::new(Vec::new()));
    let (done_tx, done_rx) = mpsc::channel();
    for i in 0..20 {
        let o = Arc::clone(&order);
        let tx = done_tx.clone();
        assert!(SerialQueue::run(
            &q,
            "a",
            Box::new(move || {
                if i == 0 {
                    std::thread::sleep(Duration::from_millis(30));
                }
                lock(&o).push(i);
                let _ = tx.send(());
            })
        ));
    }
    let (tx, rx) = mpsc::channel();
    SerialQueue::run(
        &q,
        "b",
        Box::new(move || {
            let _ = tx.send(());
        }),
    );
    rx.recv_timeout(Duration::from_secs(1))
        .expect("다른 키가 기다렸다");
    for _ in 0..20 {
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    }
    assert_eq!(*lock(&order), (0..20).collect::<Vec<_>>());
    wait_until("빈 키가 남았다", || !q.busy("a") && !q.busy("b"));
}

/// 줄에는 깊이 상한이 있다. 넘치면 넣지 않고 거짓이다. 다른 키는 막히지 않는다.
#[test]
fn serial_queue_depth_limit() {
    let q = Arc::new(SerialQueue::default());
    let gate = Gate::default();
    let (tx, running) = mpsc::channel();
    let g = gate.clone();
    assert!(SerialQueue::run(
        &q,
        "a",
        Box::new(move || {
            let _ = tx.send(());
            g.wait();
        })
    ));
    running.recv().unwrap();
    for i in 0..SERIAL_QUEUE_MAX {
        assert!(SerialQueue::run(&q, "a", Box::new(|| {})), "{}번째", i + 1);
    }
    assert!(
        !SerialQueue::run(&q, "a", Box::new(|| {})),
        "상한을 넘어 넣었다"
    );
    assert!(
        SerialQueue::run(&q, "b", Box::new(|| {})),
        "다른 키까지 막혔다"
    );
    gate.open();
}

/// 와이어에서도 줄이 넘치면 CODE_SERVER 로 거절한다.
#[tokio::test(flavor = "multi_thread")]
async fn queue_full_is_server_error() {
    let d = daemon("b");
    let gate = Gate::default();
    let (h, entered) = hold_paste(&gate);
    let _reg = fake_tools(&d.srv.inner.pm, Some(h), &["a"]);
    let mut c = raw(&d.sock);
    c.send(&paste(1, "a"));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let last = i64::try_from(SERIAL_QUEUE_MAX).unwrap() + 2;
    for id in 2..last {
        c.send(&format!(
            r#"{{"id":{id},"method":"write","params":{{"id":"a","data":"eA=="}}}}"#
        ));
    }
    assert_eq!(
        c.call(&format!(
            r#"{{"id":{last},"method":"write","params":{{"id":"a","data":"eA=="}}}}"#
        )),
        format!(
            r#"{{"id":{last},"error":{{"code":-32000,"message":"도구의 입력 줄이 가득 찼다"}}}}"#
        )
    );
    gate.open();
    for id in 1..last {
        assert_eq!(c.recv(), format!(r#"{{"id":{id},"result":{{}}}}"#));
    }
}

/// 조건 없는 paste 와 write 도 같은 도구의 줄 뒤에 선다. 다른 요청은 기다리지 않는다.
#[tokio::test(flavor = "multi_thread")]
async fn paste_and_write_queue_behind_paste() {
    let d = daemon("b");
    let gate = Gate::default();
    let first = Arc::new(AtomicBool::new(true));
    let (f, g) = (Arc::clone(&first), gate.clone());
    let h: Hold = Arc::new(move |_: &str, b: &[u8]| {
        if b == PASTE_TEXT && f.swap(false, Ordering::SeqCst) {
            g.wait();
        }
    });
    let reg = fake_tools(&d.srv.inner.pm, Some(h), &["a"]);
    let mut c = raw(&d.sock);
    c.send(&paste(1, "a"));
    c.send(&paste(2, "a"));
    c.send(r#"{"id":3,"method":"write","params":{"id":"a","data":"eA=="}}"#);
    c.send(r#"{"id":4,"method":"busy","params":{"id":"a"}}"#);
    assert_eq!(c.recv(), r#"{"id":4,"result":{"busy":false}}"#);
    gate.open();
    for id in 1..=3 {
        assert_eq!(c.recv(), format!(r#"{{"id":{id},"result":{{}}}}"#));
    }
    assert_eq!(get(&reg, "a").written(), b"hi\rhi\rx");
}

/// 연결이 끊긴 뒤에는 줄에 남은 write·input 을 도구에 넣지 않는다. 이미 돌던 paste 는 끝까지 돈다.
#[tokio::test(flavor = "multi_thread")]
async fn queued_write_skipped_after_stop() {
    let d = daemon("b");
    let gate = Gate::default();
    let (h, entered) = hold_paste(&gate);
    let reg = fake_tools(&d.srv.inner.pm, Some(h), &["a"]);
    let mut c = raw(&d.sock);
    c.send(&paste(1, "a"));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    c.send(r#"{"id":2,"method":"write","params":{"id":"a","data":"UVFXUklURVFR"}}"#);
    c.send(r#"{"method":"input","params":{"id":"a","data":"UVFJTlBVVFFR"}}"#);
    c.send(r#"{"id":3,"method":"busy","params":{"id":"a"}}"#);
    assert_eq!(c.recv(), r#"{"id":3,"result":{"busy":false}}"#);
    let conn = curr(&d);
    drop(c);
    wait_until("연결이 멈추지 않았다", || conn.is_done());
    gate.open();
    wait_until("줄이 비지 않았다", || !conn.tool_busy("a"));
    assert_eq!(get(&reg, "a").written(), b"hi\r");
}

/// 줄이 있는 도구의 input(응답 없는 키 입력)도 줄 뒤에 선다.
#[tokio::test(flavor = "multi_thread")]
async fn input_queues_behind_paste() {
    let d = daemon("b");
    let gate = Gate::default();
    let (h, entered) = hold_paste(&gate);
    let reg = fake_tools(&d.srv.inner.pm, Some(h), &["a"]);
    let a = get(&reg, "a");
    let mut c = raw(&d.sock);
    c.send(&paste(1, "a"));
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    c.send(r#"{"method":"input","params":{"id":"a","data":"aW4="}}"#);
    c.send(r#"{"id":2,"method":"busy","params":{"id":"a"}}"#);
    assert_eq!(c.recv(), r#"{"id":2,"result":{"busy":false}}"#);
    assert!(a.written().is_empty(), "input 이 줄을 앞질렀다");
    gate.open();
    assert_eq!(c.recv(), r#"{"id":1,"result":{}}"#);
    wait_until("input 이 닿지 않았다", || a.written().len() == 5);
    assert_eq!(a.written(), b"hi\rin");
}

/// 알림(input·resizenotify)은 RPC 와 같은 자리에 닿는다.
#[tokio::test(flavor = "multi_thread")]
async fn notify_reaches_tool() {
    let d = daemon("b");
    let reg = fake_tools(&d.srv.inner.pm, None, &["a"]);
    let mut c = raw(&d.sock);
    c.send(r#"{"method":"resizenotify","params":{"id":"a","cols":101,"rows":33}}"#);
    c.send(r#"{"method":"input","params":{"id":"a","data":"aGk="}}"#);
    c.send(r#"{"id":1,"method":"busy","params":{"id":"a"}}"#);
    assert_eq!(
        c.recv(),
        r#"{"cols":101,"event":"size","rows":33,"tool":"a"}"#
    );
    assert_eq!(c.recv(), r#"{"id":1,"result":{"busy":false}}"#);
    assert_eq!(d.srv.inner.pm.get("a").unwrap().size(), Some((101, 33)));
    assert_eq!(get(&reg, "a").written(), b"hi");
}

/// 배치를 기다리게 하는 placer 를 꽂는다. 동시에 도는 수의 최대를 센다.
fn blocking_placer(d: &super::Daemon, gate: &Gate) -> (Arc<AtomicI64>, Arc<AtomicI64>) {
    let cur = Arc::new(AtomicI64::new(0));
    let peak = Arc::new(AtomicI64::new(0));
    let (c, p, g) = (Arc::clone(&cur), Arc::clone(&peak), gate.clone());
    d.srv.inner.pm.set_placer(Arc::new(move |_: &Placement| {
        let n = c.fetch_add(1, Ordering::SeqCst) + 1;
        p.fetch_max(n, Ordering::SeqCst);
        g.wait();
        c.fetch_sub(1, Ordering::SeqCst);
        Err(std::io::Error::other("placer released"))
    }));
    (cur, peak)
}

const CREATE_SANDBOX: &str = r#""params":{"cwd":"/tmp","cols":80,"rows":24,"profile":"p"}"#;

/// 배치가 멎어 있는 동안에도 같은 연결의 list 가 답을 받는다 (FR-OPT-2-3).
#[tokio::test(flavor = "multi_thread")]
async fn create_does_not_block_dispatch() {
    let d = daemon("b");
    let gate = Gate::default();
    blocking_placer(&d, &gate);
    let mut c = raw(&d.sock);
    c.send(&format!(r#"{{"id":1,"method":"create",{CREATE_SANDBOX}}}"#));
    assert_eq!(
        c.call(r#"{"id":2,"method":"list","params":{}}"#),
        r#"{"id":2,"result":{"tools":null}}"#
    );
    gate.open();
    assert_eq!(
        c.recv(),
        r#"{"id":1,"error":{"code":-32603,"message":"placer released"}}"#
    );
}

/// 느린 생성은 연결마다 PANED_SLOW_MAX 개까지만 동시에 돈다.
#[tokio::test(flavor = "multi_thread")]
async fn create_concurrency_bounded() {
    let d = daemon("b");
    let gate = Gate::default();
    let (cur, peak) = blocking_placer(&d, &gate);
    let mut c = raw(&d.sock);
    let total = i64::try_from(PANED_SLOW_MAX).unwrap() + 2;
    for id in 1..=total {
        c.send(&format!(
            r#"{{"id":{id},"method":"create",{CREATE_SANDBOX}}}"#
        ));
    }
    assert_eq!(
        c.call(r#"{"id":100,"method":"list","params":{}}"#),
        r#"{"id":100,"result":{"tools":null}}"#
    );
    let max = i64::try_from(PANED_SLOW_MAX).unwrap();
    wait_until("배치가 상한까지 차지 않았다", || {
        cur.load(Ordering::SeqCst) >= max
    });
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(peak.load(Ordering::SeqCst), max);
    gate.open();
    for _ in 0..total {
        assert!(c.recv().contains("placer released"));
    }
}
