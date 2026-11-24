//! 도구의 출력·종료·전경·크기 push 와 쓰기 큐 (wire_typed_test.go · fg_push_test.go · paned_test.go).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use otter_shared_toolipc as ipc;

use super::fake::{fake_tools, get};
use super::{curr, daemon, raw};

/// push 바이트는 Go 와 같다 (FR-OPT-0-3). 빈 data 도 null 이 아니라 "" 다.
#[tokio::test(flavor = "multi_thread")]
async fn push_wire_golden() {
    let d = daemon("b");
    let pm = Arc::clone(&d.srv.inner.pm);
    let reg = fake_tools(&pm, None, &[]);
    pm.restore("a", "R", "/tmp", 10, 10).unwrap();
    let a = get(&reg, "a");
    let mut c = raw(&d.sock);
    c.hello(&[]);

    a.feed(b"hi");
    assert_eq!(
        c.recv(),
        r#"{"data":"aGk=","end":2,"event":"output","tool":"a"}"#
    );
    curr(&d).enqueue(
        &ipc::OutputEvent {
            data: Vec::new(),
            end: 9,
            event: ipc::EVENT_OUTPUT.into(),
            tool: "a".into(),
        },
        true,
    );
    assert_eq!(
        c.recv(),
        r#"{"data":"","end":9,"event":"output","tool":"a"}"#
    );
    pm.set_foreground_probe(Some(Arc::new(|ids: &[String]| {
        ids.iter().map(|i| (i.clone(), "vim".to_owned())).collect()
    })));
    pm.refresh_foreground();
    assert_eq!(c.recv(), r#"{"event":"fg","name":"vim","tool":"a"}"#);
    pm.resize("a", 80, 24).unwrap();
    assert_eq!(
        c.recv(),
        r#"{"cols":80,"event":"size","rows":24,"tool":"a"}"#
    );
    a.end();
    assert_eq!(c.recv(), r#"{"code":-1,"event":"exit","tool":"a"}"#);
}

/// 쓰기 큐가 찰 때까지 출력 push 를 넣는다. 처음 찼을 때는 쓰기 스레드가 아직 소켓에 쓰는 중일 수
/// 있으므로, 소켓 버퍼가 차 쓰기가 멎은 뒤 한 번 더 채운다. 서버는 읽지 않으므로 큐는 찬 채로 남는다.
fn fill_queue(conn: &crate::conn::Conn) {
    let line = format!(
        "{{\"data\":\"{}\",\"end\":0,\"event\":\"output\",\"tool\":\"x\"}}\n",
        "A".repeat(1024)
    )
    .into_bytes();
    for settle in [true, false] {
        let n = conn.dropped();
        while conn.dropped() == n {
            conn.enqueue_line(line.clone(), true);
        }
        if settle {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// 출력 push 는 큐가 차면 기다리지 않고 버리고 센다 (FR-DMR-46).
#[tokio::test(flavor = "multi_thread")]
async fn output_push_drops_when_queue_full() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    c.hello(&[]);
    let conn = curr(&d);
    fill_queue(&conn);
    let n = conn.dropped();
    let (tx, rx) = mpsc::channel();
    let k = Arc::clone(&conn);
    std::thread::spawn(move || {
        k.enqueue_line(b"{}\n".to_vec(), true);
        k.enqueue_line(b"{}\n".to_vec(), true);
        let _ = tx.send(());
    });
    rx.recv_timeout(Duration::from_secs(2))
        .expect("큐가 찬 연결에서 출력 push 가 막혔다");
    assert_eq!(conn.dropped(), n + 2);
}

/// fg push 는 큐가 차 있어도 버리지 않고 자리가 날 때까지 기다린다 (FR-OPT-2-1).
#[tokio::test(flavor = "multi_thread")]
async fn fg_push_not_dropped_when_queue_full() {
    let d = daemon("b");
    let pm = Arc::clone(&d.srv.inner.pm);
    let _reg = fake_tools(&pm, None, &["t1"]);
    pm.set_foreground_probe(Some(Arc::new(|ids: &[String]| {
        ids.iter()
            .map(|i| (i.clone(), "vim".to_owned()))
            .collect::<HashMap<_, _>>()
    })));
    let mut c = raw(&d.sock);
    c.hello(&[]);
    fill_queue(&curr(&d));
    let (tx, rx) = mpsc::channel();
    let p = Arc::clone(&pm);
    std::thread::spawn(move || {
        p.refresh_foreground();
        let _ = tx.send(());
    });
    assert!(
        rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "큐가 찬 채로 돌아왔다 — fg push 를 버렸다"
    );
    loop {
        let l = c.recv();
        if l.contains(r#""event":"fg""#) {
            assert_eq!(l, r#"{"event":"fg","name":"vim","tool":"t1"}"#);
            break;
        }
    }
    rx.recv_timeout(Duration::from_secs(2))
        .expect("자리가 난 뒤에도 돌아오지 않았다");
}
