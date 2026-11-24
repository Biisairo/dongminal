//! 시간 계약 (FR-RSP-4): RPC 시한, create 시한, 생존 확인 (FR-OPT-2-1), 재접속 백오프와 데몬 재기동 (FR-13).

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use otter_shared_toolhub::{Placement, ToolInfo};
use otter_shared_toolipc::{METHOD_CREATE, METHOD_HELLO, METHOD_LIST, PROTOCOL_VERSION};
use serde_json::json;

use super::{Peer, chan, listen, next_line, ok_fake, resp, version, wait_until};
use crate::client::{Timing, next_backoff};
use crate::{
    TOOL_CALL_TIMEOUT, TOOL_CREATE_TIMEOUT, TOOL_MAX_BACKOFF, TOOL_RECONNECT_BACKOFF, ToolClient,
};

/// 연결은 받되 답하지 않는다 — hello 가 시한에 닿는다 (FR-14).
#[test]
fn call_timeout() {
    let (sock, ln) = listen();
    thread::spawn(move || {
        while let Ok(conn) = ln.accept() {
            thread::spawn(move || Peer::new(conn).each_request(|_, _| {}));
        }
    });
    let start = Instant::now();
    let Err(err) = ToolClient::dial(&sock.path) else {
        panic!("hello 가 시한에 닿아야 한다");
    };
    let took = start.elapsed();
    assert!(
        took >= TOOL_CALL_TIMEOUT && took <= TOOL_CALL_TIMEOUT + Duration::from_secs(3),
        "took={took:?}"
    );
    assert_eq!(
        err.to_string(),
        r#"dial otterminald: hello: paned call "hello" timed out"#
    );
}

#[derive(Default)]
struct Gate {
    open: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.cv.notify_all();
    }

    fn wait(&self) {
        let mut g = self.open.lock().unwrap();
        while !*g {
            g = self.cv.wait(g).unwrap();
        }
    }
}

/// create 를 읽기 루프 밖에서 돌리는 데몬이다 (FR-OPT-2-3). release 가 열릴 때까지 create 를
/// 붙든다. hold_list 면 첫 list 를 붙들었다가 create 응답 뒤에 낡은 목록으로 답한다.
struct ConcFake {
    created: std::sync::mpsc::Receiver<()>,
    listed: std::sync::mpsc::Receiver<()>,
    release: Arc<Gate>,
    sock: super::Sock,
}

fn conc_fake(hold_list: bool, delay: Duration) -> ConcFake {
    let (sock, ln) = listen();
    let (created_tx, created) = std::sync::mpsc::sync_channel(8);
    let (listed_tx, listed) = std::sync::mpsc::sync_channel(8);
    let release = Arc::new(Gate::default());
    let gate = Arc::clone(&release);
    thread::spawn(move || {
        let peer = Peer::new(ln.accept().unwrap());
        let tools: Arc<Mutex<Vec<ToolInfo>>> = Arc::default();
        let mut held: Option<(i64, Vec<ToolInfo>)> = None;
        let list_json = |t: &[ToolInfo]| json!({"tools": t.iter().map(|t| json!({"id": t.id, "name": t.name})).collect::<Vec<_>>()});
        peer.clone()
            .each_request(|_, req| match req.method.as_str() {
                METHOD_HELLO => peer.send(&resp(req.id, version())),
                METHOD_LIST => {
                    let cur = tools.lock().unwrap().clone();
                    if hold_list && held.is_none() {
                        held = Some((req.id, cur));
                        let _ = listed_tx.send(());
                        return;
                    }
                    peer.send(&resp(req.id, list_json(&cur)));
                }
                METHOD_CREATE => {
                    let (p, g, t, ctx) = (
                        peer.clone(),
                        Arc::clone(&gate),
                        Arc::clone(&tools),
                        created_tx.clone(),
                    );
                    let id = req.id;
                    thread::spawn(move || {
                        let _ = ctx.send(());
                        g.wait();
                        thread::sleep(delay);
                        t.lock().unwrap().push(ToolInfo {
                            id: "new".into(),
                            name: "new".into(),
                            ..ToolInfo::default()
                        });
                        p.send(&resp(
                            id,
                            json!({"id": "new", "name": "new", "cols": 80, "rows": 24}),
                        ));
                    });
                    if let Some((hid, stale)) = held.clone() {
                        let (p, g) = (peer.clone(), Arc::clone(&gate));
                        let body = list_json(&stale);
                        thread::spawn(move || {
                            g.wait();
                            thread::sleep(delay + Duration::from_millis(50));
                            p.send(&resp(hid, body));
                        });
                    }
                }
                _ => {}
            });
    });
    ConcFake {
        created,
        listed,
        release,
        sock,
    }
}

fn has(tools: &[ToolInfo], id: &str) -> bool {
    tools.iter().any(|t| t.id == id)
}

/// create 중의 list 는 앞의 목록을 받고, create 가 돌아온 뒤의 list 는 새 도구를 본다.
#[test]
fn list_during_create() {
    let f = conc_fake(false, Duration::ZERO);
    let pc = Arc::new(ToolClient::dial(&f.sock.path).unwrap());
    let p = Arc::clone(&pc);
    let done = thread::spawn(move || p.create("/tmp", 80, 24, &Placement::default()));
    f.created.recv_timeout(Duration::from_secs(3)).unwrap();
    let tools = pc.list_ok().unwrap();
    assert!(
        !has(&tools, "new"),
        "create 중의 list 는 앞의 목록이어야 한다"
    );
    f.release.open();
    done.join().unwrap().unwrap();
    assert!(has(&pc.list_ok().unwrap(), "new"));
}

/// create 보다 먼저 묻고 늦게 답해진 list 는 캐시에 남지 않는다.
#[test]
fn stale_list_after_create() {
    let f = conc_fake(true, Duration::ZERO);
    let pc = Arc::new(ToolClient::dial(&f.sock.path).unwrap());
    let p = Arc::clone(&pc);
    let list = thread::spawn(move || p.list_ok());
    f.listed.recv_timeout(Duration::from_secs(3)).unwrap();
    let p = Arc::clone(&pc);
    let create = thread::spawn(move || p.create("/tmp", 80, 24, &Placement::default()));
    f.created.recv_timeout(Duration::from_secs(3)).unwrap();
    f.release.open();
    create.join().unwrap().unwrap();
    let stale = list.join().unwrap().unwrap_or_default();
    assert!(!has(&stale, "new"), "붙든 list 는 낡은 목록이어야 한다");
    assert!(
        has(&pc.list_ok().unwrap(), "new"),
        "낡은 list 응답이 캐시에 남았다"
    );
}

#[test]
fn create_outlives_call_timeout() {
    assert!(TOOL_CREATE_TIMEOUT > TOOL_CALL_TIMEOUT);
    let f = conc_fake(false, TOOL_CALL_TIMEOUT + Duration::from_millis(300));
    f.release.open();
    let pc = ToolClient::dial(&f.sock.path).unwrap();
    let t = pc.create("/tmp", 80, 24, &Placement::default()).unwrap();
    assert_eq!(t.id, "new");
    assert_eq!(pc.reconnects(), 0);
}

const TEST_BEAT: Timing = Timing {
    every: Duration::from_millis(20),
    within: Duration::from_millis(100),
    backoff: TOOL_RECONNECT_BACKOFF,
    max_backoff: TOOL_MAX_BACKOFF,
};

/// 첫 연결은 접속 hello 에만 답하고 멎는다. 그 뒤 연결은 모두 답한다.
fn hang_after_hello(hellos: Arc<AtomicI64>) -> super::Sock {
    let (sock, ln) = listen();
    thread::spawn(move || {
        let mut n = 0;
        while let Ok(conn) = ln.accept() {
            let h = Arc::clone(&hellos);
            let first = n == 0;
            n += 1;
            thread::spawn(move || {
                let peer = Peer::new(conn);
                peer.clone().each_request(|_, req| {
                    if req.method == METHOD_HELLO {
                        h.fetch_add(1, Ordering::SeqCst);
                    }
                    if !first || (req.method == METHOD_HELLO && req.id == 0) {
                        peer.send(&resp(
                            req.id,
                            json!({"build": "", "version": PROTOCOL_VERSION}),
                        ));
                    }
                });
            });
        }
    });
    sock
}

#[test]
fn heartbeat_reconnects_hung_daemon() {
    let hellos = Arc::new(AtomicI64::new(0));
    let sock = hang_after_hello(Arc::clone(&hellos));
    let pc = ToolClient::dial_with(&sock.path, None, TEST_BEAT).unwrap();
    wait_until(
        "답하지 않는 데몬에서 재접속하지 않았다",
        TEST_BEAT.every + TEST_BEAT.within + Duration::from_secs(3),
        || pc.reconnects() > 0,
    );
}

#[test]
fn heartbeat_skips_while_call_pending() {
    let hellos = Arc::new(AtomicI64::new(0));
    let sock = hang_after_hello(Arc::clone(&hellos));
    let pc = ToolClient::dial_with(&sock.path, None, TEST_BEAT).unwrap();
    let within = (TEST_BEAT.every + TEST_BEAT.within) * 10;
    let err = pc
        .inner
        .call_raw(
            METHOD_CREATE,
            &otter_shared_toolipc::CreateParams::default(),
            within,
        )
        .unwrap_err();
    assert!(err.to_string().contains("timed out"), "{err}");
    assert_eq!(
        hellos.load(Ordering::SeqCst),
        1,
        "호출이 진행 중인 동안 hello 가 나갔다"
    );
}

#[test]
fn heartbeat_keeps_live_daemon() {
    let (sock, lines) = ok_fake(version());
    let pc = ToolClient::dial_with(&sock.path, None, TEST_BEAT).unwrap();
    let mut first = String::new();
    for i in 0..4 {
        let line = next_line(&lines);
        let req: otter_shared_toolipc::PanedRequest =
            otter_gocompat::json::unmarshal(line.as_bytes()).unwrap();
        assert_eq!(req.method, METHOD_HELLO, "{line}");
        let p = String::from_utf8(req.params.0).unwrap();
        if i == 0 {
            first = p;
        } else {
            assert_eq!(p, first, "생존 확인 인자가 접속 hello 와 다르다");
        }
    }
    assert_eq!(pc.reconnects(), 0);
}

#[test]
fn backoff_doubles_to_cap() {
    let mut b = TOOL_RECONNECT_BACKOFF;
    let mut seq = vec![b.as_secs()];
    for _ in 0..7 {
        b = next_backoff(b, TOOL_MAX_BACKOFF);
        seq.push(b.as_secs());
    }
    assert_eq!(seq, [1, 2, 4, 8, 16, 30, 30, 30]);
}

/// 재접속 실패가 3 의 배수가 될 때마다 데몬을 다시 띄운다 (FR-13). 실제 시간 대신 주입한 대기가
/// 백오프를 기록한다. 재기동 순간까지의 대기 횟수가 곧 실패 횟수다(대기 → 연결 실패 → 재기동 순서).
#[test]
fn respawn_every_three_failed_dials() {
    let (sock, ln) = listen();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        let peer = Peer::new(ln.accept().unwrap());
        drop(ln);
        let p = peer.clone();
        thread::spawn(move || {
            let _ = stop_rx.recv();
            p.close();
        });
        peer.clone()
            .each_request(|_, req| peer.send(&resp(req.id, version())));
    });
    let timing = Timing {
        every: Duration::from_secs(3600),
        within: TOOL_CALL_TIMEOUT,
        backoff: TOOL_RECONNECT_BACKOFF,
        max_backoff: TOOL_MAX_BACKOFF,
    };
    let sleeps: Arc<Mutex<Vec<Duration>>> = Arc::default();
    let s = Arc::clone(&sleeps);
    let (tx, rx) = chan();
    let spawn: crate::SpawnDaemon = Box::new(move || {
        let _ = tx.send(s.lock().unwrap().len());
        Ok(())
    });
    let pc = ToolClient::dial_with(&sock.path, Some(spawn), timing).unwrap();
    let s = Arc::clone(&sleeps);
    *crate::client::lock(&pc.inner.sleep_hook) = Some(Arc::new(move |d| {
        s.lock().unwrap().push(d);
    }));
    stop_tx.send(()).unwrap();
    let at: Vec<usize> = (0..2)
        .map(|_| {
            rx.recv_timeout(Duration::from_secs(10))
                .expect("데몬을 다시 띄우지 않았다")
        })
        .collect();
    pc.close();
    assert_eq!(at, [3, 6], "재기동 때의 실패 횟수");
    let secs: Vec<u64> = sleeps.lock().unwrap()[..6]
        .iter()
        .map(Duration::as_secs)
        .collect();
    assert_eq!(secs, [1, 2, 4, 8, 16, 30], "백오프 수열");
}
