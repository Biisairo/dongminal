use std::io::{self, Cursor, Read, Write};

use super::*;

fn key() -> SigningKey {
    let mut seed = [0u8; 32];
    rand::fill(&mut seed);
    SigningKey::from_bytes(&seed)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn signed() -> Signed {
    sign(
        &key(),
        Body {
            id: new_id(),
            node: "n".into(),
            op: OP_KILL.into(),
            rooms: vec!["r".into()],
            at: now_ms(),
            ..Default::default()
        },
    )
    .unwrap()
}

/// 같은 서명 바이트를 다른 표기로 바꾼다: 마지막 글자의 남는 비트를 켜거나, 줄바꿈을 넣거나, 패딩을 뗀다.
fn non_canonical(s: &str) -> Vec<String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let i = s.len() - 3; // 64바이트 서명은 "..XY==" 로 끝나고 Y 의 아래 4비트가 남는다.
    let idx = ALPHABET.iter().position(|&c| c == s.as_bytes()[i]).unwrap();
    let bits = format!("{}{}{}", &s[..i], ALPHABET[idx | 1] as char, &s[i + 1..]);
    vec![
        bits,
        format!("{}\n{}", &s[..10], &s[10..]),
        s[..s.len() - 2].to_owned(),
    ]
}

// PEER_CHAT_SRS §3.12a R-10 — 서명은 정규 base64 표기만 받는다.
#[test]
fn open_accepts_canonical() {
    let s = signed();
    let b = open(&s).unwrap();
    assert_eq!(b.op, OP_KILL);
    assert_eq!(b.rooms, ["r"]);
}

#[test]
fn open_rejects_non_canonical_signature() {
    let s = signed();
    for alt in non_canonical(&s.s) {
        assert_ne!(alt, s.s);
        let e = open(&Signed {
            b: s.b.clone(),
            s: alt.clone(),
        })
        .unwrap_err();
        assert_eq!(e.to_string(), "humancmd: 서명이나 모양이 틀렸다", "{alt:?}");
    }
}

#[test]
fn open_rejects_tampered_body_and_bad_shape() {
    let s = signed();
    let mut b = s.b.0.clone();
    let pos = b.windows(4).position(|w| w == b"kill").unwrap();
    b[pos..pos + 4].copy_from_slice(b"kick");
    assert!(
        open(&Signed {
            b: RawMessage(b),
            s: s.s.clone()
        })
        .is_err()
    );
    assert!(
        open(&Signed {
            b: RawMessage(b"not json".to_vec()),
            s: s.s.clone()
        })
        .is_err()
    );

    let k = key();
    for body in [
        Body {
            id: String::new(),
            node: "n".into(),
            op: OP_KILL.into(),
            rooms: vec!["r".into()],
            ..Default::default()
        },
        Body {
            id: "a b".into(),
            node: "n".into(),
            op: OP_KILL.into(),
            rooms: vec!["r".into()],
            ..Default::default()
        },
        Body {
            id: new_id(),
            node: "n".into(),
            op: "nuke".into(),
            rooms: vec!["r".into()],
            ..Default::default()
        },
    ] {
        assert!(open(&sign(&k, body).unwrap()).is_err());
    }
}

// Body.key 는 Go StdEncoding(비엄격)으로 읽는다: 줄바꿈은 건너뛴다.
#[test]
fn open_reads_key_leniently() {
    let k = key();
    let mut b = Body {
        id: new_id(),
        node: "n".into(),
        op: OP_KILL.into(),
        rooms: vec!["r".into()],
        ..Default::default()
    };
    let pk = public_key(&k);
    b.key = format!("{}\n{}", &pk[..5], &pk[5..]);
    let raw = json::marshal(&b).unwrap();
    let sig = k.sign(&message(&raw));
    let s = Signed {
        b: RawMessage(raw),
        s: STANDARD.encode(sig.to_bytes()),
    };
    assert_eq!(open(&s).unwrap().key, b.key);
}

#[test]
fn body_wire_bytes_and_signature_domain() {
    let k = SigningKey::from_bytes(&[7u8; 32]);
    let s = sign(
        &k,
        Body {
            id: "abc".into(),
            node: "n1".into(),
            op: OP_KICK.into(),
            kicks: vec![Kick {
                room: "r".into(),
                participant: "p".into(),
            }],
            at: 5,
            ..Default::default()
        },
    )
    .unwrap();
    let pk = public_key(&k);
    assert_eq!(
        String::from_utf8(s.b.0.clone()).unwrap(),
        format!(
            r#"{{"id":"abc","node":"n1","op":"kick","kicks":[{{"room":"r","participant":"p"}}],"at":5,"key":"{pk}"}}"#
        )
    );
    // go1.27.2 crypto/ed25519 의 같은 시드·본문 결과(실측).
    assert_eq!(pk, "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=");
    assert_eq!(
        s.s,
        "ZjFqCHFfxSAr+TOGWG8mxN1c/lVPsTx1d15boJembqevEjxlWO6KNbOuuqNCfp0ImUXwmzbWtdJ8nTMLTwvHAQ=="
    );
    let mut msg = b"dmhuman1\x00".to_vec();
    msg.extend_from_slice(&s.b.0);
    assert_eq!(s.s, STANDARD.encode(k.sign(&msg).to_bytes()));
    assert_eq!(
        String::from_utf8(json::marshal(&s).unwrap()).unwrap(),
        format!(
            r#"{{"b":{},"s":"{}"}}"#,
            String::from_utf8(s.b.0.clone()).unwrap(),
            s.s
        )
    );
}

#[test]
fn frame_wire_bytes() {
    let f = Frame {
        t: TYPE_SIGN.into(),
        code: "123456".into(),
        req: Some(Request {
            node: "n".into(),
            op: OP_KILL.into(),
            rooms: vec!["a".into()],
            kicks: vec![],
        }),
        ..Default::default()
    };
    assert_eq!(
        String::from_utf8(json::marshal(&f).unwrap()).unwrap(),
        r#"{"t":"sign","code":"123456","req":{"node":"n","op":"kill","rooms":["a"]}}"#
    );
    assert_eq!(
        String::from_utf8(
            json::marshal(&Frame {
                t: TYPE_INFO.into(),
                ..Default::default()
            })
            .unwrap()
        )
        .unwrap(),
        r#"{"t":"info"}"#
    );
    let f = Frame {
        t: TYPE_ERROR.into(),
        code: CODE_LOCKED.into(),
        key: "k".into(),
        locked_until: 1,
        until: 2,
        b: RawMessage(br#"{ "x" : 1 }"#.to_vec()),
        s: "s".into(),
        ..Default::default()
    };
    assert_eq!(
        String::from_utf8(json::marshal(&f).unwrap()).unwrap(),
        r#"{"t":"error","code":"locked","key":"k","lockedUntil":1,"until":2,"b":{"x":1},"s":"s"}"#
    );
}

#[test]
fn request_valid_cases() {
    let kill = |rooms: Vec<&str>| Request {
        node: "n".into(),
        op: OP_KILL.into(),
        rooms: rooms.into_iter().map(String::from).collect(),
        kicks: vec![],
    };
    assert!(kill(vec!["r"]).valid());
    assert!(!kill(vec![]).valid());
    assert!(!kill(vec![""]).valid());
    assert!(!kill(vec!["r/1"]).valid());
    assert!(kill(vec!["r"; MAX_TARGETS]).valid());
    assert!(!kill(vec!["r"; MAX_TARGETS + 1]).valid());
    let mut r = kill(vec!["r"]);
    r.kicks = vec![Kick {
        room: "a".into(),
        participant: "b".into(),
    }];
    assert!(!r.valid());
    r.node = String::new();
    assert!(!r.valid());
    let long = "a".repeat(MAX_ID + 1);
    assert!(!kill(vec![long.as_str()]).valid());
    assert!(kill(vec!["a".repeat(MAX_ID).as_str()]).valid());
    assert!(!kill(vec!["é"]).valid());

    let kick = |k: Vec<(&str, &str)>| Request {
        node: "n".into(),
        op: OP_KICK.into(),
        rooms: vec![],
        kicks: k
            .into_iter()
            .map(|(r, p)| Kick {
                room: r.into(),
                participant: p.into(),
            })
            .collect(),
    };
    assert!(kick(vec![("r", "p")]).valid());
    assert!(!kick(vec![]).valid());
    assert!(!kick(vec![("r", "")]).valid());
    assert!(!kick(vec![("", "p")]).valid());
    assert!(!kick(vec![("r", "p q")]).valid());
}

#[test]
fn new_id_is_32_hex() {
    let id = new_id();
    assert_eq!(id.len(), 32);
    assert!(
        id.bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    assert_ne!(id, new_id());
}

#[test]
fn error_display_and_constants() {
    let e = Error {
        code: CODE_BAD_CODE.into(),
        until: 0,
    };
    assert_eq!(e.to_string(), "helper: bad_code");
    assert_eq!(Error::no_helper().to_string(), "helper: no_helper");
    assert_eq!(DEFAULT_TIMEOUT, std::time::Duration::from_secs(3));
    assert_eq!(MAX_LINE, 65536);
    assert_eq!(SOCKET_PATH, "/var/run/com.otterminal.helper.sock");
}

// ── 왕복 ──

struct Duplex {
    input: Cursor<Vec<u8>>,
    output: Vec<u8>,
    fail_read_after: Option<usize>,
}

impl Duplex {
    fn new(resp: &[u8]) -> Self {
        Self {
            input: Cursor::new(resp.to_vec()),
            output: Vec::new(),
            fail_read_after: None,
        }
    }
}

impl Read for Duplex {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if let Some(n) = self.fail_read_after
            && self.input.position() as usize >= n
        {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let cap = match self.fail_read_after {
            Some(n) => buf.len().min(n - self.input.position() as usize),
            None => buf.len(),
        };
        self.input.read(&mut buf[..cap])
    }
}

impl Write for Duplex {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.output.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn round_trip_writes_one_line_and_reads_one() {
    let mut d = Duplex::new(b"{\"t\":\"info\",\"key\":\"K\",\"lockedUntil\":9}\r\n{\"t\":\"x\"}\n");
    let f = round_trip(
        &mut d,
        &Frame {
            t: TYPE_INFO.into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(d.output, b"{\"t\":\"info\"}\n");
    assert_eq!(
        (f.t.as_str(), f.key.as_str(), f.locked_until),
        ("info", "K", 9)
    );
}

#[test]
fn round_trip_failures_are_no_helper() {
    let req = Frame {
        t: TYPE_INFO.into(),
        ..Default::default()
    };
    let mut over = vec![b'x'; MAX_LINE];
    over.push(b'\n');
    for resp in [&b""[..], b"\n", b"garbage\n", &over] {
        let e = round_trip(&mut Duplex::new(resp), &req).unwrap_err();
        assert_eq!(
            e.code,
            CODE_NO_HELPER,
            "{:?}",
            String::from_utf8_lossy(&resp[..resp.len().min(20)])
        );
    }
}

// Scanner: 줄바꿈 없는 마지막 조각도 토큰이다. 읽기 오류(마감 초과) 때도 그렇다.
#[test]
fn round_trip_accepts_unterminated_last_line() {
    let req = Frame {
        t: TYPE_INFO.into(),
        ..Default::default()
    };
    let f = round_trip(&mut Duplex::new(br#"{"t":"signed","s":"S"}"#), &req).unwrap();
    assert_eq!(f.s, "S");
    let body = br#"{"t":"error","code":"locked","until":3}"#;
    let mut d = Duplex::new(body);
    d.fail_read_after = Some(body.len());
    let f = round_trip(&mut d, &req).unwrap();
    assert_eq!((f.code.as_str(), f.until), ("locked", 3));
}

// 버퍼 상한: 줄바꿈 포함 MAX_LINE 바이트까지 받는다.
#[test]
fn round_trip_line_limit_boundary() {
    let req = Frame {
        t: TYPE_INFO.into(),
        ..Default::default()
    };
    let pad = MAX_LINE - 1 - r#"{"t":"info","key":""}"#.len();
    let line = format!(r#"{{"t":"info","key":"{}"}}"#, "k".repeat(pad));
    assert_eq!(line.len(), MAX_LINE - 1);
    let f = round_trip(&mut Duplex::new(format!("{line}\n").as_bytes()), &req).unwrap();
    assert_eq!(f.key.len(), pad);
    let line = format!(r#"{{"t":"info","key":"{}"}}"#, "k".repeat(pad + 1));
    assert!(round_trip(&mut Duplex::new(format!("{line}\n").as_bytes()), &req).is_err());
    assert!(round_trip(&mut Duplex::new(line.as_bytes()), &req).is_err());
}

// ── Client: 가짜 도우미 소켓 서버 ──

/// 요청 한 줄을 받아 돌려주고 resp 를 쓴다. 받은 줄은 join 으로 꺼낸다.
fn fake_helper(
    resp: &'static [u8],
) -> (tempfile::TempDir, Client, std::thread::JoinHandle<Vec<u8>>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("h.sock");
    let ln = otter_shared_platform::current().ipc.listen(&path).unwrap();
    let h = std::thread::spawn(move || {
        let mut conn = ln.accept().unwrap();
        let mut got = Vec::new();
        let mut b = [0u8; 1];
        while conn.read(&mut b).unwrap() == 1 && b[0] != b'\n' {
            got.push(b[0]);
        }
        conn.write_all(resp).unwrap();
        got
    });
    let c = Client {
        path,
        timeout: std::time::Duration::from_secs(2),
    };
    (dir, c, h)
}

#[test]
fn client_info() {
    let (_d, c, h) = fake_helper(b"{\"t\":\"info\",\"key\":\"K\",\"lockedUntil\":7}\n");
    assert_eq!(
        c.info().unwrap(),
        Info {
            key: "K".into(),
            locked_until: 7
        }
    );
    assert_eq!(h.join().unwrap(), br#"{"t":"info"}"#);
}

#[test]
fn client_info_without_key_is_no_helper() {
    let (_d, c, h) = fake_helper(b"{\"t\":\"info\"}\n");
    assert_eq!(c.info().unwrap_err().code, CODE_NO_HELPER);
    h.join().unwrap();
}

#[test]
fn client_sign_signed_error_and_other() {
    let req = Request {
        node: "n".into(),
        op: OP_KILL.into(),
        rooms: vec!["r".into()],
        kicks: vec![],
    };
    let (_d, c, h) = fake_helper(b"{\"t\":\"signed\",\"b\":{\"x\":1},\"s\":\"S\"}\n");
    let s = c.sign("123456", req.clone()).unwrap();
    assert_eq!((s.b.0.as_slice(), s.s.as_str()), (&br#"{"x":1}"#[..], "S"));
    assert_eq!(
        h.join().unwrap(),
        br#"{"t":"sign","code":"123456","req":{"node":"n","op":"kill","rooms":["r"]}}"#
    );
    let (_d, c, h) = fake_helper(b"{\"t\":\"error\",\"code\":\"locked\",\"until\":99}\n");
    assert_eq!(
        c.sign("1", req.clone()).unwrap_err(),
        Error {
            code: CODE_LOCKED.into(),
            until: 99
        }
    );
    h.join().unwrap();
    let (_d, c, h) = fake_helper(b"{\"t\":\"info\",\"key\":\"K\"}\n");
    assert_eq!(c.sign("1", req).unwrap_err().code, CODE_NO_HELPER);
    h.join().unwrap();
}

#[test]
fn client_unreachable_is_no_helper() {
    let dir = tempfile::tempdir().unwrap();
    let c = Client {
        path: dir.path().join("none.sock"),
        timeout: std::time::Duration::ZERO,
    };
    assert_eq!(c.info().unwrap_err().code, CODE_NO_HELPER);
}

// 도우미가 답하지 않으면 마감에서 끊고 no_helper 다.
#[test]
fn client_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("h.sock");
    let ln = otter_shared_platform::current().ipc.listen(&path).unwrap();
    let h = std::thread::spawn(move || {
        let conn = ln.accept().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(600));
        drop(conn);
    });
    let c = Client {
        path,
        timeout: std::time::Duration::from_millis(200),
    };
    let start = std::time::Instant::now();
    assert_eq!(c.info().unwrap_err().code, CODE_NO_HELPER);
    let took = start.elapsed();
    assert!(took < std::time::Duration::from_millis(500), "{took:?}");
    h.join().unwrap();
}
