use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::service::{
    KIND_DIRECT, Member, NodeInfo, OnlineView, Room, RoomInfo, Service, State, part_in_room,
    party_ok, record_locked,
};

pub(crate) fn sort_members(ms: &mut [Member]) {
    ms.sort_by(|a, b| a.label.cmp(&b.label).then_with(|| a.id.cmp(&b.id)));
}

impl Service {
    /// 자기에게서 닿는 노드다. 간선 계층의 망 정보로 판정한다 (EDGE_MESH_SRS FR-EGM-12·42). 간선
    /// 계층이 없으면 자기뿐이다.
    pub(crate) fn reachable(&self) -> Arc<HashSet<String>> {
        match &self.opts.mesh {
            Some(m) => m.reachable(),
            None => Arc::new(HashSet::from([self.id.fingerprint.clone()])),
        }
    }

    /// a·b 가 서로 이어졌는가다 — 양쪽의 서명된 망 정보가 서로를 담는다 (FR-EGM-43).
    pub(crate) fn mutual(&self, a: &str, b: &str) -> bool {
        self.opts.mesh.as_ref().is_some_and(|m| m.mutual(a, b))
    }

    /// 온라인 목록이다. 노드는 간선 계층이 아는 노드다 (EDGE_MESH_SRS FR-EGM-42). 닿지 않는 노드와
    /// 그 참가자는 online 이 거짓이다 (FR-PCH-3·30).
    pub fn online(&self) -> OnlineView {
        let nodes = match &self.opts.mesh {
            Some(m) => m
                .nodes()
                .into_iter()
                .map(|n| NodeInfo {
                    fp: n.fp,
                    name: n.name,
                    online: n.online,
                    self_: n.self_,
                })
                .collect(),
            None => vec![NodeInfo {
                fp: self.id.fingerprint.clone(),
                name: String::new(),
                online: true,
                self_: true,
            }],
        };
        let st = self.lock();
        let reach = self.reachable();
        let mut participants: Vec<Member> = st
            .parts
            .values()
            .map(|p| Member {
                id: p.p.id.clone(),
                label: p.p.label.clone(),
                kind: p.p.kind.clone(),
                node: self.id.fingerprint.clone(),
                online: true,
            })
            .collect();
        for (fp, r) in &st.nodes {
            participants.extend(r.st.parts().iter().map(|sp| Member {
                id: sp.id.clone(),
                label: sp.label.clone(),
                kind: sp.kind.clone(),
                node: fp.clone(),
                online: reach.contains(fp),
            }));
        }
        sort_members(&mut participants);
        OnlineView {
            nodes,
            participants,
        }
    }

    /// pid 에게 보이는 방이다. 방은 이 노드의 참가자나 닿는 노드의 참가자가 들어 있다고 말할 때만
    /// 있다(FR-PCH-21). 개인채팅은 두 참가자에게만 보인다(FR-PCH-15).
    pub fn rooms(&self, pid: &str) -> Vec<RoomInfo> {
        let st = self.lock();
        if !st.parts.contains_key(pid) {
            return Vec::new();
        }
        let claimed = self.claimed_locked(&st);
        let mut out: Vec<RoomInfo> = claimed
            .keys()
            .filter(|id| visible_in(&st, &claimed, pid, id).is_some())
            .map(|id| self.room_info_locked(&st, pid, id))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
        out
    }

    /// 지금 있는 방과 그 생성 기록이다.
    fn claimed_locked(&self, st: &State) -> HashMap<String, Room> {
        let mut out = st.rooms.clone();
        let reach = self.reachable();
        for (fp, r) in &st.nodes {
            if !reach.contains(fp) {
                continue;
            }
            for sp in r.st.parts() {
                for id in sp.rooms() {
                    if out.contains_key(id) {
                        continue;
                    }
                    if let Some(rm) = record_locked(st, id)
                        && party_ok(rm, fp, &sp.id)
                    {
                        out.insert(id.clone(), rm.clone());
                    }
                }
            }
        }
        out
    }

    pub(crate) fn visible_room_locked(&self, st: &State, pid: &str, id: &str) -> Option<Room> {
        visible_in(st, &self.claimed_locked(st), pid, id)
    }

    pub(crate) fn room_info_locked(&self, st: &State, pid: &str, id: &str) -> RoomInfo {
        let r = record_locked(st, id);
        let body = r.map(|r| r.body.clone()).unwrap_or_default();
        let mut info = RoomInfo {
            id: id.into(),
            creator_name: self.name_of(&body.creator),
            kind: body.kind.clone(),
            name: body.name.clone(),
            purpose: body.purpose.clone(),
            creator: body.creator.clone(),
            members: Vec::new(),
            joined: st.parts.get(pid).is_some_and(|p| p.rooms.contains(id)),
        };
        for p in st.parts.values() {
            if p.rooms.contains(id) {
                info.members.push(Member {
                    id: p.p.id.clone(),
                    label: p.p.label.clone(),
                    kind: p.p.kind.clone(),
                    node: self.id.fingerprint.clone(),
                    online: true,
                });
            }
        }
        let reach = self.reachable();
        let zero = Room {
            rec: Default::default(),
            body,
        };
        for (fp, n) in &st.nodes {
            for sp in n.st.parts() {
                if part_in_room(&n.st, &sp.id, id) && party_ok(r.unwrap_or(&zero), fp, &sp.id) {
                    info.members.push(Member {
                        id: sp.id.clone(),
                        label: sp.label.clone(),
                        kind: sp.kind.clone(),
                        node: fp.clone(),
                        online: reach.contains(fp),
                    });
                }
            }
        }
        sort_members(&mut info.members);
        info
    }
}

/// 이미 만든 방 명단 claimed 로 본, pid 에게 보이는 방이다 (FR-ATF-55).
fn visible_in(st: &State, claimed: &HashMap<String, Room>, pid: &str, id: &str) -> Option<Room> {
    let r = claimed.get(id)?;
    if r.body.kind == KIND_DIRECT {
        if pid != r.body.owner && pid != r.body.peer {
            return None;
        }
        if st.parts.get(pid).is_some_and(|p| p.left.contains(id)) {
            return None;
        }
    }
    Some(r.clone())
}
