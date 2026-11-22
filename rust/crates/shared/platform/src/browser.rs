//! 브라우저 명령 조립 (FR-XBR-1, FR-VUO-2). 실행은 호출자가 한다. 구현은 이슈 1.4.3 이 채운다.

use std::io;

/// frameless window(주소창 없는 앱 창)를 여는 명령 `(name, args)`.
pub trait Browser: Send + Sync {
    fn frameless_command(&self, url: &str) -> io::Result<(String, Vec<String>)>;
}

/// URL 을 평범한 브라우저 창/탭으로 여는 명령 `(name, args)`.
pub trait Opener: Send + Sync {
    fn open_command(&self, url: &str) -> io::Result<(String, Vec<String>)>;
}

struct Pending;

impl Browser for Pending {
    fn frameless_command(&self, _: &str) -> io::Result<(String, Vec<String>)> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

impl Opener for Pending {
    fn open_command(&self, _: &str) -> io::Result<(String, Vec<String>)> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}

pub(crate) fn current_browser() -> &'static dyn Browser {
    &Pending
}

pub(crate) fn current_opener() -> &'static dyn Opener {
    &Pending
}
