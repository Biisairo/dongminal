//! Claude Code 의 자격증명 JSON. 토큰 값은 이 crate 밖으로 나가지 않는다 (FR-CAC-9) — 비교와
//! 로그에는 지문(`fingerprint`)만 쓴다.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use dm_gocompat::json::{self, RawMessage};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::client::TokenResult;
use crate::error::Error;

const OAUTH_KEY: &str = "claudeAiOauth";

/// 계정이 아니라 기계에 속하는 최상위 필드다 (FR-CAC-8).
const SHARED_KEYS: [&str; 5] = [
    "mcpOAuth",
    "mcpOAuthClientConfig",
    "mcpXaaIdp",
    "mcpXaaIdpConfig",
    "pluginSecrets",
];

const ERR_NOT_OBJECT: &str = "자격증명이 JSON 객체가 아닙니다";

/// 만료 판정의 여유다 (FR-CAC-42).
const EXPIRY_SKEW: Duration = Duration::from_secs(5 * 60);

type Fields = BTreeMap<String, RawMessage>;

/// Claude Code 의 자격증명 JSON 이다. 모르는 필드는 원문 그대로 지닌다 (FR-CAC-7).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Credential {
    top: Fields,
    oauth: Option<Fields>,
}

impl Credential {
    /// 자격증명 JSON 을 읽는다. 객체가 아니면 오류다.
    pub fn parse(b: &[u8]) -> Result<Self, Error> {
        let top = match json::unmarshal::<Option<Fields>>(b) {
            Ok(Some(top)) => top,
            _ => return Err(Error::new(ERR_NOT_OBJECT)),
        };
        let oauth = match top.get(OAUTH_KEY) {
            Some(raw) => json::unmarshal::<Option<Fields>>(&raw.0)
                .map_err(|_| Error::new(ERR_NOT_OBJECT))?,
            None => None,
        };
        Ok(Self { top, oauth })
    }

    /// 자격증명을 JSON 으로 낸다.
    pub fn marshal(&self) -> Result<Vec<u8>, Error> {
        let mut top = self.top.clone();
        if let Some(o) = &self.oauth {
            top.insert(OAUTH_KEY.to_owned(), RawMessage(json::marshal(o)?));
        }
        Ok(json::marshal(&top)?)
    }

    fn str(&self, key: &str) -> String {
        self.oauth
            .as_ref()
            .and_then(|o| o.get(key))
            .and_then(|raw| json::unmarshal::<Option<String>>(&raw.0).ok().flatten())
            .unwrap_or_default()
    }

    fn num(&self, key: &str) -> i64 {
        let f = self
            .oauth
            .as_ref()
            .and_then(|o| o.get(key))
            .and_then(|raw| json::unmarshal::<Option<f64>>(&raw.0).ok().flatten())
            .unwrap_or_default();
        f as i64
    }

    pub fn access_token(&self) -> String {
        self.str("accessToken")
    }

    pub fn refresh_token(&self) -> String {
        self.str("refreshToken")
    }

    /// access token 의 만료 시각(ms)이다.
    pub fn expires_at(&self) -> i64 {
        self.num("expiresAt")
    }

    /// 로그인 만료 시각(ms)이다. 없으면 0 이다 (FR-CAC-45).
    pub fn refresh_token_expires_at(&self) -> i64 {
        self.num("refreshTokenExpiresAt")
    }

    /// 쓸 수 있는 토큰이 하나도 없다는 뜻이다.
    pub fn is_empty(&self) -> bool {
        self.access_token().is_empty() && self.refresh_token().is_empty()
    }

    /// refresh token(없으면 access token)의 SHA-256 앞 12자리다 (FR-CAC-9).
    pub fn fingerprint(&self) -> String {
        let mut t = self.refresh_token();
        if t.is_empty() {
            t = self.access_token();
        }
        if t.is_empty() {
            return String::new();
        }
        hex::encode(Sha256::digest(t.as_bytes()))[..12].to_owned()
    }

    /// self 의 기계 공유 필드를 live 의 것으로 바꾼 사본이다. live 에 없는 공유 필드는 지운다.
    /// 그 밖의 필드는 self 의 것 그대로다 (FR-CAC-8).
    pub fn with_shared(&self, live: &Credential) -> Credential {
        let mut top = self.top.clone();
        for k in SHARED_KEYS {
            match live.top.get(k) {
                Some(v) => {
                    top.insert(k.to_owned(), v.clone());
                }
                None => {
                    top.remove(k);
                }
            }
        }
        Credential {
            top,
            oauth: self.oauth.clone(),
        }
    }

    /// 갱신 결과를 담은 사본이다. refresh token 은 응답에 있을 때만 바꾼다.
    pub fn with_tokens(&self, tr: &TokenResult, now_ms: i64) -> Credential {
        let mut o = self.oauth.clone().unwrap_or_default();
        fn set<T: Serialize + ?Sized>(o: &mut Fields, k: &str, v: &T) {
            if let Ok(b) = json::marshal(v) {
                o.insert(k.to_owned(), RawMessage(b));
            }
        }
        set(&mut o, "accessToken", tr.access_token.as_str());
        set(&mut o, "expiresAt", &(now_ms + tr.expires_in * 1000));
        if !tr.refresh_token.is_empty() {
            set(&mut o, "refreshToken", tr.refresh_token.as_str());
        }
        if !tr.scopes.is_empty() {
            set(&mut o, "scopes", &tr.scopes);
        }
        Credential {
            top: self.top.clone(),
            oauth: Some(o),
        }
    }

    /// access token 이 now 기준 5분 안에 만료되는가다 (FR-CAC-42).
    pub(crate) fn expired(&self, now: SystemTime) -> bool {
        unix_millis(now + EXPIRY_SKEW) >= self.expires_at()
    }
}

/// Go `t.UnixMilli()`.
pub(crate) fn unix_millis(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    }
}
