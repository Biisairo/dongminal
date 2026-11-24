//! 요청·응답, 목록 캐시 (M8 `GO-6`, FR-TLU-2), push 배달과 콜백 배선 (M8 `GO-5`).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use otter_gocompat::json;
use otter_shared_toolhub::{OutChunk, TermSize, ToolInfo};
use otter_shared_toolipc::{CODE_INTERNAL, IdParams, METHOD_HELLO, METHOD_LIST, ResizeParams};
use serde_json::{Value, json};

use super::{Peer, chan, dial, err_resp, fake, listen, resp, version, wait_until};
use crate::ToolClient;
use crate::wire::{Empty, WireMsg};
use otter_shared_toolhub::Placement;

#[test]
fn request_response() {
    let (sock, _l) = fake(|req| Some(resp(req.id, json!({"echo": req.method}))));
    let pc = dial(&sock);
    #[derive(Default, serde::Deserialize)]
    #[serde(default)]
    struct Echo {
        echo: String,
    }
    let r: Echo = pc.call("test_method", &json!({"key": "val"})).unwrap();
    assert_eq!(r.echo, "test_method");
}

#[test]
fn create_returns_identity() {
    let (sock, _l) = fake(|req| {
        Some(resp(
            req.id,
            json!({"id": "99", "name": "S99", "pid": 12345, "cols": 80, "rows": 24}),
        ))
    });
    let pc = dial(&sock);
    let t = pc.create("/tmp", 80, 24, &Placement::default()).unwrap();
    assert_eq!((t.id.as_str(), t.name.as_str()), ("99", "S99"));
}

#[test]
fn list_two() {
    let (sock, _l) = fake(|req| {
        Some(resp(
            req.id,
            json!({"tools": [{"id": "1", "name": "S1"}, {"id": "2", "name": "S2"}]}),
        ))
    });
    assert_eq!(dial(&sock).list().len(), 2);
}

#[test]
fn write_delete_resize_params() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = Arc::clone(&seen);
    let (sock, _l) = fake(move |req| {
        if req.method != METHOD_HELLO {
            s.lock()
                .unwrap()
                .push((req.method.clone(), req.params.0.clone()));
        }
        Some(resp(req.id, json!({})))
    });
    let pc = dial(&sock);
    pc.write("1", b"hello world").unwrap();
    pc.delete("42").unwrap();
    pc.resize("3", 200, 60).unwrap();
    let seen = seen.lock().unwrap();
    let w: otter_shared_toolipc::WriteParams = json::unmarshal(&seen[0].1).unwrap();
    assert_eq!(w.data, b"hello world");
    let d: IdParams = json::unmarshal(&seen[1].1).unwrap();
    assert_eq!(d.id, "42");
    let r: ResizeParams = json::unmarshal(&seen[2].1).unwrap();
    assert_eq!((r.id.as_str(), r.cols, r.rows), ("3", 200, 60));
}

#[test]
fn snapshot_decodes() {
    let (sock, _l) = fake(|req| {
        Some(resp(
            req.id,
            json!({"data": "YnVmZmVyZWQ=", "totalBytesIn": 100.0, "totalBytesDrop": 5.0, "retained": 95.0}),
        ))
    });
    let pc = dial(&sock);
    let snap = pc.snapshot_tool("1").unwrap();
    assert_eq!(snap.data, b"buffered");
    assert_eq!(snap.total_bytes_in, 100);
}

#[test]
fn list_ok_empty() {
    let (sock, _l) = fake(|req| Some(resp(req.id, json!({"tools": null}))));
    let pc = dial(&sock);
    let tools = pc.list_ok().expect("응답이 왔으므로 알고 있는 것이다");
    assert!(tools.is_empty());
}

#[test]
fn list_ok_unknown() {
    let (sock, _l) = fake(|req| {
        Some(if req.method == METHOD_HELLO {
            resp(req.id, json!({}))
        } else {
            err_resp(req.id, CODE_INTERNAL, "boom")
        })
    });
    assert!(
        dial(&sock).list_ok().is_none(),
        "RPC 가 실패했으므로 모르는 것이다"
    );
}

#[test]
fn list_ok_missing_key_is_unknown() {
    let (sock, _l) = fake(|req| Some(resp(req.id, json!({"other": 1}))));
    assert!(dial(&sock).list_ok().is_none());
}

#[test]
fn list_delegates_to_list_ok() {
    let (sock, _l) = fake(|req| Some(resp(req.id, json!({"tools": [{"id": "1", "name": "S1"}]}))));
    let pc = dial(&sock);
    assert_eq!(pc.list_ok().map(|t| t.len()), Some(1));
    assert_eq!(pc.list().len(), 1);
}

/// hello 응답 직후 fg 를 미는 가짜 데몬이다 — 콜백 배선보다 push 가 먼저 올 수 있다.
#[test]
fn foreground_push_dispatch() {
    let (sock, ln) = listen();
    thread::spawn(move || {
        let peer = Peer::new(ln.accept().unwrap());
        peer.clone().each_request(|_, req| {
            peer.send(&resp(req.id, json!({"version": 1})));
            peer.send(&json!({"event": "fg", "tool": "t1", "name": "claude"}));
        });
    });
    let pc = ToolClient::dial(&sock.path).unwrap();
    let (tx, rx) = chan();
    pc.set_on_foreground(Some(Arc::new(move |id: &str, name: &str| {
        let _ = tx.send((id.to_owned(), name.to_owned()));
    })));
    let _ = pc.call_raw("list", &Empty {});
    let got = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("fg push 가 콜백에 닿지 않았다");
    assert_eq!(got, ("t1".to_owned(), "claude".to_owned()));
}

/// hello 에 답한 직후부터 output 을 밀고 마지막에 exit 를 미는 가짜 데몬이다.
fn pushing_fake(outputs: i64) -> super::Sock {
    let (sock, ln) = listen();
    thread::spawn(move || {
        let peer = Peer::new(ln.accept().unwrap());
        let mut first = true;
        peer.clone().each_request(|_, req| {
            if !first {
                return;
            }
            first = false;
            peer.send(&resp(req.id, json!({"version": 1})));
            for i in 0..outputs {
                peer.send(&json!({"event": "output", "tool": "t1", "data": "eA==", "end": i + 1}));
            }
            peer.send(&json!({"event": "exit", "tool": "t1", "code": 7}));
        });
    });
    sock
}

#[test]
fn set_callback_race() {
    let sock = pushing_fake(2000);
    let pc = ToolClient::dial(&sock.path).unwrap();
    let got = Arc::new(AtomicI64::new(0));
    let g = Arc::clone(&got);
    pc.set_on_output(Some(Arc::new(move |_: &str, _: &[u8], _| {
        g.fetch_add(1, Ordering::SeqCst);
    })));
    let (tx, rx) = chan();
    pc.set_on_exit(Some(Arc::new(move |_: &str, info| {
        let _ = tx.send(info.code);
    })));
    let code = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("exit push 가 콜백에 닿지 않았다");
    assert_eq!(code, 7);
    assert!(
        got.load(Ordering::SeqCst) > 0,
        "배선 뒤의 output push 가 콜백에 닿지 않았다"
    );
}

/// 배선 전에 도착한 exit 는 버려지지 않는다 — set_on_exit 가 재생한다.
#[test]
fn early_exit_replay() {
    let sock = pushing_fake(0);
    let pc = ToolClient::dial(&sock.path).unwrap();
    wait_until(
        "배선 전의 exit 가 버퍼에 들어가지 않았다",
        Duration::from_secs(5),
        || super::super::client::lock(&pc.inner.st).early_exits.len() == 1,
    );
    let (tx, rx) = chan();
    pc.set_on_exit(Some(Arc::new(move |_: &str, info| {
        let _ = tx.send(info.code);
    })));
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 7);
}

/// list 횟수를 세고, 시험이 넣는 이벤트를 민다.
fn counting_fake(lists: Arc<AtomicI64>) -> (super::Sock, std::sync::mpsc::Sender<Value>) {
    let (sock, ln) = listen();
    let (ev_tx, ev_rx) = std::sync::mpsc::channel::<Value>();
    thread::spawn(move || {
        let peer = Peer::new(ln.accept().unwrap());
        let p = peer.clone();
        thread::spawn(move || {
            for ev in ev_rx {
                p.send(&ev);
            }
        });
        peer.clone().each_request(|_, req| {
            let r = if req.method == METHOD_LIST {
                lists.fetch_add(1, Ordering::SeqCst);
                resp(
                    req.id,
                    json!({"tools": [{"id": "t1", "name": "S1", "pid": 7, "fgName": "vim"}]}),
                )
            } else {
                resp(req.id, version())
            };
            peer.send(&r);
        });
    });
    (sock, ev_tx)
}

#[test]
fn list_cache() {
    let lists = Arc::new(AtomicI64::new(0));
    let (sock, _ev) = counting_fake(Arc::clone(&lists));
    let pc = dial(&sock);
    for _ in 0..10 {
        assert!(pc.get("t1").is_some() && pc.is_live("t1") && pc.get("nope").is_none());
    }
    assert_eq!(lists.load(Ordering::SeqCst), 1, "TTL 안에서는 캐시");
    let tools = pc.list();
    assert_eq!(tools.len(), 1);
    assert_eq!((tools[0].fg_name.as_str(), tools[0].pid), ("vim", 7));
}

#[test]
fn list_cache_invalidation() {
    let lists = Arc::new(AtomicI64::new(0));
    let (sock, ev) = counting_fake(Arc::clone(&lists));
    let pc = dial(&sock);
    pc.get("t1");
    pc.get("t1");
    assert_eq!(lists.load(Ordering::SeqCst), 1);
    ev.send(json!({"event": "exit", "tool": "t1", "code": 0}))
        .unwrap();
    wait_until(
        "exit push 뒤에도 캐시가 살아 있다",
        Duration::from_secs(3),
        || {
            pc.get("t1");
            lists.load(Ordering::SeqCst) >= 2
        },
    );
    let before = lists.load(Ordering::SeqCst);
    pc.get("t1");
    let _ = pc.delete("t1");
    pc.get("t1");
    assert_eq!(
        lists.load(Ordering::SeqCst),
        before + 1,
        "delete 뒤 캐시가 살아 있다"
    );
}

#[test]
fn list_stale_generation() {
    let lists = Arc::new(AtomicI64::new(0));
    let (sock, _ev) = counting_fake(lists);
    let pc = dial(&sock);
    let g = pc.inner.list_generation();
    pc.inner.invalidate_list();
    let tool = |id: &str| ToolInfo {
        id: id.into(),
        ..ToolInfo::default()
    };
    pc.inner.store_list(vec![tool("stale")], g);
    assert!(
        super::super::client::lock(&pc.inner.list).at.is_none(),
        "낡은 세대가 저장됐다"
    );
    pc.inner
        .store_list(vec![tool("fresh")], pc.inner.list_generation());
    let l = super::super::client::lock(&pc.inner.list);
    assert!(l.at.is_some() && l.cache.len() == 1 && l.cache[0].id == "fresh");
}

fn push(pc: &ToolClient, line: Value) {
    let m: WireMsg = json::unmarshal(&json::marshal(&line).unwrap()).unwrap();
    pc.inner.handle_push(&m);
}

#[test]
fn subscribers_get_output_size_and_exit() {
    let (sock, _l) = fake(|req| Some(resp(req.id, version())));
    let pc = dial(&sock);
    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    let (exit, _un) = pc.subscribe("t1", tx);
    push(
        &pc,
        json!({"event": "output", "tool": "t1", "data": "aGk=", "end": 9}),
    );
    push(
        &pc,
        json!({"event": "size", "tool": "t1", "cols": 0, "rows": 5}),
    );
    push(
        &pc,
        json!({"event": "size", "tool": "t1", "cols": 90, "rows": 20}),
    );
    push(
        &pc,
        json!({"event": "output", "tool": "other", "data": "aGk="}),
    );
    assert_eq!(
        rx.try_recv().unwrap(),
        OutChunk {
            data: b"hi".to_vec(),
            end: 9,
            size: None
        }
    );
    assert_eq!(
        rx.try_recv().unwrap().size,
        Some(TermSize { cols: 90, rows: 20 })
    );
    assert!(rx.try_recv().is_err());
    assert!(!exit.is_cancelled());
    push(&pc, json!({"event": "exit", "tool": "t1", "code": 3}));
    assert!(exit.is_cancelled());
    assert!(rx.blocking_recv().is_none(), "exit 뒤 채널이 닫히지 않았다");
}

#[test]
fn slow_subscriber_drops_not_blocks() {
    let (sock, _l) = fake(|req| Some(resp(req.id, version())));
    let pc = dial(&sock);
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let (_exit, un) = pc.subscribe("t1", tx);
    for _ in 0..3 {
        push(
            &pc,
            json!({"event": "output", "tool": "t1", "data": "eA=="}),
        );
    }
    assert_eq!(pc.inner.dropped.load(Ordering::SeqCst), 2);
    assert!(rx.try_recv().is_ok());
    un.unsubscribe();
    push(
        &pc,
        json!({"event": "output", "tool": "t1", "data": "eA=="}),
    );
    assert!(rx.try_recv().is_err());
    assert_eq!(pc.inner.dropped.load(Ordering::SeqCst), 2);
}

#[test]
fn output_dispatch_races_with_subscribe() {
    let (sock, _l) = fake(|req| Some(resp(req.id, version())));
    let pc = Arc::new(dial(&sock));
    for _ in 0..8 {
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let _ = pc.subscribe("t1", tx);
    }
    let m: WireMsg = json::unmarshal(br#"{"event":"output","tool":"t1","data":"aGk="}"#).unwrap();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (p, s) = (Arc::clone(&pc), Arc::clone(&stop));
    let churn = thread::spawn(move || {
        while !s.load(Ordering::SeqCst) {
            let (tx, _rx) = tokio::sync::mpsc::channel(1);
            let (_e, un) = p.subscribe("t1", tx);
            un.unsubscribe();
        }
    });
    for _ in 0..50_000 {
        pc.inner.handle_push(&m);
    }
    stop.store(true, Ordering::SeqCst);
    churn.join().unwrap();
}

/// report·attn·edges·chat push 가 각 콜백에 그대로 닿는다.
#[test]
fn event_callbacks() {
    let (sock, _l) = fake(|req| Some(resp(req.id, version())));
    let pc = dial(&sock);
    let (tx, rx) = chan::<String>();
    let t = tx.clone();
    pc.set_on_report(Some(Arc::new(move |ev| {
        let _ = t.send(format!(
            "{} {} {}",
            ev.event,
            ev.method,
            String::from_utf8_lossy(&ev.body.0)
        ));
    })));
    let t = tx.clone();
    pc.set_on_attn(Some(Arc::new(move |ev| {
        let _ = t.send(format!(
            "{} {} {} {} {}",
            ev.event, ev.tool, ev.kind, ev.reason, ev.agent.attention
        ));
    })));
    let t = tx.clone();
    pc.set_on_edges(Some(Arc::new(move |ev| {
        let _ = t.send(format!(
            "{} {:?} {:?} {} {:?}",
            ev.event,
            ev.paired.map(|e| e.fp),
            ev.removed.map(|e| e.name),
            ev.by_peer,
            ev.invited
        ));
    })));
    let t = tx;
    pc.set_on_chat(Some(Arc::new(move |ev| {
        let _ = t.send(format!(
            "{} {} {}",
            ev.event,
            ev.chat_kind,
            ev.chat.is_some()
        ));
    })));
    push(
        &pc,
        json!({"event": "report", "method": "notify", "body": {"toolId": "t1"}}),
    );
    push(
        &pc,
        json!({"event": "attn", "tool": "t1", "kind": "attention", "reason": "bell", "agent": {"attention": true}}),
    );
    push(
        &pc,
        json!({"event": "edges", "paired": {"fp": "F", "name": "n"}, "byPeer": true}),
    );
    push(&pc, json!({"event": "chat", "chatKind": "changed"}));
    push(&pc, json!({"event": "nope"}));
    let got: Vec<String> = (0..4)
        .map(|_| rx.recv_timeout(Duration::from_secs(1)).unwrap())
        .collect();
    assert_eq!(
        got,
        [
            r#"report notify {"toolId":"t1"}"#,
            "attn t1 attention bell true",
            r#"edges Some("F") None true None"#,
            "chat changed false",
        ]
    );
    assert!(rx.try_recv().is_err());
}
