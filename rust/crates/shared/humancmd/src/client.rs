use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use dm_shared_platform::IpcStream;

use crate::{
    DEFAULT_TIMEOUT, Error, Frame, Request, Signed, TYPE_ERROR, TYPE_INFO, TYPE_SIGN, TYPE_SIGNED,
    round_trip,
};

/// 데몬 쪽의 도우미 클라이언트다. 연결 하나에 요청 하나다. `timeout` 이 0 이면 [`DEFAULT_TIMEOUT`] 이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Client {
    pub path: PathBuf,
    pub timeout: Duration,
}

/// 도우미 공개키와 잠금 시각이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Info {
    pub key: String,
    pub locked_until: i64,
}

impl Client {
    /// 도우미에게 공개키를 묻는다. 닿지 않으면 `no_helper` 다.
    pub fn info(&self) -> Result<Info, Error> {
        let f = self.round_trip(&Frame {
            t: TYPE_INFO.into(),
            ..Default::default()
        })?;
        if f.t != TYPE_INFO || f.key.is_empty() {
            return Err(Error::no_helper());
        }
        Ok(Info {
            key: f.key,
            locked_until: f.locked_until,
        })
    }

    /// 코드와 묶음을 보내 서명을 받는다. 도우미가 거절하면 그 코드의 [`Error`] 다.
    pub fn sign(&self, code: &str, r: Request) -> Result<Signed, Error> {
        let f = self.round_trip(&Frame {
            t: TYPE_SIGN.into(),
            code: code.into(),
            req: Some(r),
            ..Default::default()
        })?;
        match f.t.as_str() {
            TYPE_SIGNED => Ok(Signed { b: f.b, s: f.s }),
            TYPE_ERROR => Err(Error {
                code: f.code,
                until: f.until,
            }),
            _ => Err(Error::no_helper()),
        }
    }

    fn round_trip(&self, req: &Frame) -> Result<Frame, Error> {
        let wait = if self.timeout.is_zero() {
            DEFAULT_TIMEOUT
        } else {
            self.timeout
        };
        let conn = dm_shared_platform::current()
            .ipc
            .dial(&self.path, wait)
            .map_err(|_| Error::no_helper())?;
        round_trip(&mut Deadline::new(&conn, wait), req)
    }
}

/// Go `conn.SetDeadline(now+wait)`: 연결 전체에 걸린 절대 마감이다. 읽기·쓰기마다 남은 시간을
/// 시간 제한으로 건다. 느린 송신으로 연결을 마감 너머까지 붙들 수 없다.
pub struct Deadline<'a> {
    conn: &'a IpcStream,
    at: Instant,
}

impl<'a> Deadline<'a> {
    pub fn new(conn: &'a IpcStream, wait: Duration) -> Self {
        Self {
            conn,
            at: Instant::now() + wait,
        }
    }

    fn remaining(&self) -> io::Result<Duration> {
        let left = self.at.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        Ok(left)
    }
}

impl Read for Deadline<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.conn.set_read_timeout(Some(self.remaining()?))?;
        let mut c = self.conn;
        c.read(buf)
    }
}

impl Write for Deadline<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.conn.set_write_timeout(Some(self.remaining()?))?;
        let mut c = self.conn;
        c.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut c = self.conn;
        c.flush()
    }
}
