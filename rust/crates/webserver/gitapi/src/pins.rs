//! 핀 목록 (Go `git_pins.go`). 목록의 소유자는 wsentry 다 — 이 파일은 그 위의 얇은 접근이다.

use otter_webserver_domain_wsentry::{self as wsentry, Store};

use crate::GitServer;

impl GitServer {
    /// 핀·Editor 목록의 소유자다. 연동(FR-EDT-31·32)은 그쪽이 진다.
    pub(crate) fn entries(&self) -> Store {
        let mut st = Store::default();
        st.work = self.work.clone();
        st.commands = self.commands.clone();
        st
    }

    pub(crate) fn git_pins_read(&self) -> Result<Vec<String>, wsentry::Error> {
        Ok(self.entries().read()?.pinned)
    }
}
