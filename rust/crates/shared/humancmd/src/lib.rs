//! Go 기준선 `otterminal/internal/shared/humancmd` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 사람 명령(강제 삭제·강퇴)의 와이어다 (PEER_CHAT_SRS §3.12). 도우미(`otterminal otp run`)와
//! 데몬이 같은 한 벌을 쓴다: 도우미 소켓의 프레임, 도우미가 서명하는 명령 본문, 그 서명의 확인.
//!
//! 도우미 소켓 클라이언트는 [`Client`] 다. 왕복 한 번의 규칙은 [`round_trip`] 이 스트림을 받아 수행한다.

mod client;
mod wire;

pub use client::{Client, Deadline, Info};
pub use wire::{DEFAULT_TIMEOUT, MAX_LINE, read_line, round_trip};

use std::fmt;

use base64::Engine as _;
use base64::alphabet::STANDARD as STD_ALPHABET;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use otter_gocompat::json::{self, RawMessage};
use serde::{Deserialize, Serialize};

/// 명령 종류다 (FR-PCH-70).
pub const OP_KILL: &str = "kill";
pub const OP_KICK: &str = "kick";

/// 묶음 하나의 대상 상한이다.
pub const MAX_TARGETS: usize = 64;

/// 도우미 소켓이다. root 가 만들고 설치한 사용자에게 넘긴다. home 에서 파생하지 않는다 —
/// root 만 쓰는 `/var/run` 이어야 서명 경계가 선다 (REFACTOR3_GO_STRUCT_SRS FR-RGS-42).
pub const SOCKET_PATH: &str = "/var/run/com.otterminal.helper.sock";

const SIGN_DOMAIN: &str = "dmhuman1";
const MAX_ID: usize = 128;
const PUBLIC_KEY_SIZE: usize = 32;
const SIGNATURE_SIZE: usize = 64;
const ID_BYTES: usize = 16;

/// 도우미 소켓의 프레임 종류다.
pub const TYPE_INFO: &str = "info";
pub const TYPE_SIGN: &str = "sign";
pub const TYPE_SIGNED: &str = "signed";
pub const TYPE_ERROR: &str = "error";

/// 오류 코드다. `no_helper` 는 데몬이 도우미에 닿지 못할 때 쓴다.
pub const CODE_BAD_CODE: &str = "bad_code";
pub const CODE_LOCKED: &str = "locked";
pub const CODE_BAD_REQUEST: &str = "bad_request";
pub const CODE_NO_HELPER: &str = "no_helper";
/// 도우미가 코드를 확인했지만 비밀 파일을 쓰지 못했다. 틀린 횟수에 넣지 않는다 (§3.12a R-5).
pub const CODE_UNAVAILABLE: &str = "unavailable";

/// 강퇴 대상 하나다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "humancmd.Kick")]
pub struct Kick {
    pub room: String,
    pub participant: String,
}

/// 데몬이 도우미에게 서명을 부탁하는 묶음이다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "humancmd.Request")]
pub struct Request {
    pub node: String,
    pub op: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub rooms: Vec<String>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub kicks: Vec<Kick>,
}

impl Request {
    /// 묶음의 모양을 본다: 한 종류만, 대상 1~MAX_TARGETS 개, id 모양.
    pub fn valid(&self) -> bool {
        if !valid_id(&self.node) || self.node.is_empty() {
            return false;
        }
        match self.op.as_str() {
            OP_KILL => {
                self.kicks.is_empty()
                    && (1..=MAX_TARGETS).contains(&self.rooms.len())
                    && self.rooms.iter().all(|id| !id.is_empty() && valid_id(id))
            }
            OP_KICK => {
                self.rooms.is_empty()
                    && (1..=MAX_TARGETS).contains(&self.kicks.len())
                    && self.kicks.iter().all(|k| {
                        !k.room.is_empty()
                            && !k.participant.is_empty()
                            && valid_id(&k.room)
                            && valid_id(&k.participant)
                    })
            }
            _ => false,
        }
    }
}

/// 도우미가 서명한 명령이다. `id` 는 무작위, `at` 은 도우미 시각(ms), `key` 는 도우미 공개키다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "humancmd.Body")]
pub struct Body {
    pub id: String,
    pub node: String,
    pub op: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub rooms: Vec<String>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub kicks: Vec<Kick>,
    pub at: i64,
    pub key: String,
}

impl Body {
    /// 본문의 묶음 부분이다.
    pub fn request(&self) -> Request {
        Request {
            node: self.node.clone(),
            op: self.op.clone(),
            rooms: self.rooms.clone(),
            kicks: self.kicks.clone(),
        }
    }
}

/// 본문 원문과 도우미 서명이다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "humancmd.Signed")]
pub struct Signed {
    pub b: RawMessage,
    pub s: String,
}

/// 도우미 소켓의 줄 하나다. `code` 는 sign 에서는 사람이 넣은 코드, error 에서는 오류 코드다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "humancmd.Frame")]
pub struct Frame {
    pub t: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub code: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub req: Option<Request>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub key: String,
    #[serde(rename = "lockedUntil", skip_serializing_if = "json::is_empty")]
    pub locked_until: i64,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub until: i64,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub b: RawMessage,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub s: String,
}

/// 도우미의 거절이다. `until` 은 locked 일 때 풀리는 시각(ms)이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Error {
    pub code: String,
    pub until: i64,
}

impl Error {
    pub fn no_helper() -> Self {
        Self {
            code: CODE_NO_HELPER.to_owned(),
            until: 0,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "helper: {}", self.code)
    }
}

impl std::error::Error for Error {}

/// [`open`] 의 거절이다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadSigned;

impl fmt::Display for BadSigned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("humancmd: 서명이나 모양이 틀렸다")
    }
}

impl std::error::Error for BadSigned {}

/// Ed25519 공개키의 base64 다.
pub fn public_key(key: &SigningKey) -> String {
    STANDARD.encode(VerifyingKey::from(key).as_bytes())
}

fn message(body: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(SIGN_DOMAIN.len() + 1 + body.len());
    m.extend_from_slice(SIGN_DOMAIN.as_bytes());
    m.push(0);
    m.extend_from_slice(body);
    m
}

/// 본문에 도우미 키를 싣고 서명한다. 묶음 전체에 서명 하나다 (FR-PCH-71).
pub fn sign(key: &SigningKey, mut b: Body) -> Result<Signed, json::Error> {
    b.key = public_key(key);
    let raw = json::marshal(&b)?;
    let sig = key.sign(&message(&raw));
    Ok(Signed {
        s: STANDARD.encode(sig.to_bytes()),
        b: RawMessage(raw),
    })
}

/// Go `base64.StdEncoding.DecodeString`: 패딩은 요구하고, 남는 비트는 받고, `\r`·`\n` 은 건너뛴다.
fn decode_std_lenient(s: &str) -> Option<Vec<u8>> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &STD_ALPHABET,
        GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
    );
    let cleaned: Vec<u8> = s.bytes().filter(|&c| c != b'\r' && c != b'\n').collect();
    LENIENT.decode(cleaned).ok()
}

/// 본문에 실린 키로 서명을 확인하고 모양을 본다. 그 키를 믿을지는 부르는 쪽이 정한다.
pub fn open(s: &Signed) -> Result<Body, BadSigned> {
    let b: Body = json::unmarshal(&s.b.0).map_err(|_| BadSigned)?;
    let pub_bytes: [u8; PUBLIC_KEY_SIZE] = decode_std_lenient(&b.key)
        .and_then(|v| v.try_into().ok())
        .ok_or(BadSigned)?;
    let vk = VerifyingKey::from_bytes(&pub_bytes).map_err(|_| BadSigned)?;
    // 정규 표기만 받는다. 같은 서명의 다른 표기는 본 명령 해시를 비껴간다 (§3.12a R-10).
    let sig_bytes: [u8; SIGNATURE_SIZE] = STANDARD
        .decode(&s.s)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(BadSigned)?;
    if STANDARD.encode(sig_bytes) != s.s {
        return Err(BadSigned);
    }
    vk.verify(&message(&s.b.0), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| BadSigned)?;
    if b.id.is_empty() || !valid_id(&b.id) || !b.request().valid() {
        return Err(BadSigned);
    }
    Ok(b)
}

/// 무작위 16바이트 hex 다.
pub fn new_id() -> String {
    let mut b = [0u8; ID_BYTES];
    rand::fill(&mut b);
    hex::encode(b)
}

fn valid_id(s: &str) -> bool {
    s.len() <= MAX_ID
        && s.chars()
            .all(|r| r.is_ascii_alphanumeric() || r == '-' || r == '_')
}

#[cfg(test)]
mod tests;
