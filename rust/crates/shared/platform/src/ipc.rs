//! dongminal(웹서버) ↔ dongminald(데몬) 사이의 로컬 전송 (FR-XIP-1). 구현은 이슈 1.4.5 가 채운다.
//!
//! 유닉스 도메인 소켓이다. Windows 도 AF_UNIX 를 쓴다.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 종단 파일의 이름.
pub const SOCKET_FILE_NAME: &str = "paned.sock";

/// 로컬 전송.
pub trait Ipc: Send + Sync {
    /// home 에 대응하는 종단 주소.
    fn endpoint(&self, home: &Path) -> PathBuf;
    fn listen(&self, endpoint: &Path) -> io::Result<IpcListener>;
    fn dial(&self, endpoint: &Path, timeout: Duration) -> io::Result<IpcStream>;
    /// 종단이 놓여 있는지. 살아 있는지가 아니다.
    fn exists(&self, endpoint: &Path) -> bool;
    /// 잔여 종단을 치운다.
    fn remove(&self, endpoint: &Path) -> io::Result<()>;
}

/// 받는 쪽 종단. 1.4.5 가 accept 등을 채운다.
#[derive(Debug)]
pub struct IpcListener {
    _private: (),
}

/// 연결 하나. 1.4.5 가 Read·Write 등을 채운다.
#[derive(Debug)]
pub struct IpcStream {
    _private: (),
}

/// home 의 IPC 종단과 같은 폴더(0700)에 사는 소켓 name 의 경로.
pub fn sibling_socket(home: &Path, name: &str) -> PathBuf {
    crate::atomic::parent_dir(&crate::current().ipc.endpoint(home)).join(name)
}

struct Pending;

impl Ipc for Pending {
    fn endpoint(&self, home: &Path) -> PathBuf {
        home.join(SOCKET_FILE_NAME)
    }
    fn listen(&self, _: &Path) -> io::Result<IpcListener> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
    fn dial(&self, _: &Path, _: Duration) -> io::Result<IpcStream> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
    fn exists(&self, _: &Path) -> bool {
        false
    }
    fn remove(&self, _: &Path) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

pub(crate) fn current() -> &'static dyn Ipc {
    &Pending
}
