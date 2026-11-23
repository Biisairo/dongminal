use std::collections::HashMap;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use dm_gocompat::json;
use dm_shared_edge::{INVITE_TTL, Identity, decode_invite};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::error::{ErrorKind, MeshError};
use crate::frame::{
    FRAME_INVITE, Frame, encode, parse_key, random_hex, secret_key, sign_frame, std_decode, verify,
};
use crate::mesh::{Inner, Mesh, State};
use crate::net::{MAX_NODES, broadcast_locked};

/// 받은 초대 id 기억에서 보낸 노드 하나가 차지할 수 있는 수다. 보낸 노드는 서명을 그 노드의
/// 키로 확인한 아는 노드다. 받은 초대 id 를 기억하는 수(FR-EGM-33)는 아는 노드 전부가 제 몫을
/// 채워도 넘치지 않게 둘의 곱이다. 이 노드가 보낸 초대 id 는 따로 센다 (FR-ATF-51).
pub(crate) const MAX_SEEN_PER_SENDER: usize = 16;
pub(crate) const MAX_SEEN_INVITES: usize = MAX_NODES * MAX_SEEN_PER_SENDER;
pub(crate) const MAX_SENT_INVITES: usize = 1024;
/// 초대 시각이 지금보다 앞설 수 있는 상한이다.
const INVITE_SKEW: Duration = Duration::from_secs(5 * 60);
/// 초대 상자 키의 HKDF info 머리다 (FR-EGM-32).
const INVITE_INFO: &str = "dmlink1 invite";
pub(crate) const INVITE_ID_BYTES: usize = 16;
const GCM_NONCE_BYTES: usize = 12;
const BOX_KEY_BYTES: usize = 32;
const NANOS_PER_MILLI: i128 = 1_000_000;

/// 간선 초대 프레임의 본문이다 (FR-EGM-33). `sealed` 는 받을 노드만 연다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "edgemesh.inviteBody")]
pub(crate) struct InviteBody {
    pub id: String,
    pub from: String,
    pub to: String,
    pub at: i64,
    pub exp: i64,
    #[serde(rename = "box")]
    pub sealed: String,
}

/// 이 노드에게 온, 열린 간선 초대다 (FR-EGM-34).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invite {
    pub id: String,
    pub from: String,
    pub name: String,
    pub code: String,
    pub expires: OffsetDateTime,
}

#[derive(Clone)]
pub(crate) struct SeenInvite {
    pub exp: OffsetDateTime,
    pub from: String,
}

/// 본 초대 id 와 그 만료다. seen 은 받은 것, per_sender 는 보낸 노드마다 seen 에 든 수, mine 은
/// 이 노드가 보낸 것이다. Mesh 의 잠금이 지킨다.
#[derive(Default)]
pub(crate) struct InviteState {
    pub seen: HashMap<String, SeenInvite>,
    pub per_sender: HashMap<String, usize>,
    pub mine: HashMap<String, OffsetDateTime>,
}

impl InviteState {
    fn forget_seen(&mut self, id: &str, from: &str) {
        self.seen.remove(id);
        if let Some(n) = self.per_sender.get_mut(from) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                self.per_sender.remove(from);
            }
        }
    }

    /// 잊은 노드 from 이 보낸 초대 id 를 잊는다. 받은 초대 기억은 늘 아는 노드 수 ×
    /// MAX_SEEN_PER_SENDER 를 넘지 않는다. 다시 알려진 뒤에는 만료 전 옛 초대를 한 번 더 받을 수
    /// 있다 (FR-ATF-51).
    pub(crate) fn forget_sender(&mut self, from: &str) {
        if self.per_sender.get(from).copied().unwrap_or(0) == 0 {
            return;
        }
        self.seen.retain(|_, e| e.from != from);
        self.per_sender.remove(from);
    }

    /// from 이 보낸 초대 id 를 만료까지 기억한다. 전체나 from 의 몫이 차면 만료된 것을 잊고, 그래도
    /// 차 있으면 기억하지 않고 거짓을 돌려준다 — 만료 전 항목을 밀어내면 옛 초대가 다시 뜬다
    /// (FR-ATF-51).
    fn remember_seen(
        &mut self,
        id: &str,
        from: &str,
        exp: OffsetDateTime,
        now: OffsetDateTime,
    ) -> bool {
        let full = |s: &Self| {
            s.seen.len() >= MAX_SEEN_INVITES
                || s.per_sender.get(from).copied().unwrap_or(0) >= MAX_SEEN_PER_SENDER
        };
        if full(self) {
            let expired: Vec<(String, String)> = self
                .seen
                .iter()
                .filter(|(_, e)| e.exp <= now)
                .map(|(k, e)| (k.clone(), e.from.clone()))
                .collect();
            for (k, f) in expired {
                self.forget_seen(&k, &f);
            }
            if full(self) {
                return false;
            }
        }
        self.seen.insert(
            id.to_string(),
            SeenInvite {
                exp,
                from: from.to_string(),
            },
        );
        *self.per_sender.entry(from.to_string()).or_insert(0) += 1;
        true
    }

    /// 이 노드가 보낸 초대 id 를 만료까지 기억한다. 받은 초대와 따로 센다.
    fn remember_sent(&mut self, id: &str, exp: OffsetDateTime, now: OffsetDateTime) -> bool {
        if self.mine.len() >= MAX_SENT_INVITES {
            self.mine.retain(|_, e| *e > now);
            if self.mine.len() >= MAX_SENT_INVITES {
                return false;
            }
        }
        self.mine.insert(id.to_string(), exp);
        true
    }
}

fn valid_invite_id(id: &str) -> bool {
    hex::decode(id).is_ok_and(|raw| raw.len() == INVITE_ID_BYTES)
}

fn unix_nanos(t: OffsetDateTime) -> i128 {
    t.unix_timestamp_nanos()
}

fn unix_millis(t: OffsetDateTime) -> i64 {
    i64::try_from(t.unix_timestamp_nanos().div_euclid(NANOS_PER_MILLI)).unwrap_or(i64::MAX)
}

/// 내 노드 키와 상대 노드 공개키의 ECDH 로 만든 상자 키다 (FR-EGM-32).
fn box_key(
    id: &Identity,
    peer_key: &str,
    invite_id: &str,
    from: &str,
    to: &str,
) -> Result<[u8; BOX_KEY_BYTES], MeshError> {
    let priv_key = secret_key(id).ok_or(ErrorKind::BadKey)?;
    let der = std_decode(peer_key).ok_or(ErrorKind::BadKey)?;
    let pub_key =
        parse_key(&hex::encode(Sha256::digest(&der)), peer_key).ok_or(ErrorKind::BadKey)?;
    let secret = p256::ecdh::diffie_hellman(priv_key.to_nonzero_scalar(), pub_key.as_affine());
    let info = format!("{INVITE_INFO}{from}{to}");
    let mut out = [0u8; BOX_KEY_BYTES];
    Hkdf::<Sha256>::new(Some(invite_id.as_bytes()), secret.raw_secret_bytes())
        .expand(info.as_bytes(), &mut out)
        .map_err(|e| MeshError::wrap(ErrorKind::BadKey, e))?;
    Ok(out)
}

/// plain 을 상대 peer_key 만 열 수 있게 잠근다. 돌려준 값은 base64(nonce ‖ 암호문)이다.
pub(crate) fn seal(
    id: &Identity,
    peer_key: &str,
    invite_id: &str,
    from: &str,
    to: &str,
    plain: &[u8],
) -> Result<String, MeshError> {
    let key = box_key(id, peer_key, invite_id, from, to)?;
    let aead =
        Aes256Gcm::new_from_slice(&key).map_err(|e| MeshError::wrap(ErrorKind::BadKey, e))?;
    let mut nonce = [0u8; GCM_NONCE_BYTES];
    rand::fill(&mut nonce[..]);
    let aad = format!("{invite_id}{from}{to}");
    let ct = aead
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: plain,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|e| MeshError::wrap(ErrorKind::BadKey, e))?;
    let mut out = nonce.to_vec();
    out.extend(ct);
    Ok(STANDARD.encode(out))
}

/// seal 의 역이다. 보낸 노드의 공개키 sender_key 로 연다.
pub(crate) fn open(
    id: &Identity,
    sender_key: &str,
    invite_id: &str,
    from: &str,
    to: &str,
    sealed: &str,
) -> Option<Vec<u8>> {
    let raw = std_decode(sealed)?;
    if raw.len() < GCM_NONCE_BYTES {
        return None;
    }
    let key = box_key(id, sender_key, invite_id, from, to).ok()?;
    let aead = Aes256Gcm::new_from_slice(&key).ok()?;
    let (nonce, ct) = raw.split_at(GCM_NONCE_BYTES);
    let nonce: [u8; GCM_NONCE_BYTES] = nonce.try_into().ok()?;
    let aad = format!("{invite_id}{from}{to}");
    aead.decrypt(
        &Nonce::from(nonce),
        Payload {
            msg: ct,
            aad: aad.as_bytes(),
        },
    )
    .ok()
}

impl Inner {
    /// 바르고 처음 보는 초대면 넘기라고(참) 답한다. 이 노드에게 온 것이면 연 초대도 돌려준다
    /// (FR-EGM-33·34).
    pub(crate) fn accept_invite_locked(
        &self,
        st: &mut State,
        fr: &Frame,
    ) -> (Option<Invite>, bool) {
        let Ok(b) = json::unmarshal::<InviteBody>(&fr.b.0) else {
            return (None, false);
        };
        if b.from == self.id.fingerprint || !valid_invite_id(&b.id) {
            return (None, false);
        }
        if st.inv.seen.contains_key(&b.id) {
            return (None, false);
        }
        let now = self.now();
        let now_ns = unix_nanos(now);
        let (at_ns, exp_ns) = (
            i128::from(b.at) * NANOS_PER_MILLI,
            i128::from(b.exp) * NANOS_PER_MILLI,
        );
        if exp_ns <= now_ns
            || exp_ns - at_ns > INVITE_TTL.as_nanos() as i128
            || at_ns > now_ns + INVITE_SKEW.as_nanos() as i128
        {
            return (None, false);
        }
        let Ok(exp) = OffsetDateTime::from_unix_timestamp_nanos(exp_ns) else {
            return (None, false);
        };
        // 보낸 노드 몫은 이 확인을 지난 뒤에만 쓴다 — 지문을 거짓으로 적은 초대는 기억에 들지
        // 않는다.
        let Some(r) = st.net.nodes.get(&b.from) else {
            return (None, false);
        };
        if !verify(&r.key, FRAME_INVITE, &fr.b.0, &fr.s) {
            return (None, false);
        }
        let (sender_key, sender_name) = (r.st.key.clone(), r.st.name.clone());
        if !st.inv.remember_seen(&b.id, &b.from, exp, now) {
            return (None, false);
        }
        if b.to != self.id.fingerprint {
            return (None, true);
        }
        let Some(plain) = open(&self.id, &sender_key, &b.id, &b.from, &b.to, &b.sealed) else {
            return (None, true);
        };
        let Ok(code) = String::from_utf8(plain) else {
            return (None, true);
        };
        match decode_invite(&code) {
            Ok(ic) if ic.fingerprint == b.from => {}
            _ => return (None, true),
        }
        (
            Some(Invite {
                id: b.id,
                from: b.from,
                name: sender_name,
                code,
                expires: exp,
            }),
            true,
        )
    }
}

impl Mesh {
    /// 망 이웃 to 에게 간선 초대 코드를 보낸다 (FR-EGM-32·33). 코드는 to 의 노드 공개키로만
    /// 열린다. to 를 모르면 [`ErrorKind::UnknownNode`], 초대 기억이 가득 찼으면
    /// [`ErrorKind::InviteFull`] 이다.
    pub fn send_invite(&self, to: &str, code: &str, exp: OffsetDateTime) -> Result<(), MeshError> {
        let inner = &self.inner;
        let mut st = inner.lock();
        let Some(r) = st.net.nodes.get(to) else {
            return Err(ErrorKind::UnknownNode.into());
        };
        let id = random_hex(INVITE_ID_BYTES);
        let me = inner.id.fingerprint.clone();
        let sealed = seal(&inner.id, &r.st.key, &id, &me, to, code.as_bytes())?;
        let now = inner.now();
        let body = InviteBody {
            id: id.clone(),
            from: me,
            to: to.to_string(),
            at: unix_millis(now),
            exp: unix_millis(exp),
            sealed,
        };
        let fr = sign_frame(&inner.id, FRAME_INVITE, &body)?;
        if !st.inv.remember_sent(&id, exp, now) {
            return Err(ErrorKind::InviteFull.into());
        }
        broadcast_locked(&st, &encode(&fr), None);
        Ok(())
    }
}
