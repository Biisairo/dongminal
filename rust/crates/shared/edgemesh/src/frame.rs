use base64::Engine;
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use otter_gocompat::json::{self, RawMessage};
use otter_shared_edge::Identity;
use p256::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
use p256::ecdsa::{DerSignature, Signature, SigningKey, VerifyingKey};
use p256::pkcs8::{DecodePrivateKey, DecodePublicKey};
use rustls::pki_types::PrivateKeyDer;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{ErrorKind, MeshError};

// 간선 계층이 처리하는 프레임 종류다 (FR-EGM-4). 그 밖의 종류는 위층의 것이다.
pub const FRAME_PING: &str = "ping";
pub const FRAME_HELLO: &str = "hello";
pub const FRAME_NET: &str = "net";
pub const FRAME_INVITE: &str = "invite";

/// Go `base64.StdEncoding` 의 디코더다: 끝 비트가 0 이 아니어도 받는다.
const GO_STD: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

/// Go 의 base64 디코더는 `\r`·`\n` 을 건너뛴다.
pub(crate) fn std_decode(s: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = s.bytes().filter(|b| !matches!(b, b'\r' | b'\n')).collect();
    GO_STD.decode(clean).ok()
}

fn raw_empty(r: &RawMessage) -> bool {
    r.0.is_empty()
}

/// 간선 연결의 한 줄이다. `b` 는 본문 원문이고, `s` 는 그 원문에 한 서명이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "edgemesh.Frame")]
pub struct Frame {
    pub t: String,
    #[serde(skip_serializing_if = "raw_empty")]
    pub b: RawMessage,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub s: String,
}

/// 프레임 한 줄(끝에 줄바꿈)이다.
pub fn encode(fr: &Frame) -> Vec<u8> {
    let mut raw = json::marshal(fr).unwrap_or_default();
    raw.push(b'\n');
    raw
}

fn digest(kind: &str, body: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(kind.as_bytes());
    h.update([0u8]);
    h.update(body);
    h.finalize().into()
}

pub(crate) fn secret_key(id: &Identity) -> Option<p256::SecretKey> {
    match id.private_key() {
        PrivateKeyDer::Pkcs8(k) => p256::SecretKey::from_pkcs8_der(k.secret_pkcs8_der()).ok(),
        PrivateKeyDer::Sec1(k) => p256::SecretKey::from_sec1_der(k.secret_sec1_der()).ok(),
        _ => None,
    }
}

/// 노드 키로 `SHA-256(종류 ‖ 0x00 ‖ 본문)` 에 서명한다 (PEER_CHAT_SRS FR-PCH-5). 값은
/// ASN.1 DER 서명의 base64 다.
pub fn sign(id: &Identity, kind: &str, body: &[u8]) -> Result<String, MeshError> {
    let key = secret_key(id).ok_or(ErrorKind::NoSigner)?;
    let signer = SigningKey::from(&key);
    let sig: Signature = signer
        .sign_prehash(&digest(kind, body))
        .map_err(|e| MeshError::wrap(ErrorKind::NoSigner, e))?;
    Ok(STANDARD.encode(sig.to_der().as_bytes()))
}

/// [`sign`] 의 서명을 확인한다.
pub fn verify(key: &p256::PublicKey, kind: &str, body: &[u8], sig: &str) -> bool {
    let Some(raw) = std_decode(sig) else {
        return false;
    };
    let Ok(der) = DerSignature::try_from(raw.as_slice()) else {
        return false;
    };
    VerifyingKey::from(key)
        .verify_prehash(&digest(kind, body), &der)
        .is_ok()
}

/// v 를 본문으로 한 서명된 프레임이다.
pub fn sign_frame<T: Serialize + ?Sized>(
    id: &Identity,
    kind: &str,
    v: &T,
) -> Result<Frame, MeshError> {
    let body = json::marshal(v).map_err(|e| MeshError::wrap(ErrorKind::NoSigner, e))?;
    let s = sign(id, kind, &body)?;
    Ok(Frame {
        t: kind.to_string(),
        b: RawMessage(body),
        s,
    })
}

/// 노드 공개키(SPKI DER)의 base64 다. 그 SHA-256 이 노드 지문이다.
pub fn public_key(id: &Identity) -> String {
    if id.certificate.is_empty() {
        return String::new();
    }
    match x509_parser::parse_x509_certificate(&id.certificate) {
        Ok((_, cert)) => STANDARD.encode(cert.tbs_certificate.subject_pki.raw),
        Err(_) => String::new(),
    }
}

/// key 가 지문 node 의 공개키일 때만 그 키를 돌려준다.
pub fn parse_key(node: &str, key: &str) -> Option<p256::PublicKey> {
    let der = std_decode(key)?;
    if hex::encode(Sha256::digest(&der)) != node {
        return None;
    }
    p256::PublicKey::from_public_key_der(&der).ok()
}

pub(crate) fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::fill(&mut b[..]);
    hex::encode(b)
}
