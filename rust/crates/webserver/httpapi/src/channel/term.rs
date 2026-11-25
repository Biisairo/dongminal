//! 채널 위의 터미널 — `term.open`·`term.close`, `[op][sid]` 프레임 (`perf/CHANNEL_PROTOCOL.md` §4.2·§6,
//! §10.6 C5). 옛 `/ws` 의 세션·재생·중계·좌석을 sid 단위로 옮겼다.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::future::BoxFuture;
use otter_shared_otterlog::{errorf, infof, warnf};
use otter_shared_toolhub::{
    self as th, OP_ERROR, OP_EXIT, OP_INPUT, OP_OUTPUT, OP_RESIZE, OP_SEQ, OP_SIZE, OP_TOOL_ID,
    OutChunk, Placement, ToolHistory, ToolScreen, ToolSnapshot,
};
use otter_webserver_hub::{SeatClosed, SeatConn};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::outbox::Outbox;
use crate::Server;
use crate::toolhub::{ToolError, ToolHub, with_req};
use crate::ws::{
    MISS_DELAY, relay_joinable, replay_delta, seq_payload, snap_seq_payload, trim_overlap,
    unix_nanos,
};

/// sid 하나에 밀린 바이트가 이보다 많으면 밀린 것을 버리고 다시 재생한다 (§6, 데몬 링 `BUF_MAX` 와 같다).
pub(crate) const TERM_PENDING_MAX: usize = 1 << 20;
/// 도구 구독 채널의 크기다.
const OUTPUT_QUEUE: usize = 256;
/// 출력 프레임을 합치는 상한이다 (Go `relayCoalesceMax`).
const RELAY_COALESCE_MAX: usize = 64 << 10;
/// 도구가 정해지기 전에 온 입력을 담아 두는 상한(프레임 수)이다.
const EARLY_MAX: usize = 256;
/// 위로 받기 한 번에 주는 줄 수의 상한이다 (FR-TRM-5).
pub(crate) const TERM_HISTORY_MAX: usize = 2_000;
/// 바이너리 프레임 머리: op 1바이트 + sid 4바이트.
pub(crate) const HEAD: usize = 5;

struct Entry {
    ver: u64,
    done: CancellationToken,
    tool: Option<String>,
    early: Vec<Vec<u8>>,
}

/// 채널 하나의 터미널들.
#[derive(Default)]
pub(crate) struct Terms {
    map: Mutex<HashMap<u32, Entry>>,
    ver: std::sync::atomic::AtomicU64,
}

impl Terms {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Entry>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 채널이 끝난다 — 모든 세션을 멈춘다.
    pub(crate) fn close_all(&self) {
        for (_, e) in self.lock().drain() {
            e.done.cancel();
        }
    }

    fn finish(&self, sid: u32, ver: u64) {
        let mut g = self.lock();
        if g.get(&sid).is_some_and(|e| e.ver == ver) {
            g.remove(&sid);
        }
    }
}

/// 좌석 통보를 그 sid 의 터미널 프레임으로 보낸다.
struct SidSeat {
    out: Arc<Outbox>,
    sid: u32,
    og: u64,
}

impl SeatConn for SidSeat {
    fn send<'a>(&'a self, op: u8, payload: &'a [u8]) -> BoxFuture<'a, Result<(), SeatClosed>> {
        self.out.push_term_as(self.og, op, self.sid, payload);
        Box::pin(async { Ok(()) })
    }
}

/// 브라우저 화면을 데몬에 맞추는 것 — 링에서 이어 붙이기 또는 화면 상태 스냅숏 (PERF M2 §2.5).
enum Sync {
    Delta(ToolSnapshot),
    Screen(Arc<ToolScreen>),
}

impl Sync {
    fn end(&self) -> i64 {
        match self {
            Sync::Delta(s) => s.end,
            Sync::Screen(s) => s.end,
        }
    }

    fn size(&self) -> (u16, u16) {
        match self {
            Sync::Delta(s) => (s.cols, s.rows),
            Sync::Screen(s) => (s.cols, s.rows),
        }
    }
}

/// 세션이 끝난 까닭.
enum End {
    /// 도구가 없다 — `EXIT` 를 보냈다.
    Gone,
    /// 다시 붙어야 한다 — `term.lost` 를 보낸다.
    Lost,
    /// 채널·`term.close` 가 멈췄거나 도구가 끝났다. 더 보낼 것이 없다.
    Quiet,
}

struct Session {
    srv: Arc<Server>,
    hub: Arc<dyn ToolHub>,
    out: Arc<Outbox>,
    sid: u32,
    /// Outbox 의 세션 번호 (`term_begin`).
    og: u64,
    done: CancellationToken,
}

fn lost(out: &Outbox, sid: u32) {
    out.push_control(json!({"t":"term.lost","sid":sid}).to_string());
}

fn history_frame(sid: u32, h: &ToolHistory) -> String {
    json!({"t":"term.history","sid":sid,"from":h.from,"top":h.top,"lines":h.lines}).to_string()
}

fn num(v: &Value) -> Option<String> {
    v.as_u64().map(|n| n.to_string())
}

impl Server {
    /// `term.open{sid,tool,cols,rows,since,snap}`. 같은 sid 가 이미 열려 있으면 그것을 멈추고 새로 연다.
    /// `snap` 이면(깨움) `since` 를 보지 않고 스냅숏을 보낸다.
    pub(crate) fn term_open(self: &Arc<Self>, terms: &Arc<Terms>, out: &Arc<Outbox>, v: &Value) {
        let Some(sid) = v["sid"].as_u64().and_then(|s| u32::try_from(s).ok()) else {
            out.push_control(json!({"t":"error","code":"bad_sid"}).to_string());
            return;
        };
        let Some(hub) = self.deps.tools.clone() else {
            out.push_term(OP_ERROR, sid, b"tools unavailable");
            return;
        };
        let ver = terms.ver.fetch_add(1, Ordering::Relaxed) + 1;
        let done = CancellationToken::new();
        if let Some(old) = terms.lock().insert(
            sid,
            Entry {
                ver,
                done: done.clone(),
                tool: None,
                early: Vec::new(),
            },
        ) {
            old.done.cancel();
        }
        let og = out.term_begin(sid);
        let (cols, rows) = th::parse_size(num(&v["cols"]).as_deref(), num(&v["rows"]).as_deref());
        let tool = v["tool"].as_str().unwrap_or_default().to_owned();
        let since = match v["snap"].as_bool() {
            Some(true) => -1,
            _ => v["since"].as_i64().filter(|s| *s >= 0).unwrap_or(-1),
        };
        let s = Session {
            srv: Arc::clone(self),
            hub,
            out: out.clone(),
            sid,
            og,
            done,
        };
        let terms = terms.clone();
        tokio::spawn(async move {
            match s.run(&terms, ver, tool, cols, rows, since).await {
                End::Lost if s.out.term_current(sid, og) => lost(&s.out, sid),
                End::Lost => {}
                End::Gone | End::Quiet => {}
            }
            terms.finish(sid, ver);
        });
    }

    /// `term.close{sid}`.
    pub(crate) fn term_close(&self, terms: &Terms, out: &Outbox, v: &Value) {
        let Some(sid) = v["sid"].as_u64().and_then(|s| u32::try_from(s).ok()) else {
            return;
        };
        if let Some(e) = terms.lock().remove(&sid) {
            e.done.cancel();
        }
        out.forget_term(sid);
    }

    /// `term.history{sid,before,count}` (FR-TRM-5). 데몬에 묻기는 따로 띄운 일이 해서 출력·입력을 막지
    /// 않는다. 모르는 sid·데몬 오류는 빈 답(`from = top = before`)이다 — 브라우저는 더 묻지 않는다.
    pub(crate) fn term_history(&self, terms: &Terms, out: &Arc<Outbox>, v: &Value) {
        let Some(sid) = v["sid"].as_u64().and_then(|s| u32::try_from(s).ok()) else {
            out.push_control(json!({"t":"error","code":"bad_sid"}).to_string());
            return;
        };
        let before = v["before"].as_u64().unwrap_or(0);
        let count = v["count"]
            .as_u64()
            .map_or(0, |n| usize::try_from(n).unwrap_or(usize::MAX))
            .min(TERM_HISTORY_MAX);
        let empty = ToolHistory {
            from: before,
            top: before,
            lines: Vec::new(),
        };
        let tool = terms.lock().get(&sid).and_then(|e| e.tool.clone());
        let (Some(tool), Some(hub)) = (tool, self.deps.tools.clone()) else {
            out.push_history(history_frame(sid, &empty));
            return;
        };
        let out = out.clone();
        tokio::spawn(async move {
            let h = tokio::task::spawn_blocking(move || hub.history_tool(&tool, before, count))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(empty);
            out.push_history(history_frame(sid, &h));
        });
    }

    /// 브라우저의 `[op][sid][payload]` — 입력·크기 조정을 그 sid 의 도구로 넘긴다. 모르는 sid 는 버린다.
    pub(crate) fn term_input(&self, terms: &Terms, b: &[u8]) {
        let sid = u32::from_be_bytes([b[1], b[2], b[3], b[4]]);
        let tool = {
            let mut g = terms.lock();
            let Some(e) = g.get_mut(&sid) else { return };
            match &e.tool {
                Some(t) => t.clone(),
                None => {
                    if e.early.len() < EARLY_MAX {
                        e.early.push(b.to_vec());
                    }
                    return;
                }
            }
        };
        self.term_forward(&tool, b);
    }

    fn term_forward(&self, tool: &str, b: &[u8]) {
        let Some(hub) = self.deps.tools.as_ref() else {
            return;
        };
        let p = &b[HEAD..];
        match b[0] {
            OP_INPUT => {
                self.browser_in.mark(tool);
                hub.input_notify(tool, p);
            }
            OP_RESIZE if p.len() >= 4 => hub.resize_notify(
                tool,
                u16::from_be_bytes([p[0], p[1]]),
                u16::from_be_bytes([p[2], p[3]]),
            ),
            _ => {}
        }
    }
}

impl Session {
    async fn run(
        &self,
        terms: &Terms,
        ver: u64,
        mut tool: String,
        cols: u16,
        rows: u16,
        since: i64,
    ) -> End {
        self.srv.conn.last_ws.store(unix_nanos(), Ordering::Relaxed);
        let snap_judges = self
            .hub
            .has_feature(otter_shared_toolipc::FEATURE_SNAPSHOT_NOT_FOUND);
        if tool.is_empty() {
            let h = with_req(self.hub.clone(), None);
            let created = tokio::task::spawn_blocking(move || {
                h.create("", cols, rows, &Placement::default())
            })
            .await
            .unwrap_or_else(|e| Err(ToolError::Other(e.to_string())));
            match created {
                Ok(t) => tool = t.id,
                Err(e) => {
                    let msg = format!("도구를 만들지 못했습니다: {e}");
                    self.out
                        .push_term_as(self.og, OP_ERROR, self.sid, msg.as_bytes());
                    errorf!(
                        None,
                        "channel term sid={}: tool create error: {e}",
                        self.sid
                    );
                    return End::Quiet;
                }
            }
        } else if !snap_judges {
            let (h, id) = (self.hub.clone(), tool.clone());
            let found = tokio::task::spawn_blocking(move || h.get(&id))
                .await
                .ok()
                .flatten();
            if found.is_none() {
                if !self.hub.connected() {
                    warnf!(
                        None,
                        "channel term sid={}: tool {tool} lookup during daemon reconnect",
                        self.sid
                    );
                    return End::Lost;
                }
                return self.gone(&tool).await;
            }
        }
        let (tx, rx) = mpsc::channel::<OutChunk>(OUTPUT_QUEUE);
        let (exit, unsub) = self.hub.subscribe(&tool, tx);
        let end = match self.sync(&tool, since).await {
            Err(end) => end,
            Ok(sync) => {
                self.out
                    .push_term_as(self.og, OP_TOOL_ID, self.sid, tool.as_bytes());
                self.size(&sync);
                let seat: Arc<dyn SeatConn> = Arc::new(SidSeat {
                    out: self.out.clone(),
                    sid: self.sid,
                    og: self.og,
                });
                self.srv.seats.join(&tool, seat.clone()).await;
                self.send(&sync);
                self.ready(terms, ver, &tool);
                let end = self.relay(&tool, rx, exit, sync.end()).await;
                self.srv.seats.leave(&tool, &seat).await;
                end
            }
        };
        unsub();
        end
    }

    /// 도구가 정해졌다 — 그 전에 온 입력을 차례대로 넘긴다.
    fn ready(&self, terms: &Terms, ver: u64, tool: &str) {
        let early = {
            let mut g = terms.lock();
            let Some(e) = g.get_mut(&self.sid).filter(|e| e.ver == ver) else {
                return;
            };
            e.tool = Some(tool.to_owned());
            std::mem::take(&mut e.early)
        };
        for b in early {
            self.srv.term_forward(tool, &b);
        }
    }

    async fn gone(&self, tool: &str) -> End {
        if self.srv.conn.misses.repeat(tool, Instant::now()) {
            tokio::select! {
                _ = self.done.cancelled() => return End::Quiet,
                _ = tokio::time::sleep(MISS_DELAY) => {}
            }
        }
        self.out.push_term_as(self.og, OP_EXIT, self.sid, &[]);
        infof!(
            None,
            "channel term sid={}: tool {tool} not found (sent EXIT)",
            self.sid
        );
        End::Gone
    }

    /// `since` 가 링 안이면 그 뒤 바이트를, 아니면(없거나 링 밖이면) 화면 상태 스냅숏을 받는다.
    async fn sync(&self, tool: &str, since: i64) -> Result<Sync, End> {
        if since >= 0 {
            let (h, id) = (self.hub.clone(), tool.to_owned());
            let r = tokio::task::spawn_blocking(move || h.snapshot_tool_since(&id, since))
                .await
                .unwrap_or_else(|e| Err(ToolError::Other(e.to_string())));
            let s = self.verdict(tool, r).await?;
            if s.resumed {
                return Ok(Sync::Delta(s));
            }
        }
        let r = self.srv.screens.get(&self.hub, tool).await;
        self.verdict(tool, r).await.map(Sync::Screen)
    }

    async fn verdict<T>(&self, tool: &str, r: Result<T, ToolError>) -> Result<T, End> {
        match r {
            Ok(s) => Ok(s),
            Err(ToolError::NotFound(_)) => Err(self.gone(tool).await),
            Err(e) => {
                errorf!(None, "[tool {tool}] snapshot error: {e}");
                Err(End::Lost)
            }
        }
    }

    /// 크기를 알면 알린다.
    fn size(&self, sync: &Sync) {
        let (cols, rows) = sync.size();
        if cols != 0 && rows != 0 {
            self.out
                .push_term_as(self.og, OP_SIZE, self.sid, &th::size_payload(cols, rows));
        }
    }

    /// 화면을 맞추는 `OUTPUT` → 좌표 `SEQ`. 둘 사이에 다른 프레임을 끼우지 않는다.
    fn send(&self, sync: &Sync) {
        match sync {
            Sync::Delta(s) => self.frames(
                &replay_delta(&s.data),
                &seq_payload(s.end, s.modes.alt_screen),
            ),
            Sync::Screen(s) => self.frames(&s.data, &snap_seq_payload(s)),
        }
    }

    fn frames(&self, payload: &[u8], seq: &[u8]) {
        if !payload.is_empty() {
            self.out.push_term_as(self.og, OP_OUTPUT, self.sid, payload);
        }
        self.out.push_term_as(self.og, OP_SEQ, self.sid, seq);
    }

    /// 데몬에서 `since` 부터 다시 맞춘다. 새 보낸 끝을 돌려준다.
    async fn resync(&self, tool: &str, since: i64) -> Result<i64, End> {
        let sync = self.sync(tool, since).await?;
        self.size(&sync);
        self.send(&sync);
        Ok(sync.end())
    }

    /// 도구 출력을 이어 붙여 보낸다 (옛 `relay_output`). 틈이 생기거나 밀린 양이 상한을 넘으면
    /// 이 sid 만 다시 맞춘다.
    async fn relay(
        &self,
        tool: &str,
        mut rx: mpsc::Receiver<OutChunk>,
        exit: CancellationToken,
        mut sent: i64,
    ) -> End {
        let mut pending: Option<OutChunk> = None;
        let mut pending_closed = false;
        loop {
            let chunk = if pending_closed {
                None
            } else if let Some(p) = pending.take() {
                Some(p)
            } else {
                tokio::select! {
                    c = rx.recv() => c,
                    _ = exit.cancelled() => {
                        self.out.push_term_as(self.og, OP_EXIT, self.sid, &[]);
                        return End::Quiet;
                    }
                    _ = self.done.cancelled() => return End::Quiet,
                }
            };
            let Some(chunk) = chunk else {
                infof!(None, "[tool {tool}] channel relay resync sid={}", self.sid);
                return End::Lost;
            };
            if let Some(sz) = chunk.size {
                self.out.push_term_as(
                    self.og,
                    OP_SIZE,
                    self.sid,
                    &th::size_payload(sz.cols, sz.rows),
                );
                continue;
            }
            if !relay_joinable(&chunk, sent) {
                warnf!(
                    None,
                    "[tool {tool}] output gap sent={sent} start={} sid={} — resync",
                    chunk.end - chunk.data.len() as i64,
                    self.sid
                );
                match self.resync(tool, sent).await {
                    Ok(end) => sent = end,
                    Err(end) => return end,
                }
                continue;
            }
            let mut frame = trim_overlap(&chunk.data, chunk.end, sent).to_vec();
            sent = chunk.end.max(sent);
            loop {
                match rx.try_recv() {
                    Ok(next) => {
                        if !relay_joinable(&next, sent) {
                            pending = Some(next);
                            break;
                        }
                        let d = trim_overlap(&next.data, next.end, sent);
                        if frame.len() + d.len() > RELAY_COALESCE_MAX {
                            pending = Some(next);
                            break;
                        }
                        frame.extend_from_slice(d);
                        sent = next.end.max(sent);
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => {
                        pending_closed = true;
                        break;
                    }
                    Err(mpsc::error::TryRecvError::Empty) => break,
                }
            }
            if !frame.is_empty() {
                self.out.push_term_as(self.og, OP_OUTPUT, self.sid, &frame);
            }
            if self.out.term_state(self.sid).0 > TERM_PENDING_MAX {
                self.out.drop_term(self.sid);
                let since = self.out.term_state(self.sid).1.unwrap_or(-1);
                warnf!(
                    None,
                    "[tool {tool}] channel slow sid={} — dropped backlog, replay since={since}",
                    self.sid
                );
                pending = None;
                match self.resync(tool, since).await {
                    Ok(end) => sent = end,
                    Err(end) => return end,
                }
            }
        }
    }
}
