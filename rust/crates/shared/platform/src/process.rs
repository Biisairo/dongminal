//! pid 로 지목한 프로세스의 생명주기 제어 (FR-XPR-1). 구현은 이슈 1.4.4 가 채운다.

use std::io;
use std::process::{Child, Command};

/// 프로세스 생명주기 제어. 호출부는 "정중히 요청한다(terminate)" 와 "즉시 끝낸다(kill)" 만 안다.
pub trait Process: Send + Sync {
    /// pid 가 살아 있는지. 확인할 수 없으면 살아 있는 것으로 본다.
    fn alive(&self, pid: i32) -> bool;
    /// 정중한 종료를 요청한다.
    fn terminate(&self, pid: i32) -> io::Result<()>;
    /// 즉시 종료다.
    fn kill(&self, pid: i32) -> io::Result<()>;
    /// 부모와 수명·제어 터미널을 분리해 띄우도록 cmd 를 준비한다. spawn **전에** 부른다.
    fn detach(&self, cmd: &mut Command);
    /// "정중히 종료하라" 로 받아들일 신호 번호들.
    fn shutdown_signals(&self) -> &'static [i32];
    /// cmd 와 그 자손 전체를 한 묶음으로 만들 준비를 하고 그 핸들을 낸다. spawn **전에** 부른다.
    fn new_group(&self, cmd: &mut Command) -> Box<dyn Group>;
}

/// 프로세스 묶음. POSIX 프로세스 그룹 / Windows Job Object.
pub trait Group: Send + Sync {
    /// spawn **직후에 반드시** 부른다. Windows 는 여기서 Job 에 배정하고 자식을 재개한다 (FR-XPR-5).
    fn bind(&self, child: &Child) -> io::Result<()>;
    fn terminate(&self) -> io::Result<()>;
    fn kill(&self) -> io::Result<()>;
    /// 묶음의 자원을 놓는다. 여러 번 불려도 안전하다.
    fn close(&self) -> io::Result<()>;
}

struct Pending;

fn unsupported() -> io::Error {
    io::Error::from(io::ErrorKind::Unsupported)
}

impl Process for Pending {
    fn alive(&self, _: i32) -> bool {
        true
    }
    fn terminate(&self, _: i32) -> io::Result<()> {
        Err(unsupported())
    }
    fn kill(&self, _: i32) -> io::Result<()> {
        Err(unsupported())
    }
    fn detach(&self, _: &mut Command) {}
    fn shutdown_signals(&self) -> &'static [i32] {
        &[]
    }
    fn new_group(&self, _: &mut Command) -> Box<dyn Group> {
        Box::new(Pending)
    }
}

impl Group for Pending {
    fn bind(&self, _: &Child) -> io::Result<()> {
        Err(unsupported())
    }
    fn terminate(&self) -> io::Result<()> {
        Err(unsupported())
    }
    fn kill(&self) -> io::Result<()> {
        Err(unsupported())
    }
    fn close(&self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn current() -> &'static dyn Process {
    &Pending
}
