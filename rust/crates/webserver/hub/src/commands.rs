//! 워크스페이스 UI 명령을 SSE 구독자에게 방송하는 허브 (REMOTE_COMMAND_RESULT_SRS).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use futures_util::future::BoxFuture;
use otter_gocompat::json;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::{CancellationToken, WaitForCancellationFuture};

use crate::lock;

/// `*CommandHub` 를 추상한다. SSE 핸들러가 구독 수명주기를 직접 다룬다.
///
/// `observe_*` 는 알람 방송의 관찰자 자리다. Go 는 `*CommandHub` 로 타입 단언해 불렀다 —
/// 다른 구현은 아무것도 하지 않는다.
pub trait CommandBroker: Send + Sync {
    fn add(&self) -> Option<Arc<CmdSub>>;
    fn remove(&self, s: &Arc<CmdSub>);
    fn broadcast(&self, payload: &[u8]) -> usize;
    /// 생성 명령의 결과 상관 (REMOTE_COMMAND_RESULT_SRS). `(결과, 배달 수, 시한 초과)`.
    fn broadcast_and_await<'a>(
        &'a self,
        payload: &'a [u8],
        req_id: &'a str,
        timeout: Duration,
    ) -> BoxFuture<'a, (CmdResult, usize, bool)>;
    fn deliver_result(&self, req_id: &str, res: CmdResult);

    fn observe_attention(&self, _id: &str, _reason: &str) {}
    fn observe_attention_clear(&self, _id: &str) {}
    fn observe_tool_gone(&self, _id: &str) {}
    /// 방송을 함께 엿볼 함수를 단다 (채널 상태 토픽, `perf/CHANNEL_PROTOCOL.md` §10.4).
    /// 다른 구현은 아무것도 하지 않는다.
    fn set_broadcast_tap(&self, _f: Option<BroadcastTap>) {}
}

/// 방송 본문을 함께 받는 함수다.
pub type BroadcastTap = Arc<dyn Fn(&[u8]) + Send + Sync>;

/// 구독 하나다. `recv` 는 방송된 본문, `closed` 는 구독이 닫힐 때 끝난다.
pub struct CmdSub {
    tx: mpsc::Sender<Vec<u8>>,
    rx: tokio::sync::Mutex<mpsc::Receiver<Vec<u8>>>,
    done: CancellationToken,
}

impl CmdSub {
    /// 허브에 등록되지 않은 홀로 선 구독이다. 허브를 대역하는 다른 `CommandBroker` 구현이 쓴다.
    pub fn new() -> Arc<CmdSub> {
        let (tx, rx) = mpsc::channel(CMD_SUB_QUEUE);
        Arc::new(CmdSub {
            tx,
            rx: tokio::sync::Mutex::new(rx),
            done: CancellationToken::new(),
        })
    }

    /// 다음 본문이다. 구독이 닫혀도 큐에 남은 것은 받을 수 있다 — 끝은 `closed` 로 본다.
    pub async fn recv(&self) -> Option<Vec<u8>> {
        self.rx.lock().await.recv().await
    }

    /// 기다리지 않고 꺼낸다. 다른 쪽이 `recv` 중이면 `None` 이다.
    pub fn try_recv(&self) -> Option<Vec<u8>> {
        self.rx.try_lock().ok()?.try_recv().ok()
    }

    pub fn closed(&self) -> WaitForCancellationFuture<'_> {
        self.done.cancelled()
    }

    pub fn is_closed(&self) -> bool {
        self.done.is_cancelled()
    }

    /// 구독을 닫는다(중복 호출 안전).
    pub fn close(&self) {
        self.done.cancel();
    }
}

/// 새로 만든 탭의 uuid 와 서버가 붙인 toolId 다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "hub.TabRef")]
pub struct TabRef {
    pub uuid: String,
    #[serde(rename = "toolId")]
    pub tool_id: String,
}

/// 생성 명령이 만든 엔티티들이다. 브라우저가 에코하고 long-poll 로 호출자에게 간다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "hub.CmdResult")]
pub struct CmdResult {
    #[serde(rename = "newWindows")]
    pub new_windows: Option<Vec<String>>,
    #[serde(rename = "newPanes")]
    pub new_panes: Option<Vec<String>>,
    #[serde(rename = "newTabs")]
    pub new_tabs: Option<Vec<TabRef>>,
    /// FR-WGR-30 · FR-ORD-6: 새 그룹 id, 이동의 최종 위치, 실패 사유.
    #[serde(rename = "newGroups", skip_serializing_if = "json::is_empty")]
    pub new_groups: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<CmdPosition>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub error: String,
}

/// 이동한 원소가 담는 곳 안에서 선 자리다 (1부터 센다).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "hub.CmdPosition")]
pub struct CmdPosition {
    pub container: String,
    pub index: i64,
    pub count: i64,
}

#[derive(Clone, Copy, Default)]
struct CmdSpec {
    creating: bool,
    single: bool,
    awaits: bool,
}

const fn spec(creating: bool, single: bool, awaits: bool) -> CmdSpec {
    CmdSpec {
        creating,
        single,
        awaits,
    }
}

/// POST /api/commands 가 받는 action 전부다 (FR-OPT-9-5, FR-M11-10, FR-SXE-1, FR-VUO-16, FR-ORD-6).
/// 이름순이다.
const CMD_ACTIONS: &[(&str, CmdSpec)] = &[
    ("closeTab", spec(false, true, false)),
    ("closeWindow", spec(false, true, false)),
    ("deleteGroup", spec(false, false, false)),
    ("detachTab", spec(false, true, false)),
    ("focus", spec(false, true, false)),
    ("moveGroup", spec(false, true, true)),
    ("moveTab", spec(false, true, true)),
    ("moveWindow", spec(false, true, true)),
    ("newGroup", spec(true, true, false)),
    ("newTab", spec(true, true, false)),
    ("newWindow", spec(true, true, false)),
    ("openEditorTab", spec(false, true, false)),
    ("openUrl", spec(false, true, false)),
    ("paneDown", spec(false, true, false)),
    ("paneLeft", spec(false, true, false)),
    ("paneRight", spec(false, true, false)),
    ("paneUp", spec(false, true, false)),
    ("renameGroup", spec(false, false, false)),
    ("renameTab", spec(false, false, false)),
    ("renameWindow", spec(false, false, false)),
    ("restoreTool", spec(false, true, false)),
    ("splitH", spec(true, true, false)),
    ("splitV", spec(true, true, false)),
    ("tabNext", spec(false, true, false)),
    ("tabPrev", spec(false, true, false)),
    ("windowNext", spec(false, true, false)),
    ("windowPrev", spec(false, true, false)),
];

fn spec_of(action: &str) -> Option<CmdSpec> {
    CMD_ACTIONS
        .binary_search_by(|(a, _)| (*a).cmp(action))
        .ok()
        .map(|i| CMD_ACTIONS[i].1)
}

/// POST /api/commands 가 받는 action 인가.
pub fn is_allowed_cmd_action(action: &str) -> bool {
    spec_of(action).is_some()
}

/// 허용된 action 이름의 정렬된 사본이다.
pub fn allowed_cmd_action_names() -> Vec<String> {
    CMD_ACTIONS.iter().map(|(a, _)| (*a).to_owned()).collect()
}

/// 새 엔티티를 만드는 action 인가 (FR-RCR-1).
pub fn is_creating_action(action: &str) -> bool {
    spec_of(action).is_some_and(|s| s.creating)
}

/// 호출자가 브라우저의 에코를 기다리는가: 생성 명령과 결과를 돌려받는 명령 (FR-ORD-6).
pub fn awaits_result(action: &str) -> bool {
    spec_of(action).is_some_and(|s| s.creating || s.awaits)
}

/// 정확히 한 클라이언트만 수행하는 action 인가.
pub fn is_single_executor_action(action: &str) -> bool {
    spec_of(action).is_some_and(|s| s.single)
}

const DEFAULT_COMMAND_RESULT_TIMEOUT: Duration = Duration::from_secs(3);

/// long-poll 시한이다. 환경 변수로 바꿀 수 있다 (NFR-RCR-1).
pub fn command_result_timeout() -> Duration {
    otter_shared_otterenv::millis_env(
        otter_shared_otterenv::ENV_CMD_RESULT_TIMEOUT_MS,
        DEFAULT_COMMAND_RESULT_TIMEOUT,
        1,
    )
}

/// 1회성 상관 키다 (FR-UNI-14: 정규 uuid).
pub fn new_req_id() -> String {
    otter_shared_uuid::new_string()
}

/// 구독당 미수신 본문 버퍼 크기다. 넘치면 그 구독을 닫는다 (FR-OPT-8-1, IPC-12).
pub const CMD_SUB_QUEUE: usize = otter_shared_toolhub::TOOL_CAP;

/// 동시에 붙는 SSE 구독 수의 상한이다 (04-secops P1-4).
pub const SUB_CAP: usize = 64;

type StrObs = Arc<dyn Fn(&str) + Send + Sync>;
type AttnObs = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// 워크스페이스 UI 명령을 SSE 구독자에게 방송한다.
#[derive(Default)]
pub struct CommandHub {
    // 키는 구독의 주소다 — 허브가 Arc 를 쥐는 동안 겹치지 않는다.
    subs: Mutex<HashMap<usize, Arc<CmdSub>>>,
    pending: Mutex<HashMap<String, oneshot::Sender<CmdResult>>>,
    attn_obs: RwLock<Option<AttnObs>>,
    attn_clear_obs: RwLock<Option<StrObs>>,
    gone_obs: RwLock<Option<StrObs>>,
    tap: RwLock<Option<BroadcastTap>>,
}

fn sub_key(s: &Arc<CmdSub>) -> usize {
    Arc::as_ptr(s) as usize
}

fn read<T: Clone>(l: &RwLock<Option<T>>) -> Option<T> {
    l.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn write<T>(l: &RwLock<Option<T>>, v: Option<T>) {
    *l.write().unwrap_or_else(|e| e.into_inner()) = v;
}

impl CommandHub {
    pub fn new() -> Arc<CommandHub> {
        Arc::new(CommandHub::default())
    }

    /// 허브가 받는 action 인가.
    pub fn allowed_action(&self, a: &str) -> bool {
        is_allowed_cmd_action(a)
    }

    /// 알람 방송을 함께 받을 함수를 단다. `None` 이면 걷는다 (FR-TGB-50).
    pub fn set_attention_observer(&self, f: Option<AttnObs>) {
        write(&self.attn_obs, f);
    }

    /// 알람 해제 방송을 함께 받을 함수를 단다 (FR-TGB-58b).
    pub fn set_attention_clear_observer(&self, f: Option<StrObs>) {
        write(&self.attn_clear_obs, f);
    }

    /// 추적기가 도구를 잊을 때 불릴 함수를 단다 (GD-12).
    pub fn set_tool_gone_observer(&self, f: Option<StrObs>) {
        write(&self.gone_obs, f);
    }

    fn clear_pending(&self, req_id: &str) {
        lock(&self.pending).remove(req_id);
    }

    #[cfg(test)]
    pub(crate) fn pending_count(&self) -> usize {
        lock(&self.pending).len()
    }

    #[cfg(test)]
    pub(crate) fn sub_count(&self) -> usize {
        lock(&self.subs).len()
    }
}

impl CommandBroker for CommandHub {
    /// 구독 하나를 등록한다. 상한을 넘으면 `None` 이며 호출자는 503 으로 옮긴다.
    fn add(&self) -> Option<Arc<CmdSub>> {
        let mut g = lock(&self.subs);
        if g.len() >= SUB_CAP {
            otter_shared_otterlog::infof!(None, "[cmd] 구독 상한 초과로 거절한다 (cap={SUB_CAP})");
            return None;
        }
        let s = CmdSub::new();
        g.insert(sub_key(&s), s.clone());
        Some(s)
    }

    fn remove(&self, s: &Arc<CmdSub>) {
        s.close();
        lock(&self.subs).remove(&sub_key(s));
    }

    fn set_broadcast_tap(&self, f: Option<BroadcastTap>) {
        write(&self.tap, f);
    }

    /// 모든 구독에 본문을 넣고 배달 수를 돌려준다. 큐가 가득 찬 구독은 닫는다 (REPO_FIX 02 §3A-2).
    fn broadcast(&self, payload: &[u8]) -> usize {
        let mut g = lock(&self.subs);
        let mut n = 0;
        let mut full = Vec::new();
        for (id, s) in g.iter() {
            if s.tx.try_send(payload.to_vec()).is_ok() {
                n += 1;
            } else {
                otter_shared_otterlog::infof!(
                    None,
                    "[cmd] 구독 큐({CMD_SUB_QUEUE})가 가득 차 구독을 닫는다 — 클라이언트가 재연결해 다시 받는다"
                );
                s.close();
                full.push(*id);
            }
        }
        for id in full {
            g.remove(&id);
        }
        drop(g);
        if let Some(f) = read(&self.tap) {
            f(payload);
        }
        n
    }

    /// 본문(이미 reqId 를 품었다)을 방송하고 브라우저의 에코나 시한을 기다린다. 받은
    /// 구독이 없으면 곧바로 돌아온다 (FR-RCR-2).
    fn broadcast_and_await<'a>(
        &'a self,
        payload: &'a [u8],
        req_id: &'a str,
        timeout: Duration,
    ) -> BoxFuture<'a, (CmdResult, usize, bool)> {
        Box::pin(async move {
            let (tx, rx) = oneshot::channel();
            lock(&self.pending).insert(req_id.to_owned(), tx);
            let n = self.broadcast(payload);
            if n == 0 {
                self.clear_pending(req_id);
                return (CmdResult::default(), 0, false);
            }
            match tokio::time::timeout(timeout, rx).await {
                Ok(Ok(res)) => (res, n, false),
                _ => {
                    self.clear_pending(req_id);
                    (CmdResult::default(), n, true)
                }
            }
        })
    }

    /// 브라우저 에코를 기다리는 쪽에 넘긴다. 첫 에코가 이긴다. 모르는·만료된 reqId 는
    /// 아무 일도 아니다 (FR-RCR-3, NFR-RCR-3).
    fn deliver_result(&self, req_id: &str, res: CmdResult) {
        if let Some(tx) = lock(&self.pending).remove(req_id) {
            let _ = tx.send(res);
        }
    }

    fn observe_attention(&self, id: &str, reason: &str) {
        if let Some(f) = read(&self.attn_obs) {
            f(id, reason);
        }
    }

    fn observe_attention_clear(&self, id: &str) {
        if let Some(f) = read(&self.attn_clear_obs) {
            f(id);
        }
    }

    fn observe_tool_gone(&self, id: &str) {
        if let Some(f) = read(&self.gone_obs) {
            f(id);
        }
    }
}
