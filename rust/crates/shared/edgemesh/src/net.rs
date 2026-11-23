use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use dm_gocompat::json;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::frame::{FRAME_NET, Frame, encode, parse_key, sign_frame, verify};
use crate::mesh::{Inner, Link, Mesh, State};

/// 아는 노드의 상한이다. 넘으면 닿지 않는 노드부터 잊는다 (FR-EGM-13).
pub(crate) const MAX_NODES: usize = 256;
/// 잊은 노드의 마지막 번호를 기억하는 수다.
const MAX_MARKS: usize = 4096;
/// 이름의 바이트 상한이다 (FR-EGM-11).
const MAX_NAME: usize = 64 * 4;

fn links_empty(l: &Option<Vec<String>>) -> bool {
    l.as_ref().is_none_or(Vec::is_empty)
}

/// 망 정보다 (FR-EGM-10). 노드는 자기에 대해서만 말한다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "edgemesh.netBody")]
pub(crate) struct NetBody {
    pub node: String,
    pub key: String,
    pub name: String,
    pub epoch: i64,
    pub seq: u64,
    #[serde(skip_serializing_if = "links_empty")]
    pub links: Option<Vec<String>>,
}

impl NetBody {
    fn links(&self) -> &[String] {
        self.links.as_deref().unwrap_or_default()
    }
}

pub(crate) struct Remote {
    pub st: NetBody,
    pub key: p256::PublicKey,
    pub raw: Frame,
    /// 이 노드의 망 정보를 마지막으로 받은 때다.
    pub at: OffsetDateTime,
}

pub(crate) struct Mark {
    epoch: i64,
    seq: u64,
    at: OffsetDateTime,
}

/// 망 정보다. Mesh 의 잠금이 지킨다.
pub(crate) struct NetState {
    pub epoch: i64,
    pub seq: u64,
    pub own: Frame,
    own_content: Vec<u8>,
    pub nodes: HashMap<String, Remote>,
    pub marks: HashMap<String, Mark>,
    /// 온라인 판정의 캐시다. 바뀔 때 새 집합으로 갈아 끼운다 — 내준 집합은 바꾸지 않는다.
    pub reach: Option<Arc<HashSet<String>>>,
}

impl NetState {
    pub fn new(now: OffsetDateTime) -> Self {
        Self {
            epoch: i64::try_from(now.unix_timestamp_nanos()).unwrap_or(i64::MAX),
            seq: 0,
            own: Frame::default(),
            own_content: Vec::new(),
            nodes: HashMap::new(),
            marks: HashMap::new(),
            reach: None,
        }
    }
}

/// 망의 노드 하나다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NodeInfo {
    pub fp: String,
    pub name: String,
    pub online: bool,
    pub self_: bool,
}

/// 망 그림이다. `links` 는 서로 이어진 두 노드의 쌍이다 (FR-EGM-61).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct View {
    pub nodes: Vec<NodeInfo>,
    pub links: Vec<[String; 2]>,
}

fn newer(st: &NetBody, epoch: i64, seq: u64) -> bool {
    st.epoch > epoch || st.epoch == epoch && st.seq > seq
}

fn valid_net(st: &NetBody) -> bool {
    st.links().len() <= MAX_NODES && dm_shared_termtext::line(&st.name, MAX_NAME)
}

impl Inner {
    /// 자기 망 정보의 내용이 바뀌었을 때만 새 net 을 만들어 skip 을 뺀 모든 연결로 보낸다
    /// (FR-EGM-10).
    pub(crate) fn announce_locked(&self, st: &mut State, skip: Option<&Arc<Link>>) {
        let mut body = NetBody {
            node: self.id.fingerprint.clone(),
            key: self.key.clone(),
            name: self.name(),
            epoch: 0,
            seq: 0,
            links: Some(open_links(st)),
        };
        let content = json::marshal(&body).unwrap_or_default();
        if !st.net.own.t.is_empty() && content == st.net.own_content {
            return;
        }
        st.net.own_content = content;
        st.net.seq += 1;
        body.epoch = st.net.epoch;
        body.seq = st.net.seq;
        let Ok(fr) = sign_frame(&self.id, FRAME_NET, &body) else {
            return;
        };
        let line = encode(&fr);
        st.net.own = fr;
        broadcast_locked(st, &line, skip);
        self.topology_locked(st);
    }

    /// 온라인 캐시를 버리고 바뀜을 알린다.
    pub(crate) fn topology_locked(&self, st: &mut State) {
        st.net.reach = None;
        self.poke();
    }

    /// 바르고 더 새로운 망 정보만 받는다 (FR-EGM-11·13).
    pub(crate) fn accept_net_locked(&self, st: &mut State, fr: &Frame) -> bool {
        let Ok(body) = json::unmarshal::<NetBody>(&fr.b.0) else {
            return false;
        };
        if body.node == self.id.fingerprint {
            return false;
        }
        let Some(pub_key) = parse_key(&body.node, &body.key) else {
            return false;
        };
        if !verify(&pub_key, FRAME_NET, &fr.b.0, &fr.s) || !valid_net(&body) {
            return false;
        }
        if let Some(old) = st.net.nodes.get(&body.node) {
            if !newer(&body, old.st.epoch, old.st.seq) {
                return false;
            }
        } else {
            if let Some(mk) = st.net.marks.get(&body.node)
                && !newer(&body, mk.epoch, mk.seq)
            {
                return false;
            }
            if st.net.nodes.len() >= st.max_nodes && !self.evict_locked(st) {
                return false;
            }
            st.net.marks.remove(&body.node);
        }
        let node = body.node.clone();
        st.net.nodes.insert(
            node,
            Remote {
                st: body,
                key: pub_key,
                raw: fr.clone(),
                at: self.now(),
            },
        );
        true
    }

    /// 닿지 않는 노드 가운데 가장 오래 소식이 없는 것을 잊고 그 마지막 번호를 남긴다. 잊을 것이
    /// 없으면 거짓이다.
    fn evict_locked(&self, st: &mut State) -> bool {
        let reach = self.reachable_locked(st);
        let victim = st
            .net
            .nodes
            .iter()
            .filter(|(fp, _)| !reach.contains(*fp))
            .min_by_key(|(_, r)| r.at)
            .map(|(fp, _)| fp.clone());
        let Some(victim) = victim else {
            return false;
        };
        if st.net.marks.len() >= MAX_MARKS
            && let Some(oldest) = st
                .net
                .marks
                .iter()
                .min_by_key(|(_, m)| m.at)
                .map(|(k, _)| k.clone())
        {
            st.net.marks.remove(&oldest);
        }
        if let Some(r) = st.net.nodes.remove(&victim) {
            st.net.marks.insert(
                victim.clone(),
                Mark {
                    epoch: r.st.epoch,
                    seq: r.st.seq,
                    at: self.now(),
                },
            );
        }
        st.inv.forget_sender(&victim);
        st.net.reach = None;
        true
    }

    fn links_of<'a>(&self, st: &'a State, fp: &str, own: &'a [String]) -> &'a [String] {
        if fp == self.id.fingerprint {
            return own;
        }
        st.net.nodes.get(fp).map_or(&[], |r| r.st.links())
    }

    /// a·b 가 서로를 자기 links 에 담는가다 (FR-EGM-12).
    pub(crate) fn mutual_locked(&self, st: &State, a: &str, b: &str) -> bool {
        let own = open_links(st);
        self.links_of(st, a, &own).iter().any(|x| x == b)
            && self.links_of(st, b, &own).iter().any(|x| x == a)
    }

    /// 자기에게서 서로 이어진 간선으로 닿는 노드다 (FR-EGM-12).
    pub(crate) fn reachable_locked(&self, st: &mut State) -> Arc<HashSet<String>> {
        if let Some(r) = &st.net.reach {
            return r.clone();
        }
        let own = open_links(st);
        let me = self.id.fingerprint.clone();
        let mut seen = HashSet::from([me.clone()]);
        let mut queue = VecDeque::from([me]);
        while let Some(cur) = queue.pop_front() {
            for next in self.links_of(st, &cur, &own) {
                if !seen.contains(next) && self.links_of(st, next, &own).contains(&cur) {
                    seen.insert(next.clone());
                    queue.push_back(next.clone());
                }
            }
        }
        let seen = Arc::new(seen);
        st.net.reach = Some(seen.clone());
        seen
    }
}

/// 위층이 연 연결의 상대다. 열기 전의 연결은 망 정보와 온라인 판정에 넣지 않는다 — 온라인으로
/// 보이면 위층의 글이 그 연결로 간다 (FR-EGM-6).
pub(crate) fn open_links(st: &State) -> Vec<String> {
    let mut out: Vec<String> = st
        .links
        .iter()
        .filter(|(_, l)| l.is_open())
        .map(|(fp, _)| fp.clone())
        .collect();
    out.sort();
    out
}

/// 간선 계층의 줄을 skip 을 뺀 모든 연결로 보낸다. 위층이 열기 전의 연결도 받는다 — 간선
/// 계층의 프레임은 위층의 순서와 무관하다.
pub(crate) fn broadcast_locked(st: &State, line: &[u8], skip: Option<&Arc<Link>>) {
    for l in st.links.values() {
        if skip.is_none_or(|s| !Arc::ptr_eq(s, l)) {
            l.send(line.to_vec(), None);
        }
    }
}

impl Mesh {
    /// 이름이 바뀌었을 때 부른다. 바뀌었으면 새 net 을 퍼뜨린다.
    pub fn announce(&self) {
        let mut st = self.inner.lock();
        self.inner.announce_locked(&mut st, None);
    }

    /// 온라인 노드(자기 포함)다.
    pub fn reachable(&self) -> Arc<HashSet<String>> {
        let mut st = self.inner.lock();
        self.inner.reachable_locked(&mut st)
    }

    /// a·b 가 서로 이어졌는가다 (FR-EGM-12, FR-EGM-43).
    pub fn mutual(&self, a: &str, b: &str) -> bool {
        let st = self.inner.lock();
        self.inner.mutual_locked(&st, a, b)
    }

    /// 노드 fp 의 이름이다. 모르면 `None` 이다.
    pub fn name_of(&self, fp: &str) -> Option<String> {
        if fp == self.inner.id.fingerprint {
            return Some(self.inner.name());
        }
        let st = self.inner.lock();
        st.net.nodes.get(fp).map(|r| r.st.name.clone())
    }

    /// 아는 노드다. 자기가 맨 앞이고 나머지는 이름·지문 순이다.
    pub fn nodes(&self) -> Vec<NodeInfo> {
        let name = self.inner.name();
        let mut st = self.inner.lock();
        let reach = self.inner.reachable_locked(&mut st);
        let mut rest: Vec<NodeInfo> = st
            .net
            .nodes
            .iter()
            .map(|(fp, r)| NodeInfo {
                fp: fp.clone(),
                name: r.st.name.clone(),
                online: reach.contains(fp),
                self_: false,
            })
            .collect();
        rest.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.fp.cmp(&b.fp)));
        let mut out = vec![NodeInfo {
            fp: self.inner.id.fingerprint.clone(),
            name,
            online: true,
            self_: true,
        }];
        out.extend(rest);
        out
    }

    /// 망 그림이다. 연결 끊김 노드의 마지막 망 정보도 쓴다 (FR-EGM-61).
    pub fn view(&self) -> View {
        let nodes = self.nodes();
        let st = self.inner.lock();
        let mut links = Vec::new();
        for (i, a) in nodes.iter().enumerate() {
            for b in &nodes[i + 1..] {
                if self.inner.mutual_locked(&st, &a.fp, &b.fp) {
                    let mut p = [a.fp.clone(), b.fp.clone()];
                    if p[1] < p[0] {
                        p.swap(0, 1);
                    }
                    links.push(p);
                }
            }
        }
        drop(st);
        links.sort();
        View { nodes, links }
    }
}
