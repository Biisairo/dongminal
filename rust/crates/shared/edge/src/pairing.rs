//! 간선 맺기의 초대 (FR-PNW-20·21, EDGE_PAIRING_SRS FR-EPR-1·3·6, EDGE_MESH_SRS FR-EGM-31).

use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use base64::alphabet::URL_SAFE;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use time::OffsetDateTime;

use crate::addr::{valid_addr, valid_fingerprint, valid_port};
use crate::error::Error;
use crate::limit::Clock;

pub const INVITE_TTL: Duration = Duration::from_secs(10 * 60);
/// 초대 코드의 접두어다 (FR-PNW-21).
pub const INVITE_PREFIX: &str = "dmedge1:";
const TOKEN_BYTES: usize = 16;
/// 지문에 묶인 초대의 상한이다 (FR-EGM-31).
const MAX_BOUND_INVITES: usize = 32;

/// Go `base64.RawURLEncoding`: 패딩 없음, 끝 글자의 남는 비트를 보지 않는다.
const URL_SAFE_NO_PAD: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Clone)]
struct Invite {
    token: String,
    expires: OffsetDateTime,
    /// 이 초대를 쓸 수 있는 지문. 비면 누구나 쓴다.
    fp: String,
}

/// 쓴 초대다. 응답이 끊긴 쪽의 다시 시도를 그 초대의 만료까지 받는다 (FR-EPR-6).
struct Redeemed {
    token: String,
    fp: String,
    expires: OffsetDateTime,
}

#[derive(Default)]
struct State {
    invite: Option<Invite>,
    bound: Vec<Invite>,
    used: Option<Redeemed>,
}

/// 사람이 만든 초대 하나, 지문에 묶인 초대들, 마지막으로 쓴 초대다. 메모리에만 둔다.
pub struct Pairing {
    now: Clock,
    state: Mutex<State>,
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::fill(&mut b[..]);
    hex::encode(b)
}

fn same_token(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

impl Pairing {
    pub fn new(now: Clock) -> Self {
        Self { now, state: Mutex::new(State::default()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 새 초대를 만든다. 이전 초대와 그 다시 시도 기억은 사라진다 (FR-PNW-20).
    pub fn new_invite(&self) -> (String, OffsetDateTime) {
        let inv = Invite { token: random_hex(TOKEN_BYTES), expires: (self.now)() + INVITE_TTL, fp: String::new() };
        let out = (inv.token.clone(), inv.expires);
        let mut st = self.lock();
        st.invite = Some(inv);
        st.used = None;
        out
    }

    /// 지문 fp 만 쓸 수 있는 초대를 만든다. 사람이 만든 초대와 따로 두어 서로 밀어내지 않는다.
    /// 상한을 넘으면 가장 오래된 것을 버린다.
    pub fn new_bound_invite(&self, fp: &str) -> (String, OffsetDateTime) {
        let now = (self.now)();
        let inv = Invite { token: random_hex(TOKEN_BYTES), expires: now + INVITE_TTL, fp: fp.to_string() };
        let out = (inv.token.clone(), inv.expires);
        let mut st = self.lock();
        st.bound.retain(|b| now < b.expires);
        if st.bound.len() >= MAX_BOUND_INVITES {
            st.bound.remove(0);
        }
        st.bound.push(inv);
        out
    }

    /// 지문 fp 가 쓴 초대의 다시 시도 기억을 지운다. 간선을 지울 때 부른다.
    pub fn revoke(&self, fp: &str) {
        let mut st = self.lock();
        if st.used.as_ref().is_some_and(|u| u.fp == fp) {
            st.used = None;
        }
    }

    fn live_invite(&self, st: &mut State) -> Option<Invite> {
        if st.invite.as_ref().is_some_and(|i| (self.now)() >= i.expires) {
            st.invite = None;
        }
        st.invite.clone()
    }

    /// 살아 있는 초대가 있는가다.
    pub fn has_invite(&self) -> bool {
        let mut st = self.lock();
        self.live_invite(&mut st).is_some()
    }

    /// 살아 있는 초대의 만료 시각이다.
    pub fn invite_expires(&self) -> Option<OffsetDateTime> {
        let mut st = self.lock();
        self.live_invite(&mut st).map(|i| i.expires)
    }

    /// 지문 fp 의 노드가 낸 토큰을 대조한다 (FR-EPR-3·6). 살아 있는 초대와 맞으면 쓰고 기억한다.
    /// 같은 지문이 같은 토큰으로 다시 오면 초대 만료까지 성공이다. 살아 있는 초대에 틀린 토큰은
    /// [`Error::BadToken`] 이고 그 요청만 거절한다. 그 밖은 [`Error::NoInvite`] 다.
    pub fn redeem(&self, token: &str, fp: &str) -> Result<(), Error> {
        let now = (self.now)();
        let mut st = self.lock();
        if let Some(u) = &st.used
            && now < u.expires
            && u.fp == fp
            && same_token(token, &u.token)
        {
            return Ok(());
        }
        st.bound.retain(|b| now < b.expires);
        if let Some(i) = st.bound.iter().position(|b| same_token(token, &b.token)) {
            if st.bound[i].fp != fp {
                return Err(Error::BadToken);
            }
            let b = st.bound.remove(i);
            st.used = Some(Redeemed { token: b.token, fp: fp.to_string(), expires: b.expires });
            return Ok(());
        }
        let Some(inv) = self.live_invite(&mut st) else {
            return Err(Error::NoInvite);
        };
        if !same_token(token, &inv.token) {
            return Err(Error::BadToken);
        }
        st.invite = None;
        st.used = Some(Redeemed { token: inv.token, fp: fp.to_string(), expires: inv.expires });
        Ok(())
    }
}

/// 초대 코드의 내용이다 (FR-PNW-21).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct InviteCode {
    pub addr: String,
    pub port: i64,
    #[serde(rename = "fp")]
    pub fingerprint: String,
    pub token: String,
}

/// `dmedge1:` + base64url(JSON) 이다.
pub fn encode_invite(c: &InviteCode) -> String {
    let raw = dm_gocompat::json::marshal(c).unwrap_or_default();
    format!("{INVITE_PREFIX}{}", URL_SAFE_NO_PAD.encode(raw))
}

/// [`encode_invite`] 의 역이다. 앞뒤 공백은 무시한다.
pub fn decode_invite(s: &str) -> Result<InviteCode, Error> {
    let s = s.trim_matches(go_space);
    let body = s.strip_prefix(INVITE_PREFIX).ok_or(Error::InvalidInvite)?;
    // Go 의 base64 디코더는 `\r`·`\n` 을 건너뛴다.
    let body: String = body.chars().filter(|c| !matches!(c, '\r' | '\n')).collect();
    let raw = URL_SAFE_NO_PAD.decode(body).map_err(|_| Error::InvalidInvite)?;
    let c: InviteCode = dm_gocompat::json::unmarshal(&raw).map_err(|_| Error::InvalidInvite)?;
    if !valid_addr(&c.addr) || !valid_port(c.port) || !valid_fingerprint(&c.fingerprint) || c.token.is_empty() {
        return Err(Error::InvalidInvite);
    }
    Ok(c)
}

/// Go `strings.TrimSpace` 의 공백(유니코드 White_Space).
pub(crate) fn go_space(c: char) -> bool {
    c.is_whitespace()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limit::tests::FakeClock;

    pub(crate) fn fp_of(prefix: &str) -> String {
        format!("{prefix}{}", "0".repeat(64 - prefix.len()))
    }

    #[test]
    fn token_and_expiry() {
        let clk = FakeClock::new();
        let p = Pairing::new(clk.clock());
        assert!(!p.has_invite());
        let (token, expires) = p.new_invite();
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(expires, clk.now() + INVITE_TTL);
        assert_eq!(INVITE_TTL, Duration::from_secs(600));
        clk.advance(INVITE_TTL - Duration::from_secs(1));
        assert!(p.has_invite());
        clk.advance(Duration::from_secs(2));
        assert!(!p.has_invite());
        assert_eq!(p.redeem(&token, &fp_of("aa")), Err(Error::NoInvite));
    }

    #[test]
    fn one_time() {
        let p = Pairing::new(FakeClock::new().clock());
        let (token, _) = p.new_invite();
        p.redeem(&token, &fp_of("aa")).unwrap();
        assert!(!p.has_invite());
        assert_eq!(p.redeem(&token, &fp_of("bb")), Err(Error::NoInvite));
    }

    #[test]
    fn replaces() {
        let p = Pairing::new(FakeClock::new().clock());
        let (old, _) = p.new_invite();
        let (fresh, _) = p.new_invite();
        assert_ne!(old, fresh);
        assert_eq!(p.redeem(&old, &fp_of("aa")), Err(Error::BadToken));
        p.redeem(&fresh, &fp_of("aa")).unwrap();
    }

    #[test]
    fn survives_bad_tokens() {
        let p = Pairing::new(FakeClock::new().clock());
        let (token, _) = p.new_invite();
        for _ in 0..100 {
            assert_eq!(p.redeem("bad", &fp_of("aa")), Err(Error::BadToken));
        }
        p.redeem(&token, &fp_of("aa")).unwrap();
    }

    #[test]
    fn retry_same_fingerprint() {
        let clk = FakeClock::new();
        let p = Pairing::new(clk.clock());
        let (tok, _) = p.new_invite();
        assert_eq!(p.redeem("wrong", &fp_of("aa")), Err(Error::BadToken));
        p.redeem(&tok, &fp_of("aa")).unwrap();
        assert!(!p.has_invite());
        p.redeem(&tok, &fp_of("aa")).unwrap();
        assert_eq!(p.redeem(&tok, &fp_of("bb")), Err(Error::NoInvite));
        clk.advance(INVITE_TTL + Duration::from_secs(1));
        assert_eq!(p.redeem(&tok, &fp_of("aa")), Err(Error::NoInvite));
    }

    #[test]
    fn retry_revoked() {
        let p = Pairing::new(Box::new(OffsetDateTime::now_utc));
        let (tok, _) = p.new_invite();
        p.redeem(&tok, &fp_of("aa")).unwrap();
        p.revoke(&fp_of("bb"));
        p.redeem(&tok, &fp_of("aa")).unwrap();
        p.revoke(&fp_of("aa"));
        assert_eq!(p.redeem(&tok, &fp_of("aa")), Err(Error::NoInvite));
        let (tok2, _) = p.new_invite();
        p.redeem(&tok2, &fp_of("aa")).unwrap();
        p.new_invite();
        assert_eq!(p.redeem(&tok2, &fp_of("aa")), Err(Error::BadToken));
    }

    #[test]
    fn bound_invite() {
        let clk = FakeClock::new();
        let p = Pairing::new(clk.clock());
        let (a, b) = ("aa".repeat(32), "bb".repeat(32));
        let (tok, exp) = p.new_bound_invite(&a);
        assert_eq!(exp, clk.now() + INVITE_TTL);
        let (manual, _) = p.new_invite();
        assert_eq!(p.redeem(&tok, &b), Err(Error::BadToken));
        p.redeem(&tok, &a).unwrap();
        p.redeem(&manual, &b).unwrap();
        let (tok2, _) = p.new_bound_invite(&a);
        p.new_invite();
        p.redeem(&tok2, &a).unwrap();
        assert!(p.redeem(&tok2, &b).is_err());
        let mut first = String::new();
        for i in 0..=MAX_BOUND_INVITES {
            let (tk, _) = p.new_bound_invite(&a);
            if i == 0 {
                first = tk;
            }
        }
        assert!(p.redeem(&first, &a).is_err());
        let (expired, _) = p.new_bound_invite(&a);
        clk.advance(INVITE_TTL);
        assert!(p.redeem(&expired, &a).is_err());
    }

    #[test]
    fn invite_code_round_trip() {
        let inv = InviteCode {
            addr: "office.example".into(),
            port: 58147,
            fingerprint: "ab".repeat(32),
            token: "0f".repeat(16),
        };
        let code = encode_invite(&inv);
        assert!(code.starts_with("dmedge1:"));
        assert!(URL_SAFE_NO_PAD.decode(&code[INVITE_PREFIX.len()..]).is_ok());
        assert_eq!(decode_invite(&format!("  {code}\n")).unwrap(), inv);
        // Go json.Marshal 의 필드 순서와 같다.
        let raw = URL_SAFE_NO_PAD.decode(&code[INVITE_PREFIX.len()..]).unwrap();
        assert_eq!(
            String::from_utf8(raw).unwrap(),
            format!(r#"{{"addr":"office.example","port":58147,"fp":"{}","token":"{}"}}"#, "ab".repeat(32), "0f".repeat(16))
        );
    }

    #[test]
    fn decode_invite_rejects() {
        let enc = |s: &str| format!("{INVITE_PREFIX}{}", URL_SAFE_NO_PAD.encode(s));
        let fp = "ab".repeat(32);
        let tok = "0f".repeat(16);
        let bad = [
            String::new(),
            "dmedge2:abc".into(),
            "dmedge1:!!!".into(),
            format!(
                "dmpeer1:{}",
                URL_SAFE_NO_PAD.encode(format!(r#"{{"addr":"h","port":58147,"fp":"{fp}","token":"{tok}"}}"#))
            ),
            enc("{"),
            enc(&format!(r#"{{"port":58147,"fp":"{fp}","token":"{tok}"}}"#)),
            enc(&format!(r#"{{"addr":"h","port":0,"fp":"{fp}","token":"{tok}"}}"#)),
            enc(&format!(r#"{{"addr":"h","port":58147,"fp":"zz","token":"{tok}"}}"#)),
            enc(&format!(r#"{{"addr":"h","port":58147,"fp":"{fp}","token":""}}"#)),
            enc(&format!(r#"{{"addr":"h/x","port":58147,"fp":"{fp}","token":"{tok}"}}"#)),
        ];
        for c in bad {
            assert_eq!(decode_invite(&c), Err(Error::InvalidInvite), "{c}");
        }
    }
}
