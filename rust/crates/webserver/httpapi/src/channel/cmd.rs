//! 채널의 명령·사건 스트림 (`perf/CHANNEL_PROTOCOL.md` §10.2 C2a). 옛 `/api/commands/sse` 와
//! `POST /api/command-result` 의 자리다.

use std::sync::Arc;

use otter_webserver_hub::{self as hub, CmdPosition, CmdResult, CmdSub, TabRef};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::Outbox;
use crate::Server;

/// `hello.client` 로 붙은 신원 하나 — 임대와 명령 구독이다.
pub(super) struct ClientLink {
    id: String,
    release: Option<Box<dyn FnOnce() + Send>>,
    sub: Option<Arc<CmdSub>>,
    pump: Option<JoinHandle<()>>,
}

/// `cmd.result` 의 본문 (옛 `POST /api/command-result` 와 같다).
#[derive(Deserialize, Default)]
#[serde(default)]
struct CmdResultBody {
    #[serde(rename = "reqId")]
    req_id: String,
    #[serde(rename = "newWindows")]
    new_windows: Option<Vec<String>>,
    #[serde(rename = "newPanes")]
    new_panes: Option<Vec<String>>,
    #[serde(rename = "newTabs")]
    new_tabs: Option<Vec<TabRef>>,
    #[serde(rename = "newGroups")]
    new_groups: Option<Vec<String>>,
    position: Option<CmdPosition>,
    error: String,
}

impl Server {
    /// `hello` 의 `client` 에 맞춘다. 같은 신원이면 아무것도 하지 않는다. 서버 `hello` 를 보낸 뒤에 부른다.
    pub(super) fn channel_client(
        self: &Arc<Self>,
        out: &Arc<Outbox>,
        hello: &Value,
        link: &mut Option<ClientLink>,
        remote: &str,
    ) {
        let Some(id) = hello["client"].as_str().filter(|s| !s.is_empty()) else {
            return;
        };
        if link.as_ref().is_some_and(|l| l.id == id) {
            return;
        }
        if let Some(old) = link.take() {
            self.channel_client_drop(old);
        }
        let release = self.attach_channel_leases(id, remote, false);
        if let Some(u) = self.deps.updates.clone() {
            tokio::task::spawn_blocking(move || u.trigger());
        }
        let sub = self.commands().and_then(|c| c.add());
        if sub.is_none() {
            out.push_control(json!({"t":"error","code":"subscribe_rejected"}).to_string());
        }
        self.push_foreground(out);
        let pump = sub.clone().map(|s| tokio::spawn(pump(s, out.clone())));
        *link = Some(ClientLink {
            id: id.to_owned(),
            release: Some(Box::new(release)),
            sub,
            pump,
        });
    }

    pub(super) fn channel_client_drop(&self, mut l: ClientLink) {
        if let Some(p) = l.pump.take() {
            p.abort();
        }
        if let Some(s) = l.sub.take()
            && let Some(c) = self.commands()
        {
            c.remove(&s);
        }
        if let Some(r) = l.release.take() {
            r();
        }
    }

    /// `cmd.result` — 그 `reqId` 를 기다리는 생성 명령에 넘긴다.
    pub(super) fn channel_cmd_result(&self, v: Value) {
        let Ok(b) = serde_json::from_value::<CmdResultBody>(v) else {
            return;
        };
        if b.req_id.is_empty() {
            return;
        }
        if let Some(c) = self.commands() {
            c.deliver_result(
                &b.req_id,
                CmdResult {
                    new_windows: b.new_windows,
                    new_panes: b.new_panes,
                    new_tabs: b.new_tabs,
                    new_groups: b.new_groups,
                    position: b.position,
                    error: b.error,
                },
            );
        }
    }

    fn push_foreground(&self, out: &Outbox) {
        let Some(tools) = self.deps.tools.as_ref().and_then(|t| t.list_ok()) else {
            return;
        };
        for ev in hub::foreground_snapshot(&tools) {
            out.push_control(cmd_frame(&ev));
        }
    }
}

/// 허브가 구독을 닫으면(큐 넘침) 채널을 닫는다 — 브라우저가 다시 연결해 새로 구독한다.
async fn pump(s: Arc<CmdSub>, out: Arc<Outbox>) {
    loop {
        tokio::select! {
            _ = s.closed() => {
                out.close();
                return;
            }
            m = s.recv() => match m {
                Some(msg) => out.push_control(cmd_frame(&msg)),
                None => return,
            },
        }
    }
}

/// 방송 봉투 `{action,…}` 를 `{"t":"cmd",action,…}` 로 바꾼다. 봉투는 다시 해석하지 않는다.
fn cmd_frame(envelope: &[u8]) -> String {
    let body = String::from_utf8_lossy(envelope);
    match body.trim_start().strip_prefix('{') {
        Some(rest) if rest.trim_start().starts_with('}') => r#"{"t":"cmd"}"#.to_owned(),
        Some(rest) => format!(r#"{{"t":"cmd",{rest}"#),
        None => r#"{"t":"cmd"}"#.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::cmd_frame;

    #[test]
    fn cmd_frame_prefixes_envelope() {
        assert_eq!(
            cmd_frame(br#"{"action":"x","args":{}}"#),
            r#"{"t":"cmd","action":"x","args":{}}"#
        );
        assert_eq!(cmd_frame(b"{}"), r#"{"t":"cmd"}"#);
    }
}
