use std::io;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use otter_daemon_chat as chat;
use otter_daemon_chatsock as chatsock;
use otter_daemon_ipc::{ChatUser, PanedServer};
use otter_gocompat::json::RawMessage;
use otter_gocompat::oserr::go_error_string;
use otter_shared_activity as activity;
use otter_shared_chatwire as chatwire;
use otter_shared_edge::{Acceptor, Config, Listener};
use otter_shared_edgenode::{self as edgenode, Change, Node};
use otter_shared_edgerelay as edgerelay;
use otter_shared_humancmd as humancmd;
use otter_shared_otterlog::errorf;
use otter_shared_toolhub::{ActivityState, ToolManager};
use tokio::runtime::Handle;
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

pub(crate) use otter_shared_cadence::HUMANCMD_HELPER_EVERY as HELPER_EVERY;
/// 도우미 키를 비우기까지의 연속 실패 수다 (PEER_CHAT_SRS §3.12·§3.12a R-7).
pub(crate) const HELPER_DROP: u32 = 3;

type Closer = Box<dyn FnOnce() + Send>;

/// 데몬의 노드를 세우고 노드 소켓을 듣는다 (PEER_DAEMON_SRS FR-PDM-20~22, §3.5a). 노드를 세우지
/// 못해도 데몬은 뜬다 — edge 는 503 으로 답한다. 노드가 서면 간선 계층을 유지하고
/// (EDGE_MESH_SRS FR-EGM-1) 그 위에 채팅을 세운다. 돌려준 함수가 채팅·간선 연결·노드 소켓을
/// 닫는다. tokio 런타임 안에서 부른다.
pub fn start_edge(home: &Path, ps: &PanedServer, pm: &Arc<ToolManager>) -> Closer {
    let hostname = otter_shared_platform::hostname().unwrap_or_default();
    let ln: Arc<OnceLock<Listener>> = Arc::new(OnceLock::new());
    let on_config = {
        let ln = Arc::clone(&ln);
        Arc::new(move |c: &Config| {
            if let Some(l) = ln.get() {
                l.apply(c);
            }
        })
    };
    let port_ps = ps.clone();
    let notify_ps = ps.clone();
    let opts = edgenode::Options {
        home: home.to_path_buf(),
        hostname,
        dial: Some(edgerelay::dialer(edgerelay::dial_socket_path(home))),
        port_status: Some(Arc::new(move || port_ps.edge_port())),
        on_config: Some(on_config),
        notify: Some(Arc::new(move |c: Change| notify_ps.push_edges(&c))),
        mesh: true,
        now: None,
    };
    let n = match Node::new(opts) {
        Ok(n) => n,
        Err(e) => {
            errorf!(None, "edge identity: {e} — 노드 기능 없이 뜬다");
            return Box::new(|| {});
        }
    };
    let stop_chat = start_chat(home, &n, Arc::new(ChatTools::new(pm)), ps);
    let cancel = CancellationToken::new();
    {
        let n = Arc::clone(&n);
        let cancel = cancel.clone();
        tokio::spawn(async move { n.run(cancel).await });
    }
    match Listener::new(n.identity(), n.admission(), n.handler()) {
        Ok(l) => {
            let node_sock = edgerelay::node_socket_path(home);
            l.use_listen(Box::new(move |_: &str, _: i64| {
                edgerelay::listen_node(&node_sock).map(|a| Box::new(a) as Box<dyn Acceptor>)
            }));
            let l = ln.get_or_init(|| l);
            l.apply(&n.config());
        }
        Err(e) => errorf!(None, "edge listener: {e}"),
    }
    ps.set_edge(Some(Arc::clone(&n)));
    Box::new(move || {
        stop_chat();
        cancel.cancel();
        n.close();
        if let Some(l) = ln.get() {
            l.close();
        }
    })
}

/// 채팅 소켓 서버를 사람 참가자 자리([`ChatUser`])에 건다.
struct ChatUserOf(Arc<chatsock::Server>);

impl ChatUser for ChatUserOf {
    fn user_call(&self, op: &str, args: &RawMessage) -> Result<RawMessage, chatwire::Error> {
        self.0.user_call(op, args)
    }
}

/// 채팅을 간선 계층의 위층으로 세운다 (EDGE_MESH_SRS FR-EGM-40). 채팅 소켓을 열어 MCP 연결을
/// 참가자로 받는다 (PEER_CHAT_SRS §3.10). 소켓을 열지 못하면 MCP 를 주입하지 않을 뿐 채팅은 그대로
/// 선다. 사람 참가자를 세워 서버에 잇는다 (§3.11).
fn start_chat(
    home: &Path,
    n: &Arc<Node>,
    tools: Arc<dyn chatsock::Tools>,
    ps: &PanedServer,
) -> Closer {
    let sock: Arc<OnceLock<Arc<chatsock::Server>>> = Arc::new(OnceLock::new());
    let mut o = chat::Options::new(n.identity().clone());
    o.mesh = n.mesh().cloned();
    {
        let n = Arc::clone(n);
        o.edges = Some(Arc::new(move || n.config().edges));
    }
    {
        let sock = Arc::clone(&sock);
        o.deliver = Some(Arc::new(move |pid: &str, m: chat::Message| {
            if let Some(cs) = sock.get() {
                cs.deliver(pid, m);
            }
        }));
    }
    {
        let ps = ps.clone();
        o.changed = Some(Arc::new(move || ps.push_chat_changed()));
    }
    {
        let n = Arc::clone(n);
        o.pin = Some(Arc::new(move |fp: &str, key: &str| {
            if let Err(e) = n.store().pin_helper(fp, key) {
                errorf!(None, "chat: 도우미 키 고정: {e}");
            }
        }));
    }
    let s = chat::Service::new(o);

    let helper = humancmd::Client {
        path: humancmd::SOCKET_PATH.into(),
        timeout: Duration::ZERO,
    };
    let mut co = chatsock::Options::new(Arc::clone(&s));
    co.tools = Some(tools);
    {
        let n = Arc::clone(n);
        co.name = Some(Arc::new(move || n.config().name));
    }
    {
        let ps = ps.clone();
        co.on_user = Some(Arc::new(move |m: chatwire::Message| ps.push_chat_msg(m)));
    }
    co.helper = Some(Arc::new(helper.clone()));
    let cs = chatsock::Server::new(co);
    cs.start_user();
    ps.set_chat(Some(Arc::new(ChatUserOf(Arc::clone(&cs)))));
    match cs.listen(&chatwire::socket_path(home)) {
        Err(e) => errorf!(None, "채팅 소켓: {}", go_error_string(&e)),
        Ok(()) => {
            let _ = sock.set(Arc::clone(&cs));
            let serve = Arc::clone(&cs);
            std::thread::spawn(move || serve.serve());
        }
    }
    let cancel = CancellationToken::new();
    tokio::spawn(watch_helper(cancel.clone(), helper, Arc::clone(&s)));
    Box::new(move || {
        cancel.cancel();
        cs.close();
        s.close();
    })
}

/// 시작할 때와 그 뒤 [`HELPER_EVERY`] 마다 도우미의 공개키를 물어 채팅에 싣는다. 도우미가 없거나
/// 닿지 않는 것이 [`HELPER_DROP`] 번 이어지면 키를 비운다 — 화면은 사람 명령 메뉴를 숨긴다
/// (FR-PCH-78).
async fn watch_helper(cancel: CancellationToken, h: humancmd::Client, s: Arc<chat::Service>) {
    let mut t = tokio::time::interval_at(Instant::now() + HELPER_EVERY, HELPER_EVERY);
    t.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut w = HelperWatch::default();
    loop {
        let hc = h.clone();
        let info = tokio::task::spawn_blocking(move || hc.info()).await;
        let (key, ok) = match info {
            Ok(Ok(i)) => (i.key, true),
            _ => (String::new(), false),
        };
        if let Some(key) = w.next(&key, ok) {
            let s = Arc::clone(&s);
            let _ = tokio::task::spawn_blocking(move || s.set_helper(&key)).await;
        }
        tokio::select! {
            () = cancel.cancelled() => return,
            _ = t.tick() => {}
        }
    }
}

/// 도우미 확인의 연속 실패 수다.
#[derive(Default)]
pub(crate) struct HelperWatch {
    fails: u32,
}

impl HelperWatch {
    /// 확인 한 번의 결과(ok 는 오류가 없었는가)로 실을 키를 정한다. None 이면 싣지 않는다. 얻으면
    /// 바로 싣고, 비우는 것은 연속 [`HELPER_DROP`] 번 실패한 뒤다. 한 번의 시한 초과가 사람
    /// 명령과 엇갈려 키를 비우지 않게 한다.
    pub(crate) fn next(&mut self, key: &str, ok: bool) -> Option<String> {
        if ok && !key.is_empty() {
            self.fails = 0;
            return Some(key.to_owned());
        }
        self.fails += 1;
        (self.fails >= HELPER_DROP).then(String::new)
    }
}

/// 채팅 소켓이 쓰는 도구 계층이다.
pub(crate) struct ChatTools {
    pm: Arc<ToolManager>,
    rt: Handle,
}

impl ChatTools {
    /// tokio 런타임 안에서 만든다(붙여넣기가 async 다).
    pub(crate) fn new(pm: &Arc<ToolManager>) -> Self {
        Self {
            pm: Arc::clone(pm),
            rt: Handle::current(),
        }
    }
}

impl chatsock::Tools for ChatTools {
    fn resting(&self, tool_id: &str) -> bool {
        self.pm
            .get(tool_id)
            .is_some_and(|p| resting(p.activity().as_ref()))
    }

    /// 채팅 소켓의 스레드(런타임 밖)에서 불린다.
    fn paste(&self, tool_id: &str, text: &str) -> Result<(), chatsock::BoxError> {
        self.rt
            .block_on(self.pm.send_paste(tool_id, text.as_bytes(), true))
            .map_err(|e| io::Error::other(go_error_string(&e)).into())
    }
}

/// 쉬는 중(idle·done)인가다. 보고가 없으면 쉬는 중이 아니다 (FR-PCH-61).
pub(crate) fn resting(a: Option<&ActivityState>) -> bool {
    a.is_some_and(|a| a.state == activity::IDLE || a.state == activity::DONE)
}
