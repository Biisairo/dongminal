//! 의사 터미널 (FR-XPT-1). 구현은 이슈 1.4.6 이 채운다.

use std::io;
use std::process::ExitStatus;

use crate::handover::Handover;

/// 의사 터미널에 붙일 프로세스의 명세.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcSpec {
    /// 실행 파일.
    pub path: String,
    /// args[0] 을 포함한 전체 argv.
    pub args: Vec<String>,
    /// "K=V" 목록. 완전한 환경이며 상속하지 않는다.
    pub env: Vec<String>,
    /// 작업 디렉터리.
    pub dir: String,
}

/// 의사 터미널을 만드는 능력.
pub trait Pty: Send + Sync {
    /// 새 의사 터미널을 만들고 그 안에 spec 을 띄운다.
    fn start(&self, spec: ProcSpec, cols: u16, rows: u16) -> io::Result<Box<dyn Terminal>>;
}

/// 의사 터미널의 마스터측과 거기 붙은 프로세스를 함께 소유한다.
/// 읽기·쓰기·크기 조절이 서로 다른 스레드에서 함께 일어나므로 모든 메서드가 `&self` 다.
pub trait Terminal: Send + Sync {
    fn read(&self, buf: &mut [u8]) -> io::Result<usize>;
    fn write(&self, buf: &[u8]) -> io::Result<usize>;
    /// 터미널을 닫는다. 프로세스를 끝내지는 않는다.
    fn close(&self) -> io::Result<()>;
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()>;
    /// `(cols, rows)`.
    fn size(&self) -> io::Result<(u16, u16)>;
    /// 셸이 아닌 전경 프로그램의 프로세스 그룹 id. 없거나 모르면 None (FR-TAN-6/24).
    fn foreground_pgid(&self) -> Option<i32>;
    /// 붙은 프로세스. 0 이면 없다.
    fn pid(&self) -> i32;
    /// 프로세스 종료를 기다리고 자원을 수확한다.
    fn wait(&self) -> io::Result<ExitStatus>;
    fn terminate(&self) -> io::Result<()>;
    fn kill(&self) -> io::Result<()>;
    /// 데몬 교체 능력. POSIX 터미널만 갖는다 (D-DSK-7).
    fn handover(&self) -> Option<&dyn Handover>;
}

struct Pending;

impl Pty for Pending {
    fn start(&self, _: ProcSpec, _: u16, _: u16) -> io::Result<Box<dyn Terminal>> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

pub(crate) fn current() -> &'static dyn Pty {
    &Pending
}
