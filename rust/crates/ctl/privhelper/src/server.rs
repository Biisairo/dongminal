//! 도우미 소켓이다 (FR-PCH-73). 연결 하나에 요청 하나다.

use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use dm_gocompat::json;
use dm_shared_humancmd::{
    self as humancmd, Body, CODE_BAD_CODE, CODE_BAD_REQUEST, Deadline, Frame, TYPE_ERROR,
    TYPE_INFO, TYPE_SIGN, TYPE_SIGNED,
};
use dm_shared_platform::{IpcListener, IpcStream};
use ed25519_dalek::SigningKey;

use crate::guard::{Clock, Guard, Save};
use crate::secret::{Secret, decode_key};
use crate::totp::unix_millis;

const CONN_WAIT: Duration = Duration::from_secs(5);

/// 동시에 처리하는 연결의 상한이다 (FR-RSP-6). Go 판은 상한이 없어 같은 uid 의 프로세스가
/// 연결을 쌓으면 fd 가 바닥나 Accept 가 실패하고 도우미가 끝났다. 넘는 연결은 바로 닫는다.
pub const MAX_CONNS: usize = 32;

pub(crate) type PeerUid = Box<dyn Fn(&IpcStream) -> io::Result<i64> + Send + Sync>;

struct Inner {
    uid: i64,
    key: SigningKey,
    guard: Guard,
    now: Clock,
    peer_uid: PeerUid,
    active: AtomicUsize,
}

/// 도우미 서버다.
pub struct Server(Arc<Inner>);

/// 비밀의 서명 키나 TOTP 비밀이 틀렸다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadSecret;

impl std::fmt::Display for BadSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("privhelper: 서명 키가 틀렸다")
    }
}

impl std::error::Error for BadSecret {}

/// 연결 수 표. 놓으면 하나 줄인다.
struct Slot<'a>(&'a AtomicUsize);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Server {
    /// 비밀로 도우미를 세운다. save 는 쓴 복구 코드를 남긴다.
    pub(crate) fn new(
        sec: Secret,
        now: Clock,
        save: Save,
        peer_uid: PeerUid,
    ) -> Result<Self, BadSecret> {
        let seed = decode_key(&sec.key).ok_or(BadSecret)?;
        let uid = sec.uid;
        let guard = Guard::new(sec, now.clone(), save).ok_or(BadSecret)?;
        Ok(Self(Arc::new(Inner {
            uid,
            key: SigningKey::from_bytes(&seed),
            guard,
            now,
            peer_uid,
            active: AtomicUsize::new(0),
        })))
    }

    /// 연결을 받는다. 리스너가 실패하면 돌아온다.
    pub fn serve(&self, ln: &IpcListener) -> io::Result<()> {
        loop {
            let c = ln.accept()?;
            if self.0.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNS {
                self.0.active.fetch_sub(1, Ordering::SeqCst);
                drop(c);
                continue;
            }
            let inner = Arc::clone(&self.0);
            std::thread::spawn(move || {
                let _slot = Slot(&inner.active);
                inner.handle(&c);
            });
        }
    }

    #[cfg(test)]
    pub(crate) fn public_key(&self) -> String {
        humancmd::public_key(&self.0.key)
    }
}

fn error_frame(code: &str, until: i64) -> Frame {
    Frame {
        t: TYPE_ERROR.into(),
        code: code.into(),
        until,
        ..Default::default()
    }
}

impl Inner {
    fn handle(&self, c: &IpcStream) {
        let mut d = Deadline::new(c, CONN_WAIT);
        match (self.peer_uid)(c) {
            Ok(uid) if uid == self.uid => {}
            _ => return,
        }
        let Some(line) = humancmd::read_line(&mut d) else {
            return;
        };
        let resp = match json::unmarshal::<Frame>(&line) {
            Ok(req) => self.answer(req),
            Err(_) => error_frame(CODE_BAD_REQUEST, 0),
        };
        let Ok(mut out) = json::marshal(&resp) else {
            return;
        };
        out.push(b'\n');
        let _ = d.write_all(&out);
    }

    fn answer(&self, req: Frame) -> Frame {
        match req.t.as_str() {
            TYPE_INFO => Frame {
                t: TYPE_INFO.into(),
                key: humancmd::public_key(&self.key),
                locked_until: self.guard.locked_until().map_or(0, unix_millis),
                ..Default::default()
            },
            TYPE_SIGN => self.sign(req),
            _ => error_frame(CODE_BAD_REQUEST, 0),
        }
    }

    /// 묶음의 모양을 먼저 본다 — 틀린 묶음은 코드를 쓰지 않는다. 코드가 맞으면 묶음 전체에
    /// 서명 하나를 붙인다 (FR-PCH-71).
    fn sign(&self, req: Frame) -> Frame {
        let Some(r) = req.req.filter(humancmd::Request::valid) else {
            return error_frame(CODE_BAD_REQUEST, 0);
        };
        if let Err(e) = self.guard.check(&req.code) {
            let code = if e.code.is_empty() {
                CODE_BAD_CODE.into()
            } else {
                e.code
            };
            return error_frame(&code, e.until);
        }
        let body = Body {
            id: humancmd::new_id(),
            node: r.node,
            op: r.op,
            rooms: r.rooms,
            kicks: r.kicks,
            at: unix_millis((self.now)()),
            key: String::new(),
        };
        match humancmd::sign(&self.key, body) {
            Ok(s) => Frame {
                t: TYPE_SIGNED.into(),
                b: s.b,
                s: s.s,
                ..Default::default()
            },
            Err(_) => error_frame(CODE_BAD_REQUEST, 0),
        }
    }
}
