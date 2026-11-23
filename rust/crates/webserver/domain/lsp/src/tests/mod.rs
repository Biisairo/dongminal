//! Go `lsp` 시험을 옮긴 것. 언어 서버 대신 파이프 한 쌍을 쓴다.

mod codec;
mod tunnel;
mod watch;

use std::collections::HashMap;
use std::io::{BufReader, PipeReader, PipeWriter};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dm_gocompat::filepath;
use dm_webserver_domain_ext as ext;

use crate::process::{Conn, Starter};
use crate::service::Service;

pub(crate) const GO_PACK: &str = r#"{
  "id":"gopls","kind":"server","version":"v0",
  "source":{"kind":"toolchain","tool":"go","args":["install","x@v1"],"bin":"bin"},
  "servers":[{"id":"gopls","langs":["go"],"exts":[".go"],"exe":"gopls"}]
}"#;

pub(crate) const TS_PACK: &str = r#"{
  "id":"typescript","kind":"server","version":"v0",
  "source":{"kind":"toolchain","tool":"go","args":["install","x@v1"],"bin":"bin"},
  "servers":[{"id":"typescript-language-server",
    "langs":["typescript","javascript"],
    "exts":[".ts",".tsx",".mts",".cts",".js",".jsx",".mjs",".cjs"],
    "exe":"typescript-language-server","args":["--stdio"]}]
}"#;

pub(crate) const WAIT: Duration = Duration::from_secs(2);

pub(crate) fn tmp() -> (tempfile::TempDir, String) {
    let d = tempfile::tempdir().unwrap();
    let p = filepath::eval_symlinks(&d.path().to_string_lossy()).unwrap();
    (d, p)
}

pub(crate) fn map_look(on_path: &[(&str, &str)]) -> ext::LookPath {
    let m: HashMap<String, String> = on_path
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    Arc::new(move |n| m.get(n).cloned())
}

/// 가짜 서버 쪽 끝. `input` 은 서버의 stdin, `out` 은 서버의 stdout 이다.
pub(crate) struct PipeEnd {
    pub input: BufReader<PipeReader>,
    pub out: Arc<Mutex<Option<PipeWriter>>>,
    pub stopped: Receiver<()>,
}

impl PipeEnd {
    pub(crate) fn write_frame(&self, body: &[u8]) {
        if let Some(w) = self.out.lock().unwrap().as_mut() {
            let _ = crate::codec::write_frame(w, body);
        }
    }

    pub(crate) fn close_out(&self) {
        self.out.lock().unwrap().take();
    }

    pub(crate) fn wait_stopped(&self, why: &str) {
        self.stopped.recv_timeout(WAIT).expect(why);
    }
}

pub(crate) type Count = Arc<Mutex<usize>>;

/// 띄울 때마다 파이프 한 쌍을 만들어 그 끝을 ends 로 보낸다. 띄운 횟수를 센다.
pub(crate) fn pipe_starter() -> (Starter, Receiver<PipeEnd>, Count) {
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    let n: Count = Arc::new(Mutex::new(0));
    let count = Arc::clone(&n);
    let start: Starter = Arc::new(move |_, _, _| {
        *count.lock().unwrap() += 1;
        let (cr, sw) = std::io::pipe()?;
        let (sr, cw) = std::io::pipe()?;
        let out = Arc::new(Mutex::new(Some(sw)));
        let (stx, srx) = channel();
        let out2 = Arc::clone(&out);
        let stop = move || {
            out2.lock().unwrap().take();
            let _ = stx.send(());
        };
        let end = PipeEnd {
            input: BufReader::new(sr),
            out,
            stopped: srx,
        };
        tx.lock().unwrap().send(end).unwrap();
        Ok(Conn {
            reader: Box::new(cr),
            writer: Box::new(cw),
            stop: Box::new(stop),
        })
    });
    (start, rx, n)
}

pub(crate) fn next_end(ends: &Receiver<PipeEnd>) -> PipeEnd {
    ends.recv_timeout(WAIT).expect("프로세스가 서지 않았다")
}

/// gopls·typescript 선언을 둔 ext 위의 lsp 서비스.
pub(crate) fn svc_with(
    start: Option<Starter>,
    on_path: &[(&str, &str)],
) -> (tempfile::TempDir, Service) {
    let (d, root) = tmp();
    for (id, decl) in [("gopls", GO_PACK), ("typescript", TS_PACK)] {
        let dir = ext::plugin_dir(&root, id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(filepath::join(&[dir.as_str(), ext::MANIFEST_NAME]), decl).unwrap();
    }
    let e = ext::Service::with(
        &root,
        map_look(on_path),
        Arc::new(ext::HttpFetch),
        Arc::new(ext::HostExec),
    );
    let mut svc = Service::new(Some(Arc::new(e)));
    svc.start = start;
    (d, svc)
}

pub(crate) fn go_tunnel_svc(start: Starter) -> (tempfile::TempDir, Service) {
    svc_with(Some(start), &[("gopls", "/fake/gopls")])
}
