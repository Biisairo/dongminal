//! 서버가 보내는 바이트와 받는 방식 (FR-OPT-2-6·2-8), hello 협상 (FR-VHL·D-OPT-1), 기능별 강등.

use std::thread;
use std::time::{Duration, Instant};

use otter_gocompat::json;
use otter_shared_toolhub::ShellState;
use otter_shared_toolipc::{
    BusyManyParams, CODE_INTERNAL, CODE_NOT_FOUND, CODE_SERVER, CODE_TOOL_CAP, FEATURE_BUSY_MANY,
    FEATURE_FOREGROUND_TICK, FEATURE_NOTIFY, FEATURE_SHELL_PROBE, FEATURE_SNAPSHOT_NOT_FOUND,
    IdParams, METHOD_BUSY, METHOD_BUSY_MANY, METHOD_CREATE, METHOD_HELLO, METHOD_KILL,
    PROTOCOL_VERSION,
};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};

use super::{
    Peer, chan, dial, err_resp, fake, listen, next_line, no_line, ok_fake, raw_fake, resp, version,
};
use crate::{Error, ToolClient};
use otter_shared_toolhub::Placement;

#[test]
fn hello_params_wire() {
    let (sock, lines) = ok_fake(version());
    let _pc = dial(&sock);
    assert_eq!(
        next_line(&lines),
        r#"{"id":0,"method":"hello","params":{"features":["reports","attention","edge","chat"]}}"#
    );
}

#[test]
fn request_wire_golden() {
    let (sock, lines) = ok_fake(version());
    let pc = dial(&sock);
    next_line(&lines);
    type Step<'a> = (Box<dyn Fn() + 'a>, &'a str);
    let steps: Vec<Step<'_>> = vec![
        (
            Box::new(|| {
                let place = Placement {
                    window_uuid: "w".into(),
                    profile: "p".into(),
                    command: "c".into(),
                    work: "k".into(),
                    extra_env: vec!["A=1".into()],
                    ..Placement::default()
                };
                let _ = pc.create("/tmp", 80, 24, &place);
            }),
            r#""method":"create","params":{"cols":80,"command":"c","cwd":"/tmp","extraEnv":["A=1"],"profile":"p","rows":24,"window":"w","work":"k"}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.create("/", 1, 2, &Placement::default());
            }),
            r#""method":"create","params":{"cols":1,"command":"","cwd":"/","extraEnv":null,"profile":"","rows":2,"window":"","work":""}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.delete("a");
            }),
            r#""method":"kill","params":{"id":"a"}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.terminate("a", Duration::from_millis(1500));
            }),
            r#""method":"terminate","params":{"graceMs":1500,"id":"a"}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.restore("a", "R", "/h", 100, 30);
            }),
            r#""method":"restore","params":{"cols":100,"cwd":"/h","id":"a","name":"R","rows":30}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.write("a", b"hi");
            }),
            r#""method":"write","params":{"data":"aGk=","id":"a"}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.write("a", &[]);
            }),
            r#""method":"write","params":{"data":"","id":"a"}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.send_paste("a", b"hi", true);
            }),
            r#""method":"paste","params":{"data":"aGk=","id":"a","submit":true}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.resize("a", 90, 20);
            }),
            r#""method":"resize","params":{"cols":90,"id":"a","rows":20}}"#,
        ),
        (
            Box::new(|| {
                pc.cwd("a");
            }),
            r#""method":"cwd","params":{"id":"a"}}"#,
        ),
        (
            Box::new(|| {
                pc.busy("a");
            }),
            r#""method":"busy","params":{"id":"a"}}"#,
        ),
        (
            Box::new(|| {
                pc.set_background("a", true);
            }),
            r#""method":"setbackground","params":{"background":true,"id":"a"}}"#,
        ),
        (
            Box::new(|| {
                pc.background_list();
            }),
            r#""method":"backgroundlist","params":{}}"#,
        ),
        (
            Box::new(|| {
                pc.inner.invalidate_list();
                pc.list();
            }),
            r#""method":"list","params":{}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.snapshot_tool_since("a", 7);
            }),
            r#""method":"snapshot","params":{"id":"a","since":7}}"#,
        ),
        (
            Box::new(|| {
                let _ = pc.screen_tool("a", 5000);
            }),
            r#""method":"screen","params":{"history":5000,"id":"a"}}"#,
        ),
    ];
    for (i, (run, want)) in steps.iter().enumerate() {
        run();
        let got = next_line(&lines);
        let at = got.find(r#""method""#).unwrap();
        assert_eq!(&got[at..], *want, "단계 {i}: {got}");
        assert!(got.starts_with(&format!(r#"{{"id":{},"#, i + 1)), "{got}");
    }
}

struct Unsupported;

impl Serialize for Unsupported {
    fn serialize<S: Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom("json: unsupported type: func()"))
    }
}

/// 부호화 오류는 삼키지 않고 호출자에게 돌려준다 (IPC-22). 실패한 호출은 대기 목록에 남지 않는다.
#[test]
fn call_marshal_error_returned() {
    let (sock, _lines) = ok_fake(version());
    let pc = dial(&sock);
    let err = pc
        .inner
        .call_raw("x", &Unsupported, Duration::from_secs(1))
        .unwrap_err();
    assert!(matches!(err, Error::Json(_)), "{err:?}");
    assert!(super::super::client::lock(&pc.inner.st).pending.is_empty());
}

/// 소켓 쓰기는 상태 잠금 밖에서 한다 (IPC-22). 쓰기가 막혀도 콜백 배선이 서지 않는다.
#[test]
fn blocked_write_does_not_hold_mu() {
    let (sock, ln) = listen();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    thread::spawn(move || {
        let conn = ln.accept().unwrap();
        let peer = Peer::new(conn);
        let mut once = true;
        peer.clone().each_request(|_, req| {
            if once {
                peer.send(&resp(req.id, version()));
                once = false;
                let _ = release_rx.recv();
                peer.close();
            }
        });
    });
    let pc = std::sync::Arc::new(ToolClient::dial(&sock.path).unwrap());
    let (done_tx, done_rx) = chan();
    let w = std::sync::Arc::clone(&pc);
    thread::spawn(move || {
        let _ = w.write("a", &vec![0u8; 32 << 20]);
        let _ = done_tx.send(());
    });
    assert!(
        done_rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "쓰기가 막히지 않았다 — 버퍼가 예상보다 크다"
    );
    let (got_tx, got_rx) = chan();
    let p = std::sync::Arc::clone(&pc);
    thread::spawn(move || {
        p.set_on_output(None);
        let _ = got_tx.send(());
    });
    let ok = got_rx.recv_timeout(Duration::from_secs(2)).is_ok();
    let _ = release_tx.send(());
    let _ = done_rx.recv_timeout(Duration::from_secs(5));
    pc.close();
    assert!(ok, "막힌 소켓 쓰기가 상태 잠금을 쥐고 있다");
}

#[test]
fn hello_features_negotiated() {
    let (sock, _l) =
        ok_fake(json!({"version": PROTOCOL_VERSION, "build": "b", "features": ["f1"]}));
    let pc = dial(&sock);
    assert!(pc.has_feature("f1"));
    assert!(!pc.has_feature("f2"));
}

#[test]
fn hello_legacy_daemon_no_features() {
    let (sock, _l) =
        ok_fake(json!({"version": PROTOCOL_VERSION, "build": "old", "tool_ids": ["a"]}));
    let pc = dial(&sock);
    assert!(!pc.has_feature("f1"));
    assert_eq!(pc.daemon_info().build, "old");
}

/// 해석 못 할 push 하나는 버리고 연결은 잇는다. 해석 못 한 오류 응답은 시한까지 매달리지 않는다.
#[test]
fn bad_push_dropped_connection_kept() {
    let (sock, ln) = listen();
    thread::spawn(move || {
        let peer = Peer::new(ln.accept().unwrap());
        peer.clone().each_request(|_, req| {
            if req.method == METHOD_HELLO {
                peer.raw(b"{\"id\":0,\"result\":{\"version\":1}}\n");
                return;
            }
            peer.raw(b"{\"event\":\"output\",\"tool\":\"a\",\"data\":\"!!!\",\"end\":1}\n");
            peer.raw(b"{\"event\":\"size\",\"tool\":\"a\",\"cols\":\"x\",\"rows\":1}\n");
            peer.raw(b"{\"event\":\"output\",\"tool\":\"a\",\"data\":\"aGk=\",\"end\":2}\n");
            peer.raw(
                format!(
                    "{{\"id\":{},\"error\":{{\"code\":\"bad\",\"message\":\"m\"}}}}\n",
                    req.id
                )
                .as_bytes(),
            );
        });
    });
    let pc = ToolClient::dial(&sock.path).unwrap();
    let (tx, rx) = chan();
    pc.set_on_output(Some(std::sync::Arc::new(move |_: &str, d: &[u8], _| {
        let _ = tx.send(d.to_vec());
    })));
    let start = Instant::now();
    let err = pc.call_raw("x", &super::super::wire::Empty {}).unwrap_err();
    assert!(
        start.elapsed() < Duration::from_secs(1),
        "시한까지 매달렸다"
    );
    assert_eq!(
        err.to_string(),
        "json: cannot unmarshal string into Go struct field wireMsg.error.code of type int"
    );
    let d = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("연결이 끊겼다");
    assert_eq!(d, b"hi", "깨진 push 가 전달됐다");
    assert!(pc.connected());
}

#[test]
fn input_notify_one_frame() {
    let (sock, lines) = raw_fake(
        json!({"version": PROTOCOL_VERSION, "features": [FEATURE_NOTIFY]}),
        |_| None,
    );
    let pc = dial(&sock);
    next_line(&lines);
    for _ in 0..3 {
        pc.input_notify("t1", b"a");
    }
    pc.resize_notify("t1", 100, 30);
    for _ in 0..3 {
        assert_eq!(
            next_line(&lines),
            r#"{"method":"input","params":{"data":"YQ==","id":"t1"}}"#
        );
    }
    assert_eq!(
        next_line(&lines),
        r#"{"method":"resizenotify","params":{"cols":100,"id":"t1","rows":30}}"#
    );
    no_line(&lines);
}

#[test]
fn input_notify_legacy_daemon() {
    let (sock, lines) = ok_fake(version());
    let pc = dial(&sock);
    next_line(&lines);
    pc.input_notify("t1", b"a");
    pc.resize_notify("t1", 100, 30);
    assert_eq!(
        next_line(&lines),
        r#"{"id":1,"method":"write","params":{"data":"YQ==","id":"t1"}}"#
    );
    assert_eq!(
        next_line(&lines),
        r#"{"id":2,"method":"resize","params":{"cols":100,"id":"t1","rows":30}}"#
    );
}

#[test]
fn write_stays_rpc() {
    let (sock, lines) = raw_fake(
        json!({"version": PROTOCOL_VERSION, "features": [FEATURE_NOTIFY]}),
        |req| Some(err_resp(req.id, CODE_SERVER, "toolhub: tool not found")),
    );
    let pc = dial(&sock);
    next_line(&lines);
    let err = pc.write("gone", b"a").unwrap_err();
    assert_eq!(err.to_string(), "paned error: toolhub: tool not found");
    assert_eq!(
        next_line(&lines),
        r#"{"id":1,"method":"write","params":{"data":"YQ==","id":"gone"}}"#
    );
}

fn busy_many_fake(
    features: Value,
    fail: bool,
) -> (super::Sock, ToolClient, std::sync::mpsc::Receiver<String>) {
    let (sock, lines) = raw_fake(
        json!({"version": PROTOCOL_VERSION, "features": features}),
        move |req| {
            if fail {
                return Some(err_resp(req.id, CODE_SERVER, "boom"));
            }
            Some(match req.method.as_str() {
                METHOD_BUSY_MANY => {
                    let p: BusyManyParams = json::unmarshal(&req.params.0).unwrap();
                    let m: serde_json::Map<String, Value> = p
                        .ids
                        .unwrap_or_default()
                        .into_iter()
                        .map(|id| {
                            let b = id == "b";
                            (id, Value::Bool(b))
                        })
                        .collect();
                    resp(req.id, json!({"busy": m}))
                }
                METHOD_BUSY => {
                    let p: IdParams = json::unmarshal(&req.params.0).unwrap();
                    resp(req.id, json!({"busy": p.id == "b"}))
                }
                _ => resp(req.id, json!({})),
            })
        },
    );
    let pc = dial(&sock);
    next_line(&lines);
    (sock, pc, lines)
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn busy_many_one_rpc() {
    let (_s, pc, lines) = busy_many_fake(json!([FEATURE_BUSY_MANY]), false);
    let got = pc.busy_many(&ids(&["a", "b", "c"])).unwrap();
    assert_eq!(got.len(), 3);
    assert!(!got["a"] && got["b"] && !got["c"]);
    assert_eq!(
        next_line(&lines),
        r#"{"id":1,"method":"busymany","params":{"ids":["a","b","c"]}}"#
    );
    no_line(&lines);
}

#[test]
fn busy_many_legacy_daemon() {
    let (_s, pc, lines) = busy_many_fake(Value::Null, false);
    let got = pc.busy_many(&ids(&["a", "b"])).unwrap();
    assert!(!got["a"] && got["b"] && got.len() == 2);
    for (i, id) in ["a", "b"].iter().enumerate() {
        assert_eq!(
            next_line(&lines),
            format!(
                r#"{{"id":{},"method":"busy","params":{{"id":"{id}"}}}}"#,
                i + 1
            )
        );
    }
    no_line(&lines);
}

#[test]
fn busy_many_error_is_unknown() {
    for f in [json!([FEATURE_BUSY_MANY]), Value::Null] {
        let (_s, pc, _l) = busy_many_fake(f.clone(), true);
        assert!(pc.busy_many(&ids(&["a"])).is_none(), "features={f}");
    }
}

#[test]
fn busy_many_empty_no_rpc() {
    let (_s, pc, lines) = busy_many_fake(json!([FEATURE_BUSY_MANY]), false);
    assert_eq!(pc.busy_many(&[]).unwrap().len(), 0);
    no_line(&lines);
}

fn shell_probe_fake(
    features: Value,
    fail: bool,
    state: &'static str,
) -> (super::Sock, ToolClient, std::sync::mpsc::Receiver<String>) {
    let (sock, lines) = raw_fake(
        json!({"version": PROTOCOL_VERSION, "features": features}),
        move |req| {
            Some(if fail {
                err_resp(req.id, CODE_SERVER, "boom")
            } else {
                resp(req.id, json!({"state": state}))
            })
        },
    );
    let pc = dial(&sock);
    next_line(&lines);
    (sock, pc, lines)
}

#[test]
fn shell_probe_one_rpc() {
    let (_s, pc, lines) = shell_probe_fake(json!([FEATURE_SHELL_PROBE]), false, "here");
    assert_eq!(pc.shell_probe("a", Some(&[7, 8])), ShellState::Here);
    assert_eq!(
        next_line(&lines),
        r#"{"id":1,"method":"shellprobe","params":{"id":"a","pids":[7,8]}}"#
    );
}

#[test]
fn shell_probe_legacy() {
    let (_s, pc, lines) = shell_probe_fake(Value::Null, false, "idle");
    assert_eq!(pc.shell_probe("a", None), ShellState::Unknown);
    no_line(&lines);
}

#[test]
fn shell_probe_bad_is_unknown() {
    let (_s, pc, lines) = shell_probe_fake(json!([FEATURE_SHELL_PROBE]), true, "");
    assert_eq!(pc.shell_probe("a", None), ShellState::Unknown);
    assert_eq!(
        next_line(&lines),
        r#"{"id":1,"method":"shellprobe","params":{"id":"a","pids":null}}"#
    );
    let (_s, pc, _l) = shell_probe_fake(json!([FEATURE_SHELL_PROBE]), false, "뭔가");
    assert_eq!(pc.shell_probe("a", None), ShellState::Unknown);
}

fn hello_daemon(result: Value) -> super::Sock {
    raw_fake(result, |req| Some(resp(req.id, json!({})))).0
}

#[test]
fn hello_protocol_mismatch() {
    let sock = hello_daemon(json!({"version": PROTOCOL_VERSION + 1, "build": "9.9.9"}));
    let Err(err) = ToolClient::dial(&sock.path) else {
        panic!("프로토콜 판이 다른데 연결이 성립했다 (FR-VHL-3)");
    };
    assert_eq!(
        err.to_string(),
        format!(
            "dial otterminald: hello: protocol mismatch: daemon={} server={PROTOCOL_VERSION}",
            PROTOCOL_VERSION + 1
        )
    );
}

#[test]
fn hello_build_mismatch() {
    let sock = hello_daemon(json!({"version": PROTOCOL_VERSION, "build": "0.0.1-old"}));
    let pc = ToolClient::dial(&sock.path).expect("빌드 판이 다르다고 끊었다 (FR-VHL-4)");
    let info = pc.daemon_info();
    assert_eq!(info.protocol, PROTOCOL_VERSION);
    assert_eq!(info.build, "0.0.1-old");
}

#[test]
fn hello_legacy_daemon() {
    let sock = hello_daemon(json!({"tool_ids": []}));
    let pc = ToolClient::dial(&sock.path).expect("판을 말하지 않는 옛 데몬을 거부했다 (FR-VHL-5)");
    let info = pc.daemon_info();
    assert_eq!(info.protocol, PROTOCOL_VERSION);
    assert_eq!(info.build, "");
}

#[test]
fn hello_rpc_error_fails_dial() {
    let (sock, _l) = fake(|req| Some(err_resp(req.id, CODE_INTERNAL, "boom")));
    let Err(err) = ToolClient::dial(&sock.path) else {
        panic!("hello 오류에도 연결이 성립했다");
    };
    assert_eq!(
        err.to_string(),
        "dial otterminald: hello: paned error: boom"
    );
    assert_eq!(err.rpc().map(|r| r.code), Some(CODE_INTERNAL));
}

#[test]
fn dial_missing_socket_fails() {
    let dir = tempfile::tempdir().unwrap();
    let Err(err) = ToolClient::dial(dir.path().join("s")) else {
        panic!("없는 소켓에 붙었다");
    };
    assert!(
        err.to_string().starts_with("dial otterminald: dial unix "),
        "{err}"
    );
}

#[test]
fn create_tool_cap() {
    let (sock, _l) = raw_fake(version(), |req| {
        Some(if req.method == METHOD_CREATE {
            err_resp(req.id, CODE_TOOL_CAP, "cap")
        } else {
            resp(req.id, json!({}))
        })
    });
    let pc = dial(&sock);
    let err = pc
        .create("/tmp", 80, 24, &Placement::default())
        .unwrap_err();
    assert!(matches!(&err, Error::ToolCap(m) if m == "cap"), "{err:?}");
    assert_eq!(err.to_string(), "도구 수가 상한에 이르렀다: cap");
}

#[test]
fn rpc_error_code() {
    let (sock, _l) = raw_fake(version(), |req| {
        Some(if req.method == METHOD_KILL {
            err_resp(req.id, CODE_SERVER, "no such tool")
        } else {
            resp(req.id, json!({}))
        })
    });
    let pc = dial(&sock);
    let err = pc.delete("x").unwrap_err();
    let rpc = err.rpc().expect("RpcError 가 아니다");
    assert_eq!(
        (rpc.code, rpc.message.as_str()),
        (CODE_SERVER, "no such tool")
    );
}

#[test]
fn snapshot_not_found() {
    let (sock, _l) = raw_fake(version(), |req| {
        Some(err_resp(req.id, CODE_NOT_FOUND, "toolhub: tool not found"))
    });
    let pc = dial(&sock);
    let err = pc.snapshot_tool_since("x", -1).unwrap_err();
    assert!(
        matches!(&err, Error::ToolNotFound(id) if id == "x"),
        "{err:?}"
    );
    assert_eq!(err.to_string(), "toolhub: tool not found: x");
}

#[test]
fn hub_has_feature() {
    let (sock, _l) =
        ok_fake(json!({"version": PROTOCOL_VERSION, "features": [FEATURE_SNAPSHOT_NOT_FOUND]}));
    let pc = dial(&sock);
    assert!(pc.has_feature(FEATURE_SNAPSHOT_NOT_FOUND));
    assert!(!pc.has_feature(FEATURE_FOREGROUND_TICK));
}

/// 기록·알람·간선·채팅 RPC 의 요청 바이트다.
#[test]
fn ext_request_wire() {
    let (sock, lines) = ok_fake(version());
    let pc = dial(&sock);
    next_line(&lines);
    let _ = pc.record_set("agent", "t1", json::RawMessage(b"{\"a\":1}".to_vec()));
    let _ = pc.record_set("limits", "", json::RawMessage::default());
    let _ = pc.records();
    let _ = pc.attn_config(1500, true);
    let _ = pc.attend("t1", false);
    let _ = pc.attend_all();
    let _ = pc.report("notify", &json!({"toolId": "t1", "reason": "<done>"}));
    let _ = pc.edge(&otter_shared_toolipc::EdgeParams {
        op: "list".into(),
        ..Default::default()
    });
    let _ = pc.edge_port(&otter_shared_toolipc::EdgePortParams {
        addr: "127.0.0.1:60200".into(),
        listening: true,
        ..Default::default()
    });
    let _ = pc.chat(&otter_shared_toolipc::ChatParams {
        op: "rooms".into(),
        ..Default::default()
    });
    let _ = pc.screen_config(2000);
    let _ = pc.seat_tool("t1", true);
    let want = [
        r#"{"id":1,"method":"recordset","params":{"kind":"agent","tool":"t1","value":{"a":1}}}"#,
        r#"{"id":2,"method":"recordset","params":{"kind":"limits","value":null}}"#,
        r#"{"id":3,"method":"records","params":{}}"#,
        r#"{"id":4,"method":"attnconfig","params":{"idleMs":1500,"allowBell":true}}"#,
        r#"{"id":5,"method":"attend","params":{"tool":"t1"}}"#,
        r#"{"id":6,"method":"attendall","params":{}}"#,
        r#"{"id":7,"method":"report","params":{"method":"notify","body":{"reason":"\u003cdone\u003e","toolId":"t1"}}}"#,
        r#"{"id":8,"method":"edge","params":{"op":"list"}}"#,
        r#"{"id":9,"method":"edgeport","params":{"addr":"127.0.0.1:60200","listening":true}}"#,
        r#"{"id":10,"method":"chat","params":{"op":"rooms"}}"#,
        r#"{"id":11,"method":"screenconfig","params":{"historyLines":2000}}"#,
        r#"{"id":12,"method":"seat","params":{"held":true,"id":"t1"}}"#,
    ];
    for w in want {
        assert_eq!(next_line(&lines), w);
    }
}
