//! 트리 방 규칙 맞추기 (ISSUE_TREE_CHAT_SRS FR-ITR-1·2·3·10). 트리 Run 의 채팅 방에 사람 참가자와
//! 트리 멤버 세션을 넣는 일은 데몬이 하고(`tree` 연산), 서버는 Run 이 바뀔 때 멤버의 도구 목록을 맞춘다.

use std::collections::BTreeSet;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_chatwire as chatwire;
use otter_shared_otterlog::infof;
use otter_shared_toolipc::ChatParams;
use otter_webserver_domain_run::{self as run, Record};

use crate::Server;

impl Server {
    /// 트리 방이 있는 Run 이 바뀌면 그 트리 방의 규칙을 맞춘다. 데몬 IPC 는 막히므로 블로킹 스레드에서 한다.
    pub(crate) fn sync_tree_room(&self, rec: &Record) {
        if rec.chat_room.is_empty() {
            return;
        }
        let Some(srv) = self.arc() else {
            return;
        };
        let (tree, room) = (rec.tree.clone(), rec.chat_room.clone());
        let job = move || srv.apply_tree_room(&tree, &room);
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn_blocking(job);
            }
            Err(_) => job(),
        }
    }

    /// 지금 기록으로 규칙을 다시 만든다: 열린 트리 Run 의 조정자와 멤버 도구. 열린 Run 이 없으면 규칙을 닫는다.
    fn apply_tree_room(&self, tree: &str, room: &str) {
        let _one = self
            .tree_rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(d) = self.deps.chat_daemon.clone() else {
            return;
        };
        let Some(st) = self.runs() else {
            return;
        };
        if !d.chat_ready() {
            return;
        }
        let open: Vec<Record> = st
            .list()
            .into_iter()
            .filter(|r| r.state == run::OPEN && r.tree == tree && r.chat_room == room)
            .collect();
        let mut args = chatwire::TreeArgs {
            room: room.to_owned(),
            close: open.is_empty(),
            ..chatwire::TreeArgs::default()
        };
        if !args.close {
            let tools: BTreeSet<String> = open
                .iter()
                .flat_map(|r| {
                    std::iter::once(r.coordinator_tool_id.clone())
                        .chain(r.members.iter().map(|m| m.tool_id.clone()))
                })
                .filter(|t| !t.is_empty())
                .collect();
            args.tools = Some(tools.into_iter().collect());
        }
        let Ok(raw) = json::marshal(&args) else {
            return;
        };
        let res = d.chat(ChatParams {
            op: chatwire::OP_TREE.to_owned(),
            args: RawMessage(raw),
        });
        match res {
            Ok(r) => {
                if let Some(e) = r.error {
                    infof!(
                        None,
                        "[run] 트리 방 규칙 거절 room={room}: {} {}",
                        e.code,
                        e.message
                    );
                }
            }
            Err(e) => infof!(None, "[run] 트리 방 규칙 실패 room={room}: {e}"),
        }
    }
}
