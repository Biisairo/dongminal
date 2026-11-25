//! 데몬이 밀어 보내는 것(push)과 도구별 구독자다.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, RwLockReadGuard, RwLockWriteGuard, Weak};

use bytes::Bytes;
use otter_shared_otterlog::warnf;
use otter_shared_toolhub::{ExitInfo, OutChunk, TermSize};
use otter_shared_toolipc::{
    AttnEvent, ChatEvent, EVENT_ATTN, EVENT_CHAT, EVENT_EDGES, EVENT_EXIT, EVENT_FOREGROUND,
    EVENT_OUTPUT, EVENT_REPORT, EVENT_SIZE, EdgesEvent, ReportEvent,
};
use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;

use crate::client::{Inner, ToolClient, lock};
use crate::wire::WireMsg;

/// output 떨어뜨림은 첫 건과 이 수의 배수마다 한 줄 적는다.
const OUTPUT_DROP_LOG_EVERY: i64 = 256;

/// 구독 하나 — 출력 채널과 그 도구의 종료 신호다.
pub(crate) struct Sub {
    tx: Sender<OutChunk>,
    exit: CancellationToken,
}

/// 마지막으로 알린 전경 이름과 그 push 의 순번이다.
#[derive(Clone, Debug, Default)]
pub(crate) struct FgSeen {
    pub name: String,
    pub seq: u64,
}

#[derive(Default)]
pub(crate) struct FgState {
    pub seen: HashMap<String, FgSeen>,
    pub seq: u64,
}

/// [`ToolClient::subscribe`] 의 구독 해제 손잡이다. 해제는 종료 신호를 건드리지 않는다.
pub struct Unsubscribe {
    inner: Weak<Inner>,
    tool: String,
    id: u64,
}

impl Unsubscribe {
    pub fn unsubscribe(self) {
        if let Some(inner) = self.inner.upgrade()
            && let Some(m) = inner.write_subs().get_mut(&self.tool)
        {
            m.remove(&self.id);
        }
    }
}

impl Inner {
    pub(crate) fn read_subs(&self) -> RwLockReadGuard<'_, HashMap<String, HashMap<u64, Sub>>> {
        self.subs.read().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn write_subs(&self) -> RwLockWriteGuard<'_, HashMap<String, HashMap<u64, Sub>>> {
        self.subs.write().unwrap_or_else(|p| p.into_inner())
    }

    /// push 하나를 이벤트별로 나눈다. 모르는 이벤트는 버린다.
    pub(crate) fn handle_push(&self, m: &WireMsg) {
        match m.event.as_str() {
            EVENT_OUTPUT => self.push_output(m),
            EVENT_FOREGROUND => self.push_foreground(m),
            EVENT_EXIT => self.push_exit(m),
            EVENT_SIZE => self.push_size(m),
            EVENT_REPORT => {
                let cb = lock(&self.st).cbs.on_report.clone();
                if let Some(cb) = cb {
                    cb(ReportEvent {
                        event: m.event.clone(),
                        method: m.method.clone(),
                        body: m.body.clone(),
                    });
                }
            }
            EVENT_ATTN => {
                let cb = lock(&self.st).cbs.on_attn.clone();
                if let Some(cb) = cb {
                    cb(AttnEvent {
                        event: m.event.clone(),
                        tool: m.tool.clone(),
                        kind: m.kind.clone(),
                        reason: m.reason.clone(),
                        agent: m.agent.clone(),
                    });
                }
            }
            EVENT_EDGES => {
                let cb = lock(&self.st).cbs.on_edges.clone();
                if let Some(cb) = cb {
                    cb(EdgesEvent {
                        event: m.event.clone(),
                        paired: m.paired.clone(),
                        removed: m.removed.clone(),
                        by_peer: m.by_peer,
                        invited: m.invited.clone(),
                    });
                }
            }
            EVENT_CHAT => {
                let cb = lock(&self.st).cbs.on_chat.clone();
                if let Some(cb) = cb {
                    cb(ChatEvent {
                        chat: m.chat.clone(),
                        chat_kind: m.chat_kind.clone(),
                        event: m.event.clone(),
                    });
                }
            }
            _ => {}
        }
    }

    /// 출력과 같은 채널로 보낸다 — 크기가 바뀐 뒤의 출력은 새 폭 기준이다 (FR-M9-3 ②). 막지 않고
    /// 떨어뜨리며, 떨어뜨림은 한 건도 남김없이 적는다.
    fn push_size(&self, m: &WireMsg) {
        if m.cols == 0 || m.rows == 0 {
            return;
        }
        self.invalidate_list();
        let size = Some(TermSize {
            cols: m.cols,
            rows: m.rows,
        });
        let mut dropped = 0;
        if let Some(subs) = self.read_subs().get(&m.tool) {
            for s in subs.values() {
                let chunk = OutChunk {
                    size,
                    ..OutChunk::default()
                };
                if s.tx.try_send(chunk).is_err() {
                    dropped = self.dropped.fetch_add(1, Ordering::SeqCst) + 1;
                }
            }
        }
        if dropped > 0 {
            warnf!(
                None,
                "toolclient: WS size push dropped tool={} cols={} rows={} (slow browser?)",
                m.tool,
                m.cols,
                m.rows
            );
        }
    }

    /// 해석층(on_output)에 한 번, 구독한 브라우저마다 한 번. 느린 구독자 하나가 읽기 루프를
    /// 세우지 않게 막지 않고 떨어뜨린다 (FR-18). 바이트는 한 번 복사해 구독자들이 나눈다 (PERF M4 §4).
    fn push_output(&self, m: &WireMsg) {
        let cb = lock(&self.st).cbs.on_output.clone();
        if let Some(cb) = cb {
            cb(&m.tool, &m.data, m.end);
        }
        let mut dropped = 0;
        if let Some(subs) = self.read_subs().get(&m.tool) {
            let data = Bytes::copy_from_slice(&m.data);
            for s in subs.values() {
                let chunk = OutChunk {
                    data: data.clone(),
                    end: m.end,
                    size: None,
                };
                if s.tx.try_send(chunk).is_err() {
                    dropped = self.dropped.fetch_add(1, Ordering::SeqCst) + 1;
                }
            }
        }
        if dropped == 1 || (dropped > 0 && dropped % OUTPUT_DROP_LOG_EVERY == 0) {
            warnf!(
                None,
                "toolclient: WS output backpressure tool={} dropped={dropped} (slow browser?)",
                m.tool
            );
        }
    }

    fn push_foreground(&self, m: &WireMsg) {
        self.invalidate_list();
        let cb = lock(&self.st).cbs.on_foreground.clone();
        let mut fg = lock(&self.fg);
        fg.seq += 1;
        let seq = fg.seq;
        fg.seen.insert(
            m.tool.clone(),
            FgSeen {
                name: m.name.clone(),
                seq,
            },
        );
        if let Some(cb) = cb {
            cb(&m.tool, &m.name);
        }
    }

    /// 구독자의 종료 신호를 켜고 전역 종료 콜백을 부른다. 배선 전이면 버퍼한다.
    fn push_exit(&self, m: &WireMsg) {
        self.invalidate_list();
        let subs = self.write_subs().remove(&m.tool);
        for s in subs.into_iter().flat_map(HashMap::into_values) {
            s.exit.cancel();
        }
        let info = ExitInfo { code: m.code };
        let cb = {
            let mut st = lock(&self.st);
            let cb = st.cbs.on_exit.clone();
            if cb.is_none() {
                st.early_exits.push((m.tool.clone(), info));
            }
            cb
        };
        if let Some(cb) = cb {
            cb(&m.tool, info);
        }
    }

    /// 구독을 모두 떼어 낸다 (재접속 뒤의 재동기). 각 구독에 대해 `dead(tool)` 이면 종료 신호를
    /// 켜고, 아니면 출력 채널만 닫는다. 떼어 낸 도구 id 를 돌려준다.
    pub(crate) fn detach_subs(&self, dead: impl Fn(&str) -> bool) -> Vec<String> {
        let subs = std::mem::take(&mut *self.write_subs());
        let mut ids = Vec::with_capacity(subs.len());
        for (id, m) in subs {
            let gone = dead(&id);
            for s in m.into_values() {
                if gone {
                    s.exit.cancel();
                }
            }
            ids.push(id);
        }
        ids
    }
}

impl ToolClient {
    /// 도구의 출력을 tx 로 받는다. 돌려주는 토큰은 도구가 끝나면 취소된다.
    ///
    /// 허브는 tx 의 마지막 복제본을 쥔다. 허브가 tx 를 놓으면(채널이 닫히면) 구독이 끊긴 것이다 —
    /// 그때 토큰이 취소되어 있으면 도구가 끝난 것이고, 아니면 데몬 재접속이므로 since 로 재동기한다
    /// (FR-OPT-1-2). 채널이 가득 차면 그 조각은 떨어진다.
    pub fn subscribe(
        &self,
        tool_id: &str,
        tx: Sender<OutChunk>,
    ) -> (CancellationToken, Unsubscribe) {
        let exit = CancellationToken::new();
        let id = self.inner.next_sub.fetch_add(1, Ordering::SeqCst);
        self.inner
            .write_subs()
            .entry(tool_id.to_owned())
            .or_default()
            .insert(
                id,
                Sub {
                    tx,
                    exit: exit.clone(),
                },
            );
        (
            exit,
            Unsubscribe {
                inner: Arc::downgrade(&self.inner),
                tool: tool_id.to_owned(),
                id,
            },
        )
    }
}
