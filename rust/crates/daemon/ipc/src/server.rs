//! paned 소켓 서버 — 서버(dongminal) 연결 하나를 받고, 도구의 출력·종료·전경·크기·알람을 그 연결로 민다.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use dm_gocompat::json::RawMessage;
use dm_gocompat::{filepath, oserr};
use dm_shared_chatwire as chatwire;
use dm_shared_dmlog::errorf;
use dm_shared_edge::Status as EdgeStatus;
use dm_shared_edgenode::{Change, Node};
use dm_shared_platform::IpcListener;
use dm_shared_toolhub::{Tool, ToolManager};
use dm_shared_toolipc::{self as ipc, AttnEvent, ChatEvent, EdgeRef, EdgesEvent};
use tokio::runtime::Handle;

use crate::conn::{Conn, lock};
use crate::records::GlobalRecords;

/// 소켓에 살아 있는 데몬이 있는지 알아보는 dial 의 상한이다.
pub const DIAL_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// pid·지문 파일의 권한이다.
#[cfg(unix)]
const STATE_FILE_MODE: u32 = 0o600;
/// edge 한 번의 상한이다. 상대 호출(15초)과 연결·핸드셰이크를 넘긴다 (Go `edgeCallTimeout`).
pub const EDGE_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// 채팅의 사람 참가자 쪽이다 (PEER_CHAT_SRS §3.11).
pub trait ChatUser: Send + Sync {
    fn user_call(&self, op: &str, args: &RawMessage) -> Result<RawMessage, chatwire::Error>;
}

/// 세션 유지 교체다. 성공하면 응답을 쓴 뒤 부를 commit 을 돌려준다. 실패 문구는 응답의 error 다.
pub type Reloader = Arc<
    dyn Fn(dm_shared_handover::ReloadRequest) -> Result<Box<dyn FnOnce() + Send>, String>
        + Send
        + Sync,
>;

pub(crate) struct Listeners {
    pub paned: Option<Arc<IpcListener>>,
    pub report: Option<Arc<IpcListener>>,
    pub report_path: PathBuf,
}

pub(crate) struct Inner {
    pub pm: Arc<ToolManager>,
    pub rt: Handle,
    pub sock_path: PathBuf,
    pid_path: PathBuf,
    build: Mutex<(String, PathBuf, String)>,
    pub curr: Mutex<Option<Arc<Conn>>>,
    pub listeners: Mutex<Listeners>,
    pub closed: AtomicBool,
    pub records: GlobalRecords,
    pub report_mu: Mutex<()>,
    edge_node: Mutex<Option<Arc<Node>>>,
    edge_port: Mutex<EdgeStatus>,
    edge_call_timeout: Mutex<Duration>,
    chat: Mutex<Option<Arc<dyn ChatUser>>>,
    pub reloader: Mutex<Option<Reloader>>,
}

/// 데몬의 paned 소켓 서버다. 한 번에 서버 연결 하나만 이어 쓴다(새 연결이 옛것을 대신한다).
#[derive(Clone)]
pub struct PanedServer {
    pub(crate) inner: Arc<Inner>,
}

fn write_state_file(path: &Path, body: &str) -> io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, STATE_FILE_MODE);
    io::Write::write_all(&mut o.open(path)?, body.as_bytes())
}

/// 소켓이 사는 자리의 권한 (04-secops P1-6).
const SOCK_DIR_PERM: u32 = 0o700;

/// Go `os.MkdirAll(filepath.Dir(sock), 0o700)`.
pub(crate) fn mkdir_sock_dir(sock: &Path) -> io::Result<()> {
    oserr::mkdir_all(&filepath::dir(&sock.to_string_lossy()), SOCK_DIR_PERM)
}

impl PanedServer {
    /// tokio 런타임 안에서 부른다 — 느린 요청과 async 연산이 그 런타임에서 돈다.
    pub fn new(pm: Arc<ToolManager>, sock_path: &Path, pid_path: Option<&Path>) -> Self {
        let inner = Arc::new(Inner {
            pm: Arc::clone(&pm),
            rt: Handle::current(),
            sock_path: sock_path.to_path_buf(),
            pid_path: pid_path.map(Path::to_path_buf).unwrap_or_default(),
            build: Mutex::default(),
            curr: Mutex::new(None),
            listeners: Mutex::new(Listeners {
                paned: None,
                report: None,
                report_path: PathBuf::new(),
            }),
            closed: AtomicBool::new(false),
            records: GlobalRecords::default(),
            report_mu: Mutex::new(()),
            edge_node: Mutex::new(None),
            edge_port: Mutex::default(),
            edge_call_timeout: Mutex::new(EDGE_CALL_TIMEOUT),
            chat: Mutex::new(None),
            reloader: Mutex::new(None),
        });
        let w = Arc::downgrade(&inner);
        pm.set_foreground_notifier(Some(Arc::new(move |id: &str, name: &str| {
            if let Some(c) = curr_of(&w) {
                c.enqueue(
                    &ipc::ForegroundEvent {
                        event: ipc::EVENT_FOREGROUND.into(),
                        name: name.into(),
                        tool: id.into(),
                    },
                    false,
                );
            }
        })));
        let w = Arc::downgrade(&inner);
        pm.set_resize_notifier(Some(Arc::new(move |id: &str, cols, rows| {
            if let Some(c) = curr_of(&w) {
                c.enqueue(
                    &ipc::SizeEvent {
                        cols,
                        event: ipc::EVENT_SIZE.into(),
                        rows,
                        tool: id.into(),
                    },
                    false,
                );
            }
        })));
        let (w1, w2, w3) = (
            Arc::downgrade(&inner),
            Arc::downgrade(&inner),
            Arc::downgrade(&inner),
        );
        pm.set_attention_notifier(
            Some(Arc::new(move |id: &str, reason: &str| {
                push_attn(&w1, id, ipc::ATTN_KIND_ATTENTION, reason);
            })),
            Some(Arc::new(move |id: &str| {
                push_attn(&w2, id, ipc::ATTN_KIND_CLEAR, "");
            })),
        );
        pm.set_activity_notifier(Some(Arc::new(
            move |id: &str, _: &str, _: &str, _: &str| {
                push_attn(&w3, id, ipc::ATTN_KIND_ACTIVITY, "");
            },
        )));
        Self { inner }
    }

    pub fn set_build_version(&self, v: &str) {
        lock(&self.inner.build).0 = v.to_owned();
    }

    /// 지문 파일 경로와 지문이다 (DAEMON_STALENESS_SRS FR-DFP-4). 지문이 비면 파일을 지운다.
    pub fn set_daemon_build(&self, path: &Path, fp: &str) {
        let mut b = lock(&self.inner.build);
        b.1 = path.to_path_buf();
        b.2 = fp.to_owned();
    }

    /// 소켓을 연다. 살아 있는 데몬이 이미 받고 있으면 오류다.
    pub fn listen(&self) -> io::Result<()> {
        let ipc_t = &dm_shared_platform::current().ipc;
        let sock = &self.inner.sock_path;
        if ipc_t.dial(sock, DIAL_PROBE_TIMEOUT).is_ok() {
            return Err(io::Error::other(format!(
                "paned: {} already served by a live daemon",
                sock.display()
            )));
        }
        let _ = ipc_t.remove(sock);
        mkdir_sock_dir(sock)?;
        let ln = ipc_t.listen(sock)?;
        lock(&self.inner.listeners).paned = Some(Arc::new(ln));
        self.after_listen();
        Ok(())
    }

    fn after_listen(&self) {
        let pid = &self.inner.pid_path;
        if !pid.as_os_str().is_empty()
            && let Err(e) = write_state_file(pid, &format!("{}\n", std::process::id()))
        {
            errorf!(None, "paned: pidfile 쓰기 실패 {}: {e}", pid.display());
        }
        self.record_daemon_build();
    }

    fn record_daemon_build(&self) {
        let (path, fp) = {
            let b = lock(&self.inner.build);
            (b.1.clone(), b.2.clone())
        };
        if path.as_os_str().is_empty() {
            return;
        }
        if fp.is_empty() {
            if let Err(e) = std::fs::remove_file(&path)
                && e.kind() != io::ErrorKind::NotFound
            {
                errorf!(None, "paned: 지문 파일 제거 실패 {}: {e}", path.display());
            }
            return;
        }
        if let Err(e) = write_state_file(&path, &format!("{fp}\n")) {
            errorf!(None, "paned: 지문 쓰기 실패 {}: {e}", path.display());
        }
    }

    /// 연결 하나를 받아 끝날 때까지 처리한다(블로킹). 새 연결이 지금 연결을 대신한다.
    pub fn accept(&self) -> io::Result<()> {
        let ln = lock(&self.inner.listeners)
            .paned
            .clone()
            .ok_or_else(|| io::Error::other("paned: not listening"))?;
        let stream = ln.accept()?;
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(io::Error::other("paned: closed"));
        }
        let c = {
            let mut curr = lock(&self.inner.curr);
            let build = lock(&self.inner.build).0.clone();
            let c = Conn::new(
                stream,
                Arc::clone(&self.inner.pm),
                self.inner.rt.clone(),
                build,
                Arc::downgrade(&self.inner),
            );
            for p in self.inner.pm.snapshot() {
                self.inner.wire_tool(&p);
            }
            *curr = Some(Arc::clone(&c));
            c
        };
        c.handle()
    }

    /// 연결·소켓·보고 소켓을 닫고 pid 파일을 지운다. 막혀 있는 accept 는 자기 접속으로 깨운다.
    pub fn close(&self) {
        let ipc_t = &dm_shared_platform::current().ipc;
        self.inner.closed.store(true, Ordering::SeqCst);
        if let Some(c) = lock(&self.inner.curr).take() {
            c.stop();
        }
        let (paned, report, report_path) = {
            let mut l = lock(&self.inner.listeners);
            (l.paned.take(), l.report.take(), l.report_path.clone())
        };
        if paned.is_some() {
            let _ = ipc_t.dial(&self.inner.sock_path, DIAL_PROBE_TIMEOUT);
        }
        drop(paned);
        let _ = ipc_t.remove(&self.inner.sock_path);
        if report.is_some() {
            let _ = ipc_t.dial(&report_path, DIAL_PROBE_TIMEOUT);
            drop(report);
            let _ = ipc_t.remove(&report_path);
        }
        if !self.inner.pid_path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.inner.pid_path);
        }
    }

    pub fn set_edge(&self, n: Option<Arc<Node>>) {
        *lock(&self.inner.edge_node) = n;
    }

    /// 서버가 알린 노드 포트의 상태다 (FR-PDM-14).
    pub fn edge_port(&self) -> EdgeStatus {
        lock(&self.inner.edge_port).clone()
    }

    /// 간선 바뀜을 서버에 민다 (FR-PDM-27). 서버가 edge 를 말하지 않았으면 버린다.
    pub fn push_edges(&self, ch: &Change) {
        let Some(c) = curr_of(&Arc::downgrade(&self.inner)) else {
            return;
        };
        if !c.edge.load(Ordering::SeqCst) {
            return;
        }
        let r = |x: &Option<dm_shared_edgenode::Ref>| {
            x.as_ref().map(|r| EdgeRef {
                fp: r.fp.clone(),
                name: r.name.clone(),
            })
        };
        c.enqueue(
            &EdgesEvent {
                event: ipc::EVENT_EDGES.into(),
                paired: r(&ch.paired),
                removed: r(&ch.removed),
                by_peer: ch.by_peer,
                invited: r(&ch.invited),
            },
            false,
        );
    }

    pub fn set_chat(&self, u: Option<Arc<dyn ChatUser>>) {
        *lock(&self.inner.chat) = u;
    }

    pub fn push_chat_msg(&self, m: chatwire::Message) {
        self.push_chat(ChatEvent {
            chat: Some(m),
            chat_kind: ipc::CHAT_KIND_MSG.into(),
            event: ipc::EVENT_CHAT.into(),
        });
    }

    pub fn push_chat_changed(&self) {
        self.push_chat(ChatEvent {
            chat: None,
            chat_kind: ipc::CHAT_KIND_CHANGED.into(),
            event: ipc::EVENT_CHAT.into(),
        });
    }

    fn push_chat(&self, ev: ChatEvent) {
        if let Some(c) = curr_of(&Arc::downgrade(&self.inner))
            && c.chat.load(Ordering::SeqCst)
        {
            c.enqueue(&ev, false);
        }
    }

    pub fn set_reloader(&self, r: Option<Reloader>) {
        *lock(&self.inner.reloader) = r;
    }

    /// 데몬 교체가 새 이미지에 넘길 리스너 fd 복제다 (paned, report).
    #[cfg(unix)]
    pub fn listener_fds(&self) -> io::Result<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)> {
        let l = lock(&self.inner.listeners);
        match (&l.paned, &l.report) {
            (Some(p), Some(r)) => Ok((p.try_clone_fd()?, r.try_clone_fd()?)),
            _ => Err(io::Error::other("리스너를 fd 로 꺼낼 수 없다")),
        }
    }

    /// 넘겨받은 리스너로 연다 (데몬 교체 뒤).
    pub fn listen_inherited(&self, paned: IpcListener, report: IpcListener, report_path: &Path) {
        {
            let mut l = lock(&self.inner.listeners);
            l.paned = Some(Arc::new(paned));
            l.report = Some(Arc::new(report));
            l.report_path = report_path.to_path_buf();
        }
        self.after_listen();
    }

    pub fn export_global(&self) -> BTreeMap<String, RawMessage> {
        self.inner.records.snapshot()
    }

    pub fn import_global(&self, m: &BTreeMap<String, RawMessage>) {
        for (k, v) in m {
            self.inner.records.set(k, v);
        }
    }
}

pub(crate) fn curr_of(w: &Weak<Inner>) -> Option<Arc<Conn>> {
    w.upgrade().and_then(|s| lock(&s.curr).clone())
}

fn push_attn(w: &Weak<Inner>, id: &str, kind: &str, reason: &str) {
    let Some(s) = w.upgrade() else { return };
    let Some(c) = lock(&s.curr).clone() else {
        return;
    };
    if !c.attention.load(Ordering::SeqCst) {
        return;
    }
    let Some(p) = s.pm.get(id) else { return };
    c.enqueue(
        &AttnEvent {
            event: ipc::EVENT_ATTN.into(),
            tool: id.into(),
            kind: kind.into(),
            reason: reason.into(),
            agent: p.agent_state(),
        },
        false,
    );
}

impl Inner {
    /// 도구의 출력·종료를 지금 연결로 중계한다(도구마다 한 번).
    pub fn wire_tool(self: &Arc<Self>, p: &Arc<Tool>) {
        let (w1, w2) = (Arc::downgrade(self), Arc::downgrade(self));
        let tool = Arc::downgrade(p);
        p.wire_relay_once(move |base_exit| {
            let on_output: dm_shared_toolhub::OutputFn =
                Arc::new(move |id: &str, data: &[u8], end: i64| {
                    if let Some(c) = curr_of(&w1) {
                        c.enqueue(
                            &ipc::OutputEvent {
                                data: data.to_vec(),
                                end,
                                event: ipc::EVENT_OUTPUT.into(),
                                tool: id.into(),
                            },
                            true,
                        );
                    }
                });
            let on_exit: dm_shared_toolhub::ExitFn = Arc::new(move |id: &str| {
                if let Some(c) = curr_of(&w2) {
                    let code = tool.upgrade().map_or(0, |t| t.exit_info().code);
                    c.enqueue(
                        &ipc::ExitEvent {
                            code,
                            event: ipc::EVENT_EXIT.into(),
                            tool: id.into(),
                        },
                        false,
                    );
                }
                if let Some(b) = &base_exit {
                    b(id);
                }
            });
            (Some(on_output), Some(on_exit))
        });
    }

    pub fn edge_node(&self) -> Option<Arc<Node>> {
        lock(&self.edge_node).clone()
    }

    pub(crate) fn edge_call_timeout(&self) -> Duration {
        *lock(&self.edge_call_timeout)
    }

    #[cfg(test)]
    pub(crate) fn set_edge_call_timeout(&self, d: Duration) {
        *lock(&self.edge_call_timeout) = d;
    }

    pub fn set_edge_port(&self, listening: bool, addr: String, err: String) {
        *lock(&self.edge_port) = EdgeStatus {
            listening,
            addr,
            err,
            ..EdgeStatus::default()
        };
    }

    pub fn chat_user(&self) -> Option<Arc<dyn ChatUser>> {
        lock(&self.chat).clone()
    }
}
