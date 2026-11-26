use std::collections::BTreeMap;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_edge::Identity;
use otter_shared_edgemesh::{parse_key, public_key, sign, verify};
use otter_shared_termtext as termtext;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::error::Error;
use crate::service::{ID_PREFIX, KIND_DIRECT, KIND_GROUP, MAX_ID, MAX_NAME, MAX_PURPOSE};

// 프레임 종류다 (§3.9). 기록 서명은 프레임이 아니지만 같은 서명 방식을 쓴다.
pub(crate) const FRAME_STATE: &str = "state";
pub(crate) const FRAME_MSG: &str = "msg";
pub(crate) const FRAME_CMD: &str = "cmd";
const SIGN_RECORD: &str = "room";

fn no_strings(v: &Option<Vec<String>>) -> bool {
    v.as_ref().is_none_or(Vec::is_empty)
}

/// 노드 상태 알림의 참가자 하나다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chat.statePart")]
pub(crate) struct StatePart {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(skip_serializing_if = "no_strings")]
    pub rooms: Option<Vec<String>>,
}

impl StatePart {
    pub fn rooms(&self) -> &[String] {
        self.rooms.as_deref().unwrap_or_default()
    }
}

/// 노드 상태 알림이다 (FR-PCH-9). 노드는 자기에 대해서만 말한다. 이름과 간선 연결은 간선 계층의
/// 망 정보에 있다 (EDGE_MESH_SRS FR-EGM-41).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chat.stateBody")]
pub(crate) struct StateBody {
    pub node: String,
    pub key: String,
    pub epoch: i64,
    pub seq: u64,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub parts: Option<Vec<StatePart>>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub rooms: Option<Vec<SignedRecord>>,
    /// 이 노드의 도우미 공개키, pins 는 간선 상대 지문 → 고정한 도우미 공개키다 (§3.12).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub helper: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub pins: Option<BTreeMap<String, String>>,
}

impl StateBody {
    pub fn parts(&self) -> &[StatePart] {
        self.parts.as_deref().unwrap_or_default()
    }

    pub fn records(&self) -> &[SignedRecord] {
        self.rooms.as_deref().unwrap_or_default()
    }

    pub fn pin(&self, fp: &str) -> Option<&String> {
        self.pins.as_ref().and_then(|p| p.get(fp))
    }
}

/// 글 하나다. (epoch, seq) 가 보낸 노드 안의 순서다 (FR-PCH-32).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chat.msgBody")]
pub(crate) struct MsgBody {
    pub id: String,
    pub node: String,
    pub epoch: i64,
    pub seq: u64,
    pub room: String,
    pub from: String,
    pub text: String,
    #[serde(with = "otter_gocompat::time::json_time")]
    pub at: OffsetDateTime,
    /// 지정 (ISSUE_TREE_CHAT_SRS FR-CAL-1). 비면 원문에 싣지 않는다 — 옛 노드의 글과 원문이 같다.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub call: Vec<String>,
}

impl Default for MsgBody {
    fn default() -> Self {
        Self {
            id: String::new(),
            node: String::new(),
            epoch: 0,
            seq: 0,
            room: String::new(),
            from: String::new(),
            text: String::new(),
            at: otter_gocompat::time::zero_time(),
            call: Vec::new(),
        }
    }
}

/// 방의 생성 기록이다 (FR-PCH-10·14). key 는 만든 노드의 공개키라서, 만든 노드를 모르는 노드도
/// 기록 하나로 서명을 확인한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chat.recordBody")]
pub(crate) struct RecordBody {
    pub kind: String,
    pub creator: String,
    pub key: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub owner: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub peer: String,
    /// 개인채팅 상대가 있는 노드다. 두 참가자를 각자의 노드에 묶는다.
    #[serde(rename = "peerNode", skip_serializing_if = "String::is_empty")]
    pub peer_node: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub purpose: String,
    #[serde(with = "otter_gocompat::time::json_time")]
    pub created: OffsetDateTime,
    pub nonce: String,
}

impl Default for RecordBody {
    fn default() -> Self {
        Self {
            kind: String::new(),
            creator: String::new(),
            key: String::new(),
            owner: String::new(),
            peer: String::new(),
            peer_node: String::new(),
            name: String::new(),
            purpose: String::new(),
            created: otter_gocompat::time::zero_time(),
            nonce: String::new(),
        }
    }
}

/// 생성 기록 원문과 서명이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "chat.signedRecord")]
pub(crate) struct SignedRecord {
    pub b: RawMessage,
    pub s: String,
}

impl SignedRecord {
    /// 방 id — 생성 기록 원문의 SHA-256 이다 (FR-PCH-10).
    pub fn id(&self) -> String {
        hex::encode(Sha256::digest(&self.b.0))
    }
}

/// id 의 노드가 서명한 생성 기록이다. 만든 노드와 키는 id 로 채운다.
pub(crate) fn new_record(id: &Identity, mut b: RecordBody) -> Result<SignedRecord, Error> {
    b.creator = id.fingerprint.clone();
    b.key = public_key(id);
    let body = json::marshal(&b).map_err(Error::plain)?;
    let s = sign(id, SIGN_RECORD, &body).map_err(Error::plain)?;
    Ok(SignedRecord {
        b: RawMessage(body),
        s,
    })
}

/// 서명과 내용이 바른 생성 기록을 푼다 (FR-PCH-10·11).
pub(crate) fn open_record(r: &SignedRecord) -> Option<RecordBody> {
    let b: RecordBody = json::unmarshal(&r.b.0).ok()?;
    let key = parse_key(&b.creator, &b.key)?;
    if !verify(&key, SIGN_RECORD, &r.b.0, &r.s) {
        return None;
    }
    let ok = match b.kind.as_str() {
        KIND_GROUP => termtext::line(&b.name, MAX_NAME) && !b.name.is_empty() && b.peer.is_empty(),
        // 개인채팅 기록은 이름을 싣지 않는다 — 검사하지 않은 이름이 화면·도구 결과에 찍히지 않게 한다
        // (DIFF: Go 는 direct 의 name 을 보지 않는다).
        KIND_DIRECT => {
            b.name.is_empty()
                && b.owner != b.peer
                && bound_to(&b.owner, &b.creator)
                && bound_to(&b.peer, &b.peer_node)
        }
        _ => false,
    };
    (ok && termtext::line(&b.purpose, MAX_PURPOSE) && valid_id(&b.owner) && valid_id(&b.peer))
        .then_some(b)
}

pub(crate) fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::fill(&mut b[..]);
    hex::encode(b)
}

/// 글 본문인지 본다. 줄바꿈과 탭만 받고 다른 제어 문자는 받지 않는다 — 본문은 도구 결과와 화면에
/// 찍힌다.
pub(crate) fn valid_body(s: &str) -> bool {
    s.chars()
        .all(|r| r == '\n' || r == '\t' || !termtext::hidden(r))
}

/// 참가자 id 가 노드 node 에 묶였는지 — id 가 그 지문 앞자리로 시작하는지다.
pub(crate) fn bound_to(pid: &str, node: &str) -> bool {
    node.len() >= ID_PREFIX
        && pid.len() > ID_PREFIX
        && pid.as_bytes()[..ID_PREFIX] == node.as_bytes()[..ID_PREFIX]
        && pid.as_bytes()[ID_PREFIX] == b'-'
}

/// 참가자·글 id 모양(짧은 hex 같은 값)인지 본다. 빈 값도 받는다.
pub(crate) fn valid_id(s: &str) -> bool {
    s.len() <= MAX_ID
        && s.chars()
            .all(|r| r.is_ascii_alphanumeric() || r == '-' || r == '_')
}
