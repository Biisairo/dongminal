//! 재접속과 재동기 (FR-13·FR-14, FR-OPT-1-2·FR-OPT-2-1), 연결 상태와 닫힘.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use dm_shared_toolipc::{METHOD_HELLO, METHOD_LIST};
use serde_json::json;

use super::{Peer, chan, err_resp, listen, resp, version, wait_until};
use crate::wire::Empty;
use crate::{Error, ToolClient};

/// n 번째 연결의 list 는 lists[n] 으로 답한다(`None` 이면 오류). 첫 연결은 drop 신호에 끊는다.
/// 항목 "id:fg" 는 전경 이름을 싣는다.
fn reconnect_fake(
    lists: Vec<Option<Vec<&'static str>>>,
) -> (super::Sock, std::sync::mpsc::Sender<()>) {
    let (sock, ln) = listen();
    let (drop_tx, drop_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        let mut drop_rx = Some(drop_rx);
        let mut n = 0;
        while let Ok(conn) = ln.accept() {
            let peer = Peer::new(conn);
            if let Some(rx) = drop_rx.take() {
                let p = peer.clone();
                thread::spawn(move || {
                    let _ = rx.recv();
                    p.close();
                });
            }
            let ids = lists.get(n).cloned().flatten();
            n += 1;
            thread::spawn(move || {
                peer.clone().each_request(|_, req| {
                    let r = match (req.method.as_str(), &ids) {
                        (METHOD_LIST, None) => err_resp(req.id, 1, "boom"),
                        (METHOD_LIST, Some(ids)) => {
                            let tools: Vec<_> = ids
                                .iter()
                                .map(|e| {
                                    let (id, fg) = e.split_once(':').unwrap_or((e, ""));
                                    json!({"id": id, "name": id, "fgName": fg})
                                })
                                .collect();
                            resp(req.id, json!({"tools": tools}))
                        }
                        _ => resp(req.id, version()),
                    };
                    peer.send(&r);
                });
            });
        }
    });
    (sock, drop_tx)
}

/// 재접속 뒤 사라진 도구는 종료 신호를 켜고 exit 를 합성한다. 살아 있는 도구는 출력 채널만 닫는다.
#[test]
fn resync_subscribers() {
    let (sock, drop) = reconnect_fake(vec![Some(vec!["t1", "t2", "t3"]), Some(vec!["t1"])]);
    let pc = ToolClient::dial_with_reconnect(&sock.path, None).unwrap();
    let exited = Arc::new(Mutex::new(BTreeSet::new()));
    let e = Arc::clone(&exited);
    pc.set_on_exit(Some(Arc::new(move |id: &str, _| {
        e.lock().unwrap().insert(id.to_owned());
    })));
    assert_eq!(pc.list().len(), 3);
    let (tx1, rx1) = tokio::sync::mpsc::channel(4);
    let (ex1, _u1) = pc.subscribe("t1", tx1);
    let (tx2, _rx2) = tokio::sync::mpsc::channel(4);
    let (ex2, _u2) = pc.subscribe("t2", tx2);
    drop.send(()).unwrap();

    wait_until(
        "사라진 도구 t2 의 종료 신호가 켜지지 않았다",
        Duration::from_secs(8),
        || ex2.is_cancelled(),
    );
    wait_until(
        "살아 있는 도구 t1 의 출력 채널이 닫히지 않았다",
        Duration::from_secs(8),
        || rx1.is_closed(),
    );
    assert!(
        !ex1.is_cancelled(),
        "살아 있는 도구 t1 의 종료 신호가 켜졌다"
    );
    wait_until(
        "사라진 도구의 exit 가 합성되지 않았다",
        Duration::from_secs(8),
        || {
            let e = exited.lock().unwrap();
            e.contains("t2") && e.contains("t3")
        },
    );
    assert!(!exited.lock().unwrap().contains("t1"));
    assert!(pc.inner.read_subs().is_empty(), "재동기 뒤 구독이 남았다");
}

/// 재접속 뒤 목록을 모르면 죽었다고 판정하지 않는다 — 전부 재동기로 돌린다.
#[test]
fn resync_unknown_list() {
    let (sock, drop) = reconnect_fake(vec![Some(vec!["t1"]), None]);
    let pc = ToolClient::dial_with_reconnect(&sock.path, None).unwrap();
    let exits = Arc::new(Mutex::new(0));
    let e = Arc::clone(&exits);
    pc.set_on_exit(Some(Arc::new(move |_: &str, _| {
        *e.lock().unwrap() += 1;
    })));
    pc.list();
    let (tx1, rx1) = tokio::sync::mpsc::channel(4);
    let (ex1, _u) = pc.subscribe("t1", tx1);
    drop.send(()).unwrap();
    wait_until(
        "t1 의 출력 채널이 닫히지 않았다",
        Duration::from_secs(8),
        || rx1.is_closed(),
    );
    assert!(!ex1.is_cancelled());
    assert_eq!(
        *exits.lock().unwrap(),
        0,
        "목록을 모르는데 exit 를 합성했다"
    );
}

/// 끊긴 동안 바뀐 전경 이름만 알린다.
#[test]
fn resync_foreground() {
    let (sock, drop) = reconnect_fake(vec![Some(vec!["t1", "t2"]), Some(vec!["t1:htop", "t2"])]);
    let pc = ToolClient::dial_with_reconnect(&sock.path, None).unwrap();
    let (tx, rx) = chan();
    pc.set_on_foreground(Some(Arc::new(move |id: &str, name: &str| {
        let _ = tx.send((id.to_owned(), name.to_owned()));
    })));
    pc.list();
    drop.send(()).unwrap();
    let got = rx
        .recv_timeout(Duration::from_secs(8))
        .expect("바뀐 전경 이름이 알려지지 않았다");
    assert_eq!(got, ("t1".to_owned(), "htop".to_owned()));
    assert!(
        rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "바뀌지 않은 도구까지 알렸다"
    );
}

/// 데몬이 죽고 같은 소켓에 새 데몬이 서면 다시 붙는다. 재동기 콜백은 기록·간선·채팅 순서다.
#[test]
fn auto_reconnect_to_replacement() {
    let (sock, ln) = listen();
    let (kill_tx, kill_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        let peer = Peer::new(ln.accept().unwrap());
        let p = peer.clone();
        thread::spawn(move || {
            let _ = kill_rx.recv();
            drop(ln);
            p.close();
        });
        peer.clone()
            .each_request(|_, req| peer.send(&resp(req.id, version())));
    });
    let pc = ToolClient::dial_with_reconnect(&sock.path, None).unwrap();
    let (tx, rx) = chan();
    for name in ["records", "edge", "chat"] {
        let t = tx.clone();
        let cb: crate::ResyncCallback = Arc::new(move || {
            let _ = t.send(name);
        });
        match name {
            "records" => pc.set_on_resync(Some(cb)),
            "edge" => pc.set_on_edge_resync(Some(cb)),
            _ => pc.set_on_chat_resync(Some(cb)),
        }
    }
    kill_tx.send(()).unwrap();
    wait_until("끊김을 알지 못했다", Duration::from_secs(2), || {
        !pc.connected()
    });
    assert!(pc.list_ok().is_none(), "끊긴 동안 목록을 안다고 했다");

    let ln2 = dm_shared_platform::current()
        .ipc
        .listen(&sock.path)
        .unwrap();
    thread::spawn(move || {
        let peer = Peer::new(ln2.accept().unwrap());
        peer.clone().each_request(|_, req| {
            let r = if req.method == METHOD_LIST {
                resp(req.id, json!({"tools": [{"id": "a", "name": "A"}]}))
            } else {
                resp(req.id, version())
            };
            peer.send(&r);
        });
    });
    wait_until(
        "새 데몬에 다시 붙지 못했다",
        Duration::from_secs(8),
        || pc.list_ok().is_some(),
    );
    assert_eq!(pc.reconnects(), 1);
    assert!(pc.connected());
    let order: Vec<_> = (0..3)
        .map(|_| rx.recv_timeout(Duration::from_secs(2)).unwrap())
        .collect();
    assert_eq!(order, ["records", "edge", "chat"]);
}

/// 응답을 기다리는 동안 연결이 끊기면 곧바로 "paned connection lost" 다.
#[test]
fn pending_call_fails_on_connection_loss() {
    let (sock, ln) = listen();
    thread::spawn(move || {
        let peer = Peer::new(ln.accept().unwrap());
        peer.clone().each_request(|_, req| {
            if req.method == METHOD_HELLO {
                peer.send(&resp(req.id, version()));
            } else {
                peer.close();
            }
        });
    });
    let pc = ToolClient::dial(&sock.path).unwrap();
    let start = std::time::Instant::now();
    let err = pc.call_raw("x", &Empty {}).unwrap_err();
    assert!(matches!(err, Error::ConnectionLost), "{err:?}");
    assert_eq!(err.to_string(), "paned connection lost");
    assert!(start.elapsed() < Duration::from_secs(2));
    wait_until(
        "끊김 뒤에도 연결됐다고 한다",
        Duration::from_secs(2),
        || !pc.connected(),
    );
}

/// 닫으면 기다리던 호출은 "toolclient closed" 로 돌아오고 연결 상태는 거짓이다.
#[test]
fn close_fails_pending_and_disconnects() {
    let (sock, ln) = listen();
    thread::spawn(move || {
        let peer = Peer::new(ln.accept().unwrap());
        peer.clone().each_request(|_, req| {
            if req.method == METHOD_HELLO {
                peer.send(&resp(req.id, version()));
            }
        });
    });
    let pc = Arc::new(ToolClient::dial(&sock.path).unwrap());
    assert!(pc.connected());
    let p = Arc::clone(&pc);
    let call = thread::spawn(move || p.call_raw("x", &Empty {}));
    wait_until(
        "호출이 대기 목록에 오르지 않았다",
        Duration::from_secs(2),
        || !super::super::client::lock(&pc.inner.st).pending.is_empty(),
    );
    pc.close();
    let err = call.join().unwrap().unwrap_err();
    assert_eq!(err.to_string(), "toolclient closed");
    assert!(!pc.connected());
    pc.close();
}
