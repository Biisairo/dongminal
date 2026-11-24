//! 프로세스 없는 가짜 터미널이다. 시험이 도구의 출력·종료를 넣고, 도구에 쓰인 바이트와 크기를 본다.

use std::collections::HashMap;
use std::io;
use std::process::ExitStatus;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use dm_shared_outbuf::Stream;
use dm_shared_platform::{Handover, Terminal};
use dm_shared_toolhub::{BUF_MAX, StartReq, Tool, ToolManager};

use crate::conn::lock;

/// 쓰기 직전에 불린다(도구 id, 쓰는 바이트). 돌아올 때까지 쓰기가 멈춘다.
pub(super) type Hold = Arc<dyn Fn(&str, &[u8]) + Send + Sync>;

pub(super) struct Fake {
    id: String,
    feed_tx: Mutex<Sender<Option<Vec<u8>>>>,
    feed_rx: Mutex<Receiver<Option<Vec<u8>>>>,
    writes: Mutex<Vec<u8>>,
    size: Mutex<(u16, u16)>,
    hold: Option<Hold>,
}

impl Fake {
    /// 셸이 낸 출력처럼 읽기 스레드에 준다.
    pub fn feed(&self, b: &[u8]) {
        let _ = lock(&self.feed_tx).send(Some(b.to_vec()));
    }

    /// 셸이 끝난 것처럼 읽기가 끝(EOF)을 보게 한다.
    pub fn end(&self) {
        let _ = lock(&self.feed_tx).send(None);
    }

    pub fn written(&self) -> Vec<u8> {
        lock(&self.writes).clone()
    }
}

struct Term(Arc<Fake>);

impl Terminal for Term {
    fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        match lock(&self.0.feed_rx).recv() {
            Ok(Some(b)) => {
                let n = b.len().min(buf.len());
                buf[..n].copy_from_slice(&b[..n]);
                Ok(n)
            }
            _ => Ok(0),
        }
    }

    fn write(&self, buf: &[u8]) -> io::Result<usize> {
        if let Some(h) = &self.0.hold {
            h(&self.0.id, buf);
        }
        lock(&self.0.writes).extend_from_slice(buf);
        Ok(buf.len())
    }

    fn close(&self) -> io::Result<()> {
        self.0.end();
        Ok(())
    }

    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        *lock(&self.0.size) = (cols, rows);
        Ok(())
    }

    fn size(&self) -> io::Result<(u16, u16)> {
        Ok(*lock(&self.0.size))
    }

    fn foreground_pgid(&self) -> Option<i32> {
        None
    }

    fn pid(&self) -> i32 {
        0
    }

    fn wait(&self) -> io::Result<ExitStatus> {
        Err(io::Error::other("가짜 터미널"))
    }

    fn terminate(&self) -> io::Result<()> {
        Ok(())
    }

    fn kill(&self) -> io::Result<()> {
        Ok(())
    }

    fn handover(&self) -> Option<&dyn Handover> {
        None
    }
}

pub(super) type Fakes = Arc<Mutex<HashMap<String, Arc<Fake>>>>;

/// pm 이 띄우는 도구를 가짜 터미널 위에 세운다. 돌려준 표에서 id 로 가짜를 찾는다.
pub(super) fn fake_start(pm: &ToolManager, hold: Option<Hold>) -> Fakes {
    let reg: Fakes = Arc::default();
    let r = Arc::clone(&reg);
    pm.set_start(Arc::new(move |q: StartReq<'_>| {
        let (tx, rx) = mpsc::channel();
        let f = Arc::new(Fake {
            id: q.id.to_owned(),
            feed_tx: Mutex::new(tx),
            feed_rx: Mutex::new(rx),
            writes: Mutex::default(),
            size: Mutex::new((q.cols, q.rows)),
            hold: hold.clone(),
        });
        lock(&r).insert(q.id.to_owned(), Arc::clone(&f));
        let t = Tool::on_term(
            q.id,
            q.name,
            Box::new(Term(f)),
            false,
            q.on_exit,
            q.hooks,
            Stream::new(BUF_MAX),
        );
        t.spawn_reader();
        Ok(t)
    }));
    reg
}

/// ids 의 가짜 도구를 세운다.
pub(super) fn fake_tools(pm: &ToolManager, hold: Option<Hold>, ids: &[&str]) -> Fakes {
    let reg = fake_start(pm, hold);
    for id in ids {
        pm.restore(id, "R", "/tmp", 80, 24).unwrap();
    }
    reg
}

pub(super) fn get(reg: &Fakes, id: &str) -> Arc<Fake> {
    Arc::clone(&lock(reg)[id])
}
