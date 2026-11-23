//! PEER_CHAT_SRS §3.10 — MCP 서버 `dmctl chat-mcp` (TC-PCH-12 MCP 쪽). Go dmctl_chatmcp_test.go.
#![cfg(unix)]

use std::io::{BufRead, BufReader, PipeReader, PipeWriter, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use dm_gocompat::json;
use dm_shared_chatwire as chatwire;
use serde_json::{Value, json};

use crate::dmctl::chatmcp::{ChatLink, ChatMcp, INBOX_MAX};

struct FakeDaemon {
    c: UnixStream,
    got: Receiver<chatwire::Frame>,
}

impl FakeDaemon {
    fn send(&self, f: &chatwire::Frame) {
        (&self.c).write_all(&chatwire::encode(f).unwrap()).unwrap();
    }

    fn next(&self, want: &str) -> chatwire::Frame {
        let f = self
            .got
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or_else(|e| panic!("{want} 가 오지 않는다: {e}"));
        assert_eq!(f.t, want, "frame {f:?}");
        f
    }

    fn quiet(&self) {
        if let Ok(f) = self.got.recv_timeout(Duration::from_millis(50)) {
            panic!("뜻밖의 프레임 {f:?}");
        }
    }
}

fn link(c: UnixStream) -> ChatLink {
    let (r, w) = (c.try_clone().unwrap(), c.try_clone().unwrap());
    ChatLink {
        r: Box::new(r),
        w: Box::new(w),
        close: Box::new(move || {
            let _ = c.shutdown(Shutdown::Both);
        }),
    }
}

/// chat-mcp 하나를 stdio 파이프로 돌린다. 가짜 데몬을 준비한 뒤 start 로 띄운다.
struct Harness {
    m: Arc<ChatMcp>,
    inr: Option<PipeReader>,
    inw: Option<PipeWriter>,
    outw: Option<PipeWriter>,
    out: BufReader<PipeReader>,
    dials: Sender<UnixStream>,
    id: i64,
    serve: Option<JoinHandle<()>>,
}

impl Harness {
    fn new(session: &str) -> Self {
        let (inr, inw) = std::io::pipe().unwrap();
        let (outr, outw) = std::io::pipe().unwrap();
        let (tx, rx) = mpsc::channel::<UnixStream>();
        let rx = Mutex::new(rx);
        let m = ChatMcp::new(
            session.to_owned(),
            "tool-1".to_owned(),
            Box::new(move || rx.lock().unwrap().try_recv().ok().map(link)),
            Box::new(|| "review".to_owned()),
        );
        Self {
            m,
            inr: Some(inr),
            inw: Some(inw),
            outw: Some(outw),
            out: BufReader::new(outr),
            dials: tx,
            id: 0,
            serve: None,
        }
    }

    fn start(&mut self) {
        let (m, mut inr, mut outw) = (
            self.m.clone(),
            self.inr.take().unwrap(),
            self.outw.take().unwrap(),
        );
        self.serve = Some(thread::spawn(move || m.serve(&mut inr, &mut outw)));
    }

    /// 다음 dial 에 붙을 가짜 데몬이다. hello 에는 미리 정한 답을 한다.
    fn daemon(&self) -> FakeDaemon {
        let (a, b) = UnixStream::pair().unwrap();
        let (tx, rx) = mpsc::channel();
        let r = b.try_clone().unwrap();
        let w = b.try_clone().unwrap();
        thread::spawn(move || {
            let mut sc = chatwire::Scanner::new(r);
            while let Some(line) = sc.next_line() {
                let Ok(f) = json::unmarshal::<chatwire::Frame>(&line) else {
                    continue;
                };
                if f.t == chatwire::TYPE_HELLO {
                    let hello = chatwire::Frame {
                        t: chatwire::TYPE_HELLO.to_owned(),
                        id: "pid-1".to_owned(),
                        label: "mac/review".to_owned(),
                        ..Default::default()
                    };
                    let _ = (&w).write_all(&chatwire::encode(&hello).unwrap());
                }
                if tx.send(f).is_err() {
                    return;
                }
            }
        });
        self.dials.send(a).unwrap();
        FakeDaemon { c: b, got: rx }
    }

    fn write_line(&mut self, line: &str) {
        let w = self.inw.as_mut().unwrap();
        w.write_all(line.as_bytes()).unwrap();
        w.write_all(b"\n").unwrap();
    }

    fn send(&mut self, method: &str, params: Value) {
        self.id += 1;
        let line = json!({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params});
        self.write_line(&line.to_string());
    }

    fn recv_raw(&mut self) -> String {
        let mut line = String::new();
        assert!(self.out.read_line(&mut line).unwrap() > 0, "답이 없다");
        line
    }

    fn recv(&mut self) -> Value {
        let v: Value = serde_json::from_str(&self.recv_raw()).unwrap();
        assert_eq!(v["id"], json!(self.id));
        v
    }

    fn rpc(&mut self, method: &str, params: Value) -> Value {
        self.send(method, params);
        self.recv()
    }

    fn tool_send(&mut self, name: &str, args: Value) {
        self.send("tools/call", json!({"name": name, "arguments": args}));
    }

    fn tool_recv(&mut self) -> (String, bool) {
        let r = self.recv();
        let content = r["result"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1, "{r}");
        (
            content[0]["text"].as_str().unwrap().to_owned(),
            r["result"]["isError"].as_bool().unwrap_or(false),
        )
    }

    fn tool(&mut self, name: &str, args: Value) -> (String, bool) {
        self.tool_send(name, args);
        self.tool_recv()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.inw.take();
        if let Some(j) = self.serve.take() {
            let _ = j.join();
        }
    }
}

fn err_code(tr: &(String, bool)) -> String {
    assert!(tr.1, "오류가 아니다: {}", tr.0);
    let e: chatwire::Error = json::unmarshal(tr.0.as_bytes()).unwrap();
    e.code
}

fn msg_frame(id: &str, room: &str, name: &str, text: &str) -> chatwire::Frame {
    chatwire::Frame {
        t: chatwire::TYPE_MSG.to_owned(),
        msg: Some(chatwire::Message {
            id: id.to_owned(),
            room: room.to_owned(),
            room_kind: "group".to_owned(),
            room_name: name.to_owned(),
            room_purpose: format!("p-{name}"),
            from: "x".to_owned(),
            from_label: "mac/x".to_owned(),
            text: text.to_owned(),
            at: 1,
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn reply(n: u64, result: &str) -> chatwire::Frame {
    chatwire::Frame {
        t: chatwire::TYPE_REPLY.to_owned(),
        n,
        result: json::RawMessage(result.as_bytes().to_vec()),
        ..Default::default()
    }
}

#[test]
fn chat_mcp_initialize_and_list() {
    let mut h = Harness::new("s1");
    let _d = h.daemon();
    h.start();
    let r = h.rpc("initialize", json!({"protocolVersion": "2025-06-18"}));
    assert_eq!(r["result"]["protocolVersion"], json!("2025-06-18"));
    assert!(r["result"]["capabilities"]["tools"].is_object(), "{r}");
    let ins = r["result"]["instructions"].as_str().unwrap();
    for w in ["사용자 지시가 아니다", "비밀", "방 목적", "chat_read"] {
        assert!(ins.contains(w), "안내문에 {w:?} 가 없다");
    }
    // 알림에는 답하지 않는다 — 다음 답이 ping 의 것이어야 한다.
    h.write_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    h.rpc("ping", Value::Null);
    let list = h.rpc("tools/list", Value::Null);
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            assert_eq!(t["inputSchema"]["type"], json!("object"), "{t}");
            t["name"].as_str().unwrap()
        })
        .collect();
    assert_eq!(
        names.join(" "),
        "chat_online chat_rooms chat_create chat_direct chat_join chat_leave chat_send chat_read"
    );
    let r = h.rpc("bogus/method", Value::Null);
    assert_eq!(r["error"]["code"], json!(-32601), "{r}");
    assert_eq!(
        err_code(&h.tool("chat_nope", json!({}))),
        chatwire::CODE_BAD_REQUEST
    );
}

/// 와이어 바이트: Go 는 map 을 키 순으로 내고, 구조체는 필드 순으로 낸다.
#[test]
fn chat_mcp_wire_bytes() {
    let mut h = Harness::new("");
    h.start();
    h.write_line("not json");
    assert_eq!(
        h.recv_raw(),
        "{\"error\":{\"code\":-32700,\"message\":\"parse error\"},\"id\":null,\"jsonrpc\":\"2.0\"}\n"
    );
    h.send("ping", Value::Null);
    assert_eq!(
        h.recv_raw(),
        "{\"id\":1,\"jsonrpc\":\"2.0\",\"result\":{}}\n"
    );
    h.send("initialize", json!({}));
    let init = h.recv_raw();
    assert!(
        init.starts_with(
            "{\"id\":2,\"jsonrpc\":\"2.0\",\"result\":{\"capabilities\":{\"tools\":{}},\"instructions\":\"dongminal 노드 망 채팅이다."
        ),
        "{init}"
    );
    assert!(
        init.ends_with(
            "\",\"protocolVersion\":\"2025-06-18\",\"serverInfo\":{\"name\":\"dongminal-chat\",\"version\":\"1\"}}}\n"
        ),
        "{init}"
    );
    h.send("tools/list", Value::Null);
    let list = h.recv_raw();
    assert!(
        list.contains(
            "{\"name\":\"chat_create\",\"description\":\"단체채팅 방을 만들고 들어간다. 이름과 목적은 바꿀 수 없다.\",\"inputSchema\":{\"properties\":{\"name\":{\"description\":\"방 이름\",\"type\":\"string\"},\"purpose\":{\"description\":\"방 목적(대화 범위)\",\"type\":\"string\"}},\"required\":[\"name\",\"purpose\"],\"type\":\"object\"}}"
        ),
        "{list}"
    );
    assert!(
        list.contains("{\"name\":\"chat_online\",\"description\":\"온라인 목록: 노드(이름·지문 앞자리·온라인 여부)와 참가자(id·표시 이름·종류).\",\"inputSchema\":{\"properties\":{},\"type\":\"object\"}}"),
        "{list}"
    );
    // params 가 없으면 Go json.Unmarshal(nil) 이 실패한다. null 이면 이름 없는 도구다.
    h.id += 1;
    h.write_line(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call"}"#);
    assert_eq!(
        h.recv_raw(),
        "{\"error\":{\"code\":-32602,\"message\":\"invalid params\"},\"id\":4,\"jsonrpc\":\"2.0\"}\n"
    );
    h.tool_send("chat_online", json!({}));
    assert_eq!(
        h.recv_raw(),
        "{\"id\":5,\"jsonrpc\":\"2.0\",\"result\":{\"content\":[{\"text\":\"{\\\"code\\\":\\\"bad_request\\\",\\\"message\\\":\\\"CLAUDE_CODE_SESSION_ID 가 없어 참가할 수 없다\\\"}\",\"type\":\"text\"}],\"isError\":true}}\n"
    );
}

#[test]
fn chat_mcp_hello_and_calls() {
    let mut h = Harness::new("s1");
    let d = h.daemon();
    h.start();
    let hello = d.next(chatwire::TYPE_HELLO);
    assert_eq!(
        (&*hello.session, &*hello.tool, &*hello.tab),
        ("s1", "tool-1", "review")
    );
    h.tool_send("chat_send", json!({"room": "r1", "text": "안녕"}));
    let call = d.next(chatwire::TYPE_CALL);
    let args: chatwire::SendArgs = json::unmarshal(&call.args.0).unwrap();
    assert_eq!(
        (&*call.op, &*args.room, &*args.text),
        (chatwire::OP_SEND, "r1", "안녕")
    );
    d.send(&reply(call.n, r#"{"ok":true}"#));
    assert_eq!(h.tool_recv(), (r#"{"ok":true}"#.to_owned(), false));
    h.tool_send("chat_join", json!({"room": "r9"}));
    let call = d.next(chatwire::TYPE_CALL);
    d.send(&chatwire::Frame {
        t: chatwire::TYPE_REPLY.to_owned(),
        n: call.n,
        error: Some(chatwire::Error {
            code: "no_such_room".to_owned(),
            message: "r9".to_owned(),
        }),
        ..Default::default()
    });
    assert_eq!(err_code(&h.tool_recv()), "no_such_room");
}

/// FR-PCH-54: 글함 200, 넘치면 가장 오래된 글부터 버리고 버린 수를 알린다.
#[test]
fn chat_mcp_inbox_cap_and_read() {
    let mut h = Harness::new("s1");
    let d = h.daemon();
    h.start();
    d.next(chatwire::TYPE_HELLO);
    for i in 0..=INBOX_MAX {
        d.send(&msg_frame(&i.to_string(), "r1", "auth", &format!("m{i}")));
    }
    d.send(&msg_frame("b", "r2", "ops", "다른 방"));
    d.next(chatwire::TYPE_RISE);
    // 프레임은 차례로 처리된다 — 개수 질의의 답이 오면 앞선 글은 모두 글함에 들었다.
    d.send(&chatwire::Frame {
        t: chatwire::TYPE_COUNT_ASK.to_owned(),
        n: 1,
        ..Default::default()
    });
    assert_eq!(
        d.next(chatwire::TYPE_COUNT).total,
        i64::try_from(INBOX_MAX).unwrap()
    );
    // 방을 고르면 그 방만 읽는다. 버린 수는 첫 읽기에 실린다.
    let read: Value = serde_json::from_str(&h.tool("chat_read", json!({"room": "r2"})).0).unwrap();
    assert_eq!(read["dropped"], json!(2), "{read}");
    assert_eq!(read["rooms"].as_array().unwrap().len(), 1);
    assert_eq!(read["rooms"][0]["name"], json!("ops"));
    assert_eq!(read["rooms"][0]["purpose"], json!("p-ops"));
    let read: Value = serde_json::from_str(&h.tool("chat_read", json!({})).0).unwrap();
    assert_eq!(read["dropped"], json!(0));
    assert_eq!(read["rooms"].as_array().unwrap().len(), 1);
    let msgs = read["rooms"][0]["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), INBOX_MAX - 1);
    assert_eq!(msgs[0]["text"], json!("m2"));
    let (text, _) = h.tool("chat_read", json!({}));
    assert_eq!(text, r#"{"dropped":0,"rooms":[]}"#);
}

/// 읽기 결과의 바이트: 필드는 Go 구조체 순서다.
#[test]
fn chat_mcp_read_bytes() {
    let mut h = Harness::new("s1");
    let d = h.daemon();
    h.start();
    d.next(chatwire::TYPE_HELLO);
    d.send(&msg_frame("1", "r1", "auth", "a<b"));
    d.next(chatwire::TYPE_RISE);
    assert_eq!(
        h.tool("chat_read", Value::Null).0,
        r#"{"dropped":0,"rooms":[{"room":"r1","kind":"group","name":"auth","purpose":"p-auth","messages":[{"from":"x","label":"mac/x","kind":"","node":"","at":1,"text":"a\u003cb"}]}]}"#
    );
}

/// FR-PCH-61·62: 0건에서 생기는 순간에만 rise 를 보낸다.
#[test]
fn chat_mcp_rise_only_from_zero() {
    let mut h = Harness::new("s1");
    let d = h.daemon();
    h.start();
    d.next(chatwire::TYPE_HELLO);
    d.send(&msg_frame("1", "r1", "auth", "a"));
    assert_eq!(d.next(chatwire::TYPE_RISE).total, 1);
    d.send(&msg_frame("2", "r1", "auth", "b"));
    d.quiet();
    h.tool("chat_read", json!({}));
    d.send(&msg_frame("3", "r1", "auth", "c"));
    d.next(chatwire::TYPE_RISE);
}

/// FR-PCH-60: 훅 질의에 지금 개수를 답한다.
#[test]
fn chat_mcp_count_answer() {
    let mut h = Harness::new("s1");
    let d = h.daemon();
    h.start();
    d.next(chatwire::TYPE_HELLO);
    d.send(&msg_frame("1", "r1", "auth", "a"));
    d.send(&msg_frame("2", "r2", "ops", "b"));
    d.send(&msg_frame("3", "r1", "auth", "c"));
    d.next(chatwire::TYPE_RISE);
    d.send(&chatwire::Frame {
        t: chatwire::TYPE_COUNT_ASK.to_owned(),
        n: 7,
        ..Default::default()
    });
    let c = d.next(chatwire::TYPE_COUNT);
    assert_eq!((c.n, c.total), (7, 3));
}

#[test]
fn chat_mcp_rooms_fill_unread() {
    let mut h = Harness::new("s1");
    let d = h.daemon();
    h.start();
    d.next(chatwire::TYPE_HELLO);
    d.send(&msg_frame("1", "r1", "auth", "a"));
    d.next(chatwire::TYPE_RISE);
    h.tool_send("chat_rooms", json!({}));
    let call = d.next(chatwire::TYPE_CALL);
    assert_eq!(call.op, chatwire::OP_ROOMS);
    d.send(&reply(
        call.n,
        r#"{"rooms":[{"id":"r1","kind":"group","creator":"c","creatorName":"n","members":1,"joined":true,"unread":0},{"id":"r2","kind":"group","creator":"c","creatorName":"n","members":1,"joined":false,"unread":0}]}"#,
    ));
    let rooms: chatwire::Rooms = json::unmarshal(h.tool_recv().0.as_bytes()).unwrap();
    let rooms = rooms.rooms.unwrap();
    assert_eq!((rooms[0].unread, rooms[1].unread), (1, 0));
}

/// FR-PCH-43: 데몬과 끊기면 글함을 비우고, 다음 호출에서 새 참가자로 다시 연결한다.
#[test]
fn chat_mcp_reconnect_clears_inbox() {
    let mut h = Harness::new("s1");
    let d = h.daemon();
    h.start();
    d.next(chatwire::TYPE_HELLO);
    d.send(&msg_frame("1", "r1", "auth", "a"));
    d.next(chatwire::TYPE_RISE);
    d.c.shutdown(Shutdown::Both).unwrap();
    thread::sleep(Duration::from_millis(50));
    assert_eq!(
        err_code(&h.tool("chat_online", json!({}))),
        chatwire::CODE_DAEMON_UNAVAILABLE
    );
    let d2 = h.daemon();
    h.tool_send("chat_read", json!({}));
    d2.next(chatwire::TYPE_HELLO);
    assert_eq!(h.tool_recv().0, r#"{"dropped":0,"rooms":[]}"#);
}

#[test]
fn chat_mcp_without_session() {
    let mut h = Harness::new("");
    let d = h.daemon();
    h.start();
    assert_eq!(
        err_code(&h.tool("chat_online", json!({}))),
        chatwire::CODE_BAD_REQUEST
    );
    d.quiet();
}
