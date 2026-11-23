//! 채팅은 간선 연결 위에 얹힌 위층이다 (EDGE_MESH_SRS FR-EGM-40). 연결·다시 걸기·생존 확인은
//! 간선 계층이 하고, 채팅은 자기 프레임(state·msg·cmd)만 다룬다.

use std::collections::{HashMap, HashSet};

use dm_gocompat::json;
use dm_shared_edgemesh::{Frame, Upper, encode, mark_expendable, parse_key, verify};
use dm_shared_termtext as termtext;
use time::OffsetDateTime;

use crate::frame::{
    FRAME_CMD, FRAME_MSG, FRAME_STATE, MsgBody, StateBody, bound_to, open_record, valid_body,
    valid_id,
};
use crate::human::valid_helper_key;
use crate::service::{
    ID_PREFIX, KIND_AGENT, KIND_DIRECT, KIND_USER, MAX_LABEL, MAX_MARKS, MAX_NODE_ROOMS, MAX_NODES,
    MAX_PART_ROOMS, MAX_PARTS, MAX_TEXT, Mark, Pending, Remote, Room, Service, State, part_in_room,
    party_ok, record_locked,
};

impl Upper for Service {
    /// 간선 계층이 넘긴 채팅 프레임이다. from 은 받은 간선 연결의 상대다.
    fn frame(&self, from: &str, fr: Frame) {
        self.handle(from, fr);
    }

    /// 새 간선 연결이다. 자기 상태와 아는 노드들의 상태를 처음 줄로 넣는다 — 받는 쪽은 상태를
    /// 글보다 먼저 받는다 (FR-EGM-6).
    fn linked(&self, fp: &str) {
        let mut st = self.lock();
        let Some(mesh) = &self.opts.mesh else {
            return;
        };
        if st.closed {
            return;
        }
        let mut lines = vec![encode(&st.own)];
        lines.extend(st.nodes.values().map(|r| encode(&r.raw)));
        // 새 연결은 대개 간선이 바뀐 뒤다 — 고정 판정이 낡은 목록을 보지 않게 한다
        st.edge_cache = None;
        mesh.open(fp, lines);
    }

    /// 망 그림이 바뀌었다는 간선 계층의 알림이다. 개인채팅을 맞추고 바뀜을 알린다.
    fn changed(&self) {
        let mut st = self.lock();
        if !st.closed {
            self.changed_locked(&mut st);
        }
    }
}

fn newer(st: &StateBody, epoch: i64, seq: u64) -> bool {
    st.epoch > epoch || st.epoch == epoch && st.seq > seq
}

fn valid_state(st: &StateBody) -> bool {
    if st.parts().len() > MAX_PARTS || st.records().len() > MAX_NODE_ROOMS {
        return false;
    }
    let pins = st.pins.as_ref();
    if !valid_helper_key(&st.helper) || pins.is_some_and(|p| p.len() > MAX_NODES) {
        return false;
    }
    if pins.is_some_and(|p| {
        p.iter().any(|(fp, k)| {
            fp.len() != ID_PREFIX || !valid_id(fp) || k.is_empty() || !valid_helper_key(k)
        })
    }) {
        return false;
    }
    st.parts().iter().all(|p| {
        p.rooms().len() <= MAX_PART_ROOMS
            && valid_id(&p.id)
            && bound_to(&p.id, &st.node)
            && termtext::line(&p.label, MAX_LABEL)
            // 종류는 agent·user 뿐이다 (DIFF: Go 는 kind 를 보지 않는다).
            && (p.kind == KIND_AGENT || p.kind == KIND_USER)
    })
}

impl Service {
    /// 받은 프레임을 다룬다. close 뒤에는 아무것도 받지 않는다 (FR-ATF-54).
    pub(crate) fn handle(&self, from: &str, fr: Frame) {
        let pin = {
            let mut st = self.lock();
            if st.closed {
                return;
            }
            match fr.t.as_str() {
                FRAME_STATE => {
                    if self.accept_state_locked(&mut st, &fr) {
                        self.broadcast_locked(&fr, from);
                        self.changed_locked(&mut st);
                    }
                    // 간선 상대 자신의 연결로 온 상태는, 같은 번호를 다른 길로 먼저 받았어도 고정을
                    // 확인한다 (§3.12a R-6, EDGE_MESH_SRS FR-EGM-44).
                    self.pin_locked(&mut st, from)
                }
                FRAME_CMD => {
                    if self.accept_cmd_locked(&mut st, &fr) {
                        self.broadcast_locked(&fr, from);
                        self.changed_locked(&mut st);
                    }
                    None
                }
                FRAME_MSG => {
                    if let Some((out, node)) = self.accept_msg_locked(&mut st, &fr) {
                        self.broadcast_locked(&fr, from);
                        self.enqueue_locked(&mut st, &node, out);
                    }
                    None
                }
                _ => None,
            }
        };
        if let Some((fp, key)) = pin {
            self.apply_pin(&fp, &key);
        }
    }

    /// 바르고 더 새로운 노드 상태 알림만 받는다 (FR-PCH-5·9·20).
    fn accept_state_locked(&self, st: &mut State, fr: &Frame) -> bool {
        let Ok(body) = json::unmarshal::<StateBody>(&fr.b.0) else {
            return false;
        };
        if body.node == self.id.fingerprint {
            return false;
        }
        let Some(key) = parse_key(&body.node, &body.key) else {
            return false;
        };
        if !verify(&key, FRAME_STATE, &fr.b.0, &fr.s) || !valid_state(&body) {
            return false;
        }
        // 잊었다 다시 받는 노드도 닿은 적 있다는 표시를 잇는다.
        let was_reached = st.marks.get(&body.node).is_some_and(|m| m.reached);
        if let Some(old) = st.nodes.get(&body.node) {
            if !newer(&body, old.st.epoch, old.st.seq) {
                return false;
            }
        } else {
            let mark = st.marks.get(&body.node).cloned();
            if let Some(m) = &mark
                && !newer(&body, m.epoch, m.state_seq)
            {
                return false;
            }
            if st.nodes.len() >= st.max_nodes && !self.evict_locked(st) {
                return false;
            }
            if let Some(m) = mark {
                st.marks.remove(&body.node);
                if body.epoch == m.epoch {
                    st.wins.insert(body.node.clone(), m.window());
                }
            }
        }
        let rooms: HashMap<String, Room> = body
            .records()
            .iter()
            .filter_map(|rec| {
                open_record(rec).map(|b| {
                    (
                        rec.id(),
                        Room {
                            rec: rec.clone(),
                            body: b,
                        },
                    )
                })
            })
            .collect();
        let node = body.node.clone();
        let node_key = node.clone();
        let reached = was_reached || st.nodes.get(&node).is_some_and(|r| r.reached);
        st.nodes.insert(
            node,
            Remote {
                st: body,
                key,
                raw: fr.clone(),
                rooms,
                at: self.now(),
                reached: reached || self.reachable().contains(&node_key),
            },
        );
        true
    }

    /// 닿지 않는 노드 가운데 가장 오래 소식이 없는 것을 잊는다. 이 노드의 개인채팅에 걸린 노드는
    /// 잊지 않는다. 잊은 노드의 마지막 번호는 남겨, 옛 상태와 옛 글을 다시 받지 않는다. 잊을 것이
    /// 없으면 거짓이다.
    fn evict_locked(&self, st: &mut State) -> bool {
        let reach = self.reachable();
        let mut pinned: HashSet<&str> = HashSet::new();
        for r in st.rooms.values() {
            if r.body.kind == KIND_DIRECT {
                pinned.insert(&r.body.creator);
                pinned.insert(&r.body.peer_node);
            }
        }
        // 나간 개인채팅의 기록을 가진 노드도 잊지 않는다 — 잊으면 left 가 지워지고, 그 노드가 돌아와
        // 방을 다시 말할 때 자동으로 들어간다 (FR-ATF-52).
        for p in st.parts.values() {
            for id in &p.left {
                for (fp, n) in &st.nodes {
                    if n.rooms.contains_key(id) {
                        pinned.insert(fp);
                    }
                }
            }
        }
        let victim = st
            .nodes
            .iter()
            .filter(|(fp, _)| !reach.contains(*fp) && !pinned.contains(fp.as_str()))
            .min_by_key(|(_, r)| r.at)
            .map(|(fp, _)| fp.clone());
        let Some(victim) = victim else {
            return false;
        };
        // 번호 기억이 가득 찼고 밀어낼 수 있는 것(닿은 적 없거나 수명이 지난 번호)이 없으면 잊지
        // 않는다 — 수명 안의 닿은 노드의 번호를 밀어내면 그 노드의 옛 상태·글을 다시 받는다 (DIFF: Go
        // 는 가장 오래된 번호를 밀어낸다).
        let now = self.now();
        if st.marks.len() >= MAX_MARKS && junk_mark(st, now).is_none() {
            return false;
        }
        let Some(r) = st.nodes.remove(&victim) else {
            return false;
        };
        let mut m = Mark {
            epoch: r.st.epoch,
            state_seq: r.st.seq,
            msg_max: 0,
            at: now,
            reached: r.reached,
        };
        if let Some(w) = st.wins.remove(&victim)
            && w.epoch == r.st.epoch
        {
            m.msg_max = w.max;
        }
        remember_mark(st, victim, m, now);
        true
    }

    /// 처음 보는 바른 글을 받고, 이 노드의 그 방 참가자에게 넘길 것과 낸 노드를 돌려준다. 보낸
    /// 노드의 최신 상태에서 보낸 이가 그 방에 들어 있어야 하고, 개인채팅이면 두 참가자 중 하나여야
    /// 한다. 같은 글과 지난 글은 보낸 노드마다의 순서 창으로 거른다 (§3.9).
    fn accept_msg_locked(&self, st: &mut State, fr: &Frame) -> Option<(Vec<Pending>, String)> {
        let b: MsgBody = json::unmarshal(&fr.b.0).ok()?;
        if b.node == self.id.fingerprint || !valid_id(&b.id) || b.id.is_empty() {
            return None;
        }
        let r = st.nodes.get(&b.node)?;
        if b.epoch != r.st.epoch
            || !verify(&r.key, FRAME_MSG, &fr.b.0, &fr.s)
            || b.text.len() > MAX_TEXT
            || !valid_body(&b.text)
            || !part_in_room(&r.st, &b.from, &b.room)
        {
            return None;
        }
        if !record_locked(st, &b.room).is_some_and(|rm| party_ok(rm, &b.node, &b.from)) {
            return None;
        }
        let (label, kind) =
            r.st.parts()
                .iter()
                .rfind(|sp| sp.id == b.from)
                .map(|sp| (sp.label.clone(), sp.kind.clone()))
                .unwrap_or_default();
        let w = st.wins.entry(b.node.clone()).or_default();
        if !w.accept(b.epoch, b.seq) {
            return None;
        }
        let now = self.now();
        if !st.recv_rate.allow(&format!("{}/{}", b.node, b.from), now) {
            return None;
        }
        let out = self.local_deliveries_locked(st, &b, &label, &kind);
        Some((out, b.node))
    }
}

/// 가득 찬 번호 기억에서 밀어낼 것 — 밀어낼 수 있는 번호 가운데 가장 오래된 것이다. 규칙은 간선
/// 계층과 같다.
fn junk_mark(st: &State, now: OffsetDateTime) -> Option<String> {
    st.marks
        .iter()
        .filter(|(_, v)| mark_expendable(v.reached, v.at, now))
        .min_by_key(|(_, v)| v.at)
        .map(|(k, _)| k.clone())
}

fn remember_mark(st: &mut State, fp: String, m: Mark, now: OffsetDateTime) {
    if st.marks.len() >= MAX_MARKS
        && let Some(junk) = junk_mark(st, now)
    {
        st.marks.remove(&junk);
    }
    st.marks.insert(fp, m);
}
