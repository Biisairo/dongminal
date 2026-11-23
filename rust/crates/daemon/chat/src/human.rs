//! PEER_CHAT_SRS §3.12 — 사람 명령(강제 삭제·강퇴). 도우미가 서명한 묶음을 `cmd` 프레임으로
//! 퍼뜨리고, 받은 노드는 그 노드의 도우미 키를 믿을 때만 자기 참가자에게 적용한다.

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use base64::Engine;
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use dm_gocompat::json::RawMessage;
use dm_shared_edge::Edge;
use dm_shared_edgemesh::Frame;
use dm_shared_humancmd::{self as humancmd, Body, OP_KICK, OP_KILL, Signed};
use dm_shared_termtext::{self as termtext, FP_SHORT};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::error::{CODE_BAD_REQUEST, Error};
use crate::frame::FRAME_CMD;
use crate::service::{Service, State, leave_locked};

/// 명령 시각과 받는 노드 시각의 허용 차이다.
const CMD_WINDOW: Duration = Duration::from_secs(5 * 60);
/// 본 명령 해시를 기억하는 시간, MAX_SEEN_CMDS 는 그 수의 상한이다.
const CMD_SEEN_FOR: Duration = Duration::from_secs(10 * 60);
const MAX_SEEN_CMDS: usize = 4096;
/// 간선 목록 캐시를 믿는 시간이다.
const EDGE_CACHE_FOR: Duration = Duration::from_secs(1);
const ED25519_PUBLIC_KEY_SIZE: usize = 32;
const NANOS_PER_MILLI: i128 = 1_000_000;

/// Go `base64.StdEncoding.DecodeString`: 남는 비트는 받고 `\r`·`\n` 은 건너뛴다.
const GO_STD: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

/// 빈 값이거나 32바이트 Ed25519 공개키의 base64 인지 본다.
pub(crate) fn valid_helper_key(k: &str) -> bool {
    if k.is_empty() {
        return true;
    }
    let clean: Vec<u8> = k.bytes().filter(|b| !matches!(b, b'\r' | b'\n')).collect();
    GO_STD
        .decode(clean)
        .is_ok_and(|raw| raw.len() == ED25519_PUBLIC_KEY_SIZE)
}

/// 고정값이 하나 이상이고 모두 같을 때 그 값이다.
pub(crate) fn agreed(pins: &[String]) -> Option<String> {
    let first = pins.first()?;
    pins.iter().all(|k| k == first).then(|| first.clone())
}

fn cmd_hash(b: &RawMessage, sig: &str) -> String {
    let mut h = Sha256::new();
    h.update(&b.0);
    h.update(sig.as_bytes());
    hex::encode(h.finalize())
}

fn in_window(now: OffsetDateTime, at_ms: i64) -> bool {
    let at = i128::from(at_ms) * NANOS_PER_MILLI;
    let now = now.unix_timestamp_nanos();
    let w = CMD_WINDOW.as_nanos() as i128;
    at >= now - w && at <= now + w
}

/// 본 것 하나를 기억한다. CMD_SEEN_FOR 가 지난 것은 잊고, 상한을 넘으면 가장 오래된 것을 잊는다.
fn remember(m: &mut HashMap<String, OffsetDateTime>, k: String, now: OffsetDateTime) {
    m.retain(|_, at| now - *at <= CMD_SEEN_FOR);
    if m.len() >= MAX_SEEN_CMDS
        && let Some(oldest) = m.iter().min_by_key(|(_, at)| **at).map(|(x, _)| x.clone())
    {
        m.remove(&oldest);
    }
    m.insert(k, now);
}

impl Service {
    /// 이 노드의 지문이다.
    pub fn node(&self) -> &str {
        &self.id.fingerprint
    }

    /// 이 노드의 도우미 공개키를 싣는다. 빈 값은 도우미가 없다는 뜻이다. 바뀌면 상태를 다시
    /// 알린다.
    pub fn set_helper(&self, key: &str) {
        let mut st = self.lock();
        if st.helper_key == key {
            return;
        }
        st.helper_key = key.to_string();
        self.changed_locked(&mut st);
    }

    /// 이 노드의 도우미 공개키다. 없으면 빈 값이다.
    pub fn helper_key(&self) -> String {
        self.lock().helper_key.clone()
    }

    /// 이 노드의 도우미가 서명한 명령을 자기에게 적용하고 모든 연결로 낸다. 서명 본문의 키를 이
    /// 노드의 도우미 키로 싣는다 — 부르는 쪽(chatsock)이 root 가 만든 도우미 소켓에서 받은
    /// 서명이다. 키 싣기와 적용을 한 잠금 안에서 해 도우미 확인 루프와 엇갈리지 않는다 (§3.12a R-3).
    pub fn command(&self, sg: &Signed) -> Result<(), Error> {
        let b = humancmd::open(sg)
            .map_err(|_| Error::fail(CODE_BAD_REQUEST, "human command signature"))?;
        let mut st = self.lock();
        if b.node != self.id.fingerprint {
            return Err(Error::fail(CODE_BAD_REQUEST, "not this node's command"));
        }
        let h = cmd_hash(&sg.b, &sg.s);
        let now = self.now();
        if st.cmds.contains_key(&h) || !in_window(now, b.at) {
            return Err(Error::fail(CODE_BAD_REQUEST, "stale human command"));
        }
        st.helper_key = b.key.clone();
        remember(&mut st.cmds, h, now);
        apply_cmd_locked(&mut st, &b);
        self.broadcast_locked(
            &Frame {
                t: FRAME_CMD.into(),
                b: sg.b.clone(),
                s: sg.s.clone(),
            },
            "",
        );
        self.changed_locked(&mut st);
        Ok(())
    }

    /// 서명이 맞고 시각 안의 처음 보는 명령을 그 노드의 믿는 도우미 키(D-PCH-39)로 확인했을 때만
    /// 적용하고 넘기라고(참) 답한다. 믿지 못한 명령은 기억하지도 넘기지도 않고 버린다
    /// (ATTIC_FIX_SRS FR-ATF-79 · AT-CHAT-9). 본 것은 id 가 아니라 서명된 프레임 전체의 해시로
    /// 기억한다. 같은 id 를 단 가짜가 먼저 와도 진짜를 막지 못한다.
    pub(crate) fn accept_cmd_locked(&self, st: &mut State, fr: &Frame) -> bool {
        let sg = Signed {
            b: fr.b.clone(),
            s: fr.s.clone(),
        };
        let Ok(b) = humancmd::open(&sg) else {
            return false;
        };
        let now = self.now();
        if b.node == self.id.fingerprint || !in_window(now, b.at) {
            return false;
        }
        let h = cmd_hash(&fr.b, &fr.s);
        if st.cmds.contains_key(&h) {
            return false;
        }
        match self.trusted_key_locked(st, &b.node) {
            Some(key) if key == b.key => {}
            _ => return false,
        }
        remember(&mut st.cmds, h, now);
        apply_cmd_locked(st, &b);
        true
    }

    /// 노드 node 의 믿는 도우미 키다 (FR-PCH-74, D-PCH-39). 자기는 자기 도우미 키, 간선 상대는
    /// 고정한 키다. 망 이웃은 그 노드와 서로 이어진(EDGE_MESH_SRS FR-EGM-43) 닿는 노드들, 곧 그
    /// 노드의 간선 상대들이 알린 고정값이 모두 같고 그 노드 자신이 알린 helper 와도 같을 때 그
    /// 키다. 간선이 아닌 노드의 고정값은 세지 않는다.
    pub(crate) fn trusted_key_locked(&self, st: &mut State, node: &str) -> Option<String> {
        if node == self.id.fingerprint {
            return (!st.helper_key.is_empty()).then(|| st.helper_key.clone());
        }
        if let Some(e) = self.edge_locked(st, node) {
            return (!e.helper_key.is_empty()).then_some(e.helper_key);
        }
        let target = st.nodes.get(node)?;
        if target.st.helper.is_empty() {
            return None;
        }
        let reach = self.reachable();
        let pins: Vec<String> = st
            .nodes
            .iter()
            .filter(|(fp, _)| fp.as_str() != node && reach.contains(*fp) && self.mutual(fp, node))
            .filter_map(|(_, r)| r.st.pin(node).cloned())
            .collect();
        agreed(&pins).filter(|k| *k == target.st.helper)
    }

    /// 간선 목록의 캐시다. 상태를 받을 때마다 간선 설정을 복사하지 않도록, 1초가 넘은 캐시만
    /// 다시 읽는다. 고정한 뒤에는 바로 다시 읽는다 (§3.12a R-9).
    pub(crate) fn edges_locked(&self, st: &mut State) -> Vec<Edge> {
        let Some(edges) = &self.opts.edges else {
            return Vec::new();
        };
        let now = self.now();
        if st.edge_cache.is_none() || now - st.edge_at > EDGE_CACHE_FOR {
            st.edge_cache = Some(edges());
            st.edge_at = now;
        }
        st.edge_cache.clone().unwrap_or_default()
    }

    fn edge_locked(&self, st: &mut State, fp: &str) -> Option<Edge> {
        self.edges_locked(st)
            .into_iter()
            .find(|e| e.fingerprint == fp)
    }

    /// 상태 알림에 싣는 간선 상대의 고정값이다.
    pub(crate) fn pins_locked(&self, st: &mut State) -> Option<BTreeMap<String, String>> {
        let out: BTreeMap<String, String> = self
            .edges_locked(st)
            .into_iter()
            .filter(|e| !e.helper_key.is_empty())
            .map(|e| (e.fingerprint, e.helper_key))
            .collect();
        (!out.is_empty()).then_some(out)
    }

    /// 간선 상대 자신이 그 연결로 보낸 상태에 도우미 키가 있고 아직 고정하지 않았으면, 잠금 밖에서
    /// 고정할 (fp, key) 를 돌려준다. 고정한 값과 다르면 바꾸지 않고 한 번 경고한다.
    pub(crate) fn pin_locked(&self, st: &mut State, fp: &str) -> Option<(String, String)> {
        if fp.is_empty() || self.opts.pin.is_none() {
            return None;
        }
        let key = st.nodes.get(fp).map(|r| r.st.helper.clone())?;
        if key.is_empty() {
            return None;
        }
        let e = match self.edge_locked(st, fp) {
            Some(e) => Some(e),
            None => {
                // 자기 연결로 상태를 보낸 상대는 간선이다 — 없다면 캐시가 그 간선보다 낡았다. 간선
                // 계층이 linked(캐시 비우기)와 읽기 루프를 따로 띄우므로 이 상태가 먼저 올 수 있다.
                // 한 번 새로 읽는다.
                st.edge_cache = None;
                self.edge_locked(st, fp)
            }
        };
        let e = e?;
        if e.helper_key == key {
            return None;
        }
        if !e.helper_key.is_empty() {
            if st.warned.get(fp) != Some(&key) {
                st.warned.insert(fp.to_string(), key);
                dm_shared_dmlog::warnf!(
                    None,
                    "chat: 간선 상대 {} 의 도우미 키가 고정한 값과 다르다 — 그 노드의 사람 명령을 받지 않는다. 다시 고정하려면 간선을 다시 맺는다",
                    termtext::cut(fp, FP_SHORT)
                );
            }
            return None;
        }
        Some((fp.to_string(), key))
    }

    pub(crate) fn apply_pin(&self, fp: &str, key: &str) {
        if let Some(pin) = &self.opts.pin {
            pin(fp, key);
        }
        let mut st = self.lock();
        st.edge_cache = None;
        self.announce_locked(&mut st);
    }
}

/// 명령을 이 노드의 참가자에게만 적용한다 (FR-PCH-20·70). 기록을 남기지 않는다.
fn apply_cmd_locked(st: &mut State, b: &Body) {
    match b.op.as_str() {
        OP_KILL => {
            for id in &b.rooms {
                let pids: Vec<String> = st
                    .parts
                    .values()
                    .filter(|p| p.rooms.contains(id))
                    .map(|p| p.p.id.clone())
                    .collect();
                for pid in pids {
                    leave_locked(st, &pid, id);
                }
            }
        }
        OP_KICK => {
            for k in &b.kicks {
                if st
                    .parts
                    .get(&k.participant)
                    .is_some_and(|p| p.rooms.contains(&k.room))
                {
                    leave_locked(st, &k.participant, &k.room);
                }
            }
        }
        _ => {}
    }
}
