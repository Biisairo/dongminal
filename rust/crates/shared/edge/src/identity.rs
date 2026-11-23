//! 이 노드의 인증서와 지문 (FR-PNW-1, §1.4).

use std::fmt;
use std::io;
use std::path::Path;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use dm_gocompat::oserr::{go_error_string, path_error};
use dm_shared_dmenv as dmenv;
use p256::pkcs8::{DecodePrivateKey, DecodePublicKey};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

/// 노드 인증서의 유효 기간이다 (FR-PNW-1).
pub const CERT_VALIDITY: Duration = Duration::from_secs(10 * 365 * 24 * 3600);
const KEY_FILE_PERM: u32 = 0o600;
const CERT_FILE_PERM: u32 = 0o644;
const COMMON_NAME: &str = "dongminal node";
const SERIAL_BYTES: usize = 16;
const BACKDATE: Duration = Duration::from_secs(3600);
const PEM_LINE: usize = 64;
const PEM_CERT: &str = "CERTIFICATE";
const PEM_EC_KEY: &str = "EC PRIVATE KEY";
const PEM_PKCS8_KEY: &str = "PRIVATE KEY";

/// 신원을 읽거나 만들지 못한 사유다. `Display` 는 Go 의 오류 문구와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityError(String);

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for IdentityError {}

/// 이 노드의 인증서와 그 지문이다.
pub struct Identity {
    pub certificate: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
    pub fingerprint: String,
}

impl Clone for Identity {
    fn clone(&self) -> Self {
        Self {
            certificate: self.certificate.clone(),
            key: self.key.clone_key(),
            fingerprint: self.fingerprint.clone(),
        }
    }
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Identity")
            .field("fingerprint", &self.fingerprint)
            .finish_non_exhaustive()
    }
}

impl Identity {
    pub fn private_key(&self) -> PrivateKeyDer<'static> {
        self.key.clone_key()
    }
}

/// 인증서 공개키(SPKI)의 SHA-256 소문자 16진수다. DER 을 읽지 못하면 `None` 이다.
pub fn fingerprint_of(cert_der: &[u8]) -> Option<String> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der).ok()?;
    Some(hex::encode(Sha256::digest(
        cert.tbs_certificate.subject_pki.raw,
    )))
}

pub(crate) type WriteFn = dyn Fn(&Path, &[u8], u32) -> io::Result<()>;

/// dir 의 노드 인증서를 읽고, 둘 다 없으면 만든다 (FR-PNW-1). 하나만 있거나 읽지 못하면
/// 오류다 — 신원은 조용히 바꾸지 않는다.
pub fn load_or_create_identity(dir: &Path) -> Result<Identity, IdentityError> {
    load_or_create_with(dir, &|p, d, m| {
        dm_shared_platform::write_file_atomic(p, d, m)
    })
}

pub(crate) fn load_or_create_with(dir: &Path, write: &WriteFn) -> Result<Identity, IdentityError> {
    let cert_path = dir.join(dmenv::EDGE_CERT_FILE);
    let key_path = dir.join(dmenv::EDGE_KEY_FILE);
    let cert_exists = file_exists(&cert_path)?;
    let key_exists = file_exists(&key_path)?;
    if cert_exists && key_exists {
        let cert_pem = read(&cert_path)?;
        let key_pem = read(&key_path)?;
        return parse_identity(&cert_pem, &key_pem);
    }
    if cert_exists || key_exists {
        return Err(IdentityError(format!(
            "노드 인증서와 키 중 하나만 있습니다 ({}, {}) — 둘 다 지우면 새 신원을 만듭니다",
            cert_path.display(),
            key_path.display()
        )));
    }
    let (cert_pem, key_pem) = generate()?;
    if let Err(e) = write(&key_path, &key_pem, KEY_FILE_PERM) {
        return Err(IdentityError(format!(
            "노드 키 저장: {}",
            go_error_string(&e)
        )));
    }
    if let Err(e) = write(&cert_path, &cert_pem, CERT_FILE_PERM) {
        // 키만 남으면 다음 기동마다 "하나만 있다" 로 멈춘다. 방금 만든 키를 거둔다.
        let _ = std::fs::remove_file(&key_path);
        return Err(IdentityError(format!(
            "노드 인증서 저장: {}",
            go_error_string(&e)
        )));
    }
    parse_identity(&cert_pem, &key_pem)
}

fn file_exists(p: &Path) -> Result<bool, IdentityError> {
    match std::fs::metadata(p) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(IdentityError(go_error_string(&path_error(
            "stat",
            &p.to_string_lossy(),
            e,
        )))),
    }
}

fn read(p: &Path) -> Result<Vec<u8>, IdentityError> {
    std::fs::read(p).map_err(|e| {
        IdentityError(go_error_string(&path_error(
            "open",
            &p.to_string_lossy(),
            e,
        )))
    })
}

fn parse_identity(cert_pem: &[u8], key_pem: &[u8]) -> Result<Identity, IdentityError> {
    x509_key_pair(cert_pem, key_pem)
        .map_err(|e| IdentityError(format!("노드 인증서를 읽지 못했습니다: {e}")))
}

/// Go `tls.X509KeyPair` 의 판정과 문구를 따른다. 키는 ECDSA P-256 만 받는다.
fn x509_key_pair(cert_pem: &[u8], key_pem: &[u8]) -> Result<Identity, String> {
    let mut certs = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for b in pem_blocks(cert_pem) {
        if b.kind == PEM_CERT {
            certs.push(b.bytes);
        } else {
            skipped.push(b.kind);
        }
    }
    let Some(cert) = certs.into_iter().next() else {
        if skipped.is_empty() {
            return Err("tls: failed to find any PEM data in certificate input".into());
        }
        if skipped.len() == 1 && skipped[0].ends_with("PRIVATE KEY") {
            return Err("tls: failed to find certificate PEM data in certificate input, but did find a private key; PEM inputs may have been switched".into());
        }
        return Err(format!(
            "tls: failed to find \"CERTIFICATE\" PEM block in certificate input after skipping PEM blocks of the following types: [{}]",
            skipped.join(" ")
        ));
    };
    skipped.clear();
    let mut key_block = None;
    for b in pem_blocks(key_pem) {
        if b.kind == PEM_PKCS8_KEY || b.kind.ends_with(" PRIVATE KEY") {
            key_block = Some(b.bytes);
            break;
        }
        skipped.push(b.kind);
    }
    let Some(key_der) = key_block else {
        if skipped.is_empty() {
            return Err("tls: failed to find any PEM data in key input".into());
        }
        if skipped.len() == 1 && skipped[0] == PEM_CERT {
            return Err(
                "tls: found a certificate rather than a key in the PEM for the private key".into(),
            );
        }
        return Err(format!(
            "tls: failed to find PEM block with type ending in \"PRIVATE KEY\" in key input after skipping PEM blocks of the following types: [{}]",
            skipped.join(" ")
        ));
    };
    let fingerprint =
        fingerprint_of(&cert).ok_or_else(|| "x509: malformed certificate".to_string())?;
    let (secret, key) = if let Ok(s) = p256::SecretKey::from_pkcs8_der(&key_der) {
        (s, PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der)))
    } else if let Ok(s) = p256::SecretKey::from_sec1_der(&key_der) {
        (s, PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(key_der)))
    } else {
        return Err("tls: failed to parse private key".into());
    };
    let spki = spki_raw(&cert).ok_or_else(|| "x509: malformed certificate".to_string())?;
    let Ok(public) = p256::PublicKey::from_public_key_der(&spki) else {
        return Err("tls: private key type does not match public key type".into());
    };
    if secret.public_key() != public {
        return Err("tls: private key does not match public key".into());
    }
    Ok(Identity {
        certificate: CertificateDer::from(cert),
        key,
        fingerprint,
    })
}

fn spki_raw(cert_der: &[u8]) -> Option<Vec<u8>> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der).ok()?;
    Some(cert.tbs_certificate.subject_pki.raw.to_vec())
}

fn generate() -> Result<(Vec<u8>, Vec<u8>), IdentityError> {
    let fail = |e: &dyn fmt::Display| IdentityError(e.to_string());
    let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(|e| fail(&e))?;
    let mut serial = [0u8; SERIAL_BYTES];
    rand::fill(&mut serial[..]);
    let not_before = OffsetDateTime::now_utc() - BACKDATE;
    let mut params = rcgen::CertificateParams::default();
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, COMMON_NAME);
    params.serial_number = Some(rcgen::SerialNumber::from_slice(&serial));
    params.not_before = not_before;
    params.not_after = not_before + CERT_VALIDITY;
    params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        rcgen::ExtendedKeyUsagePurpose::ClientAuth,
    ];
    params.is_ca = rcgen::IsCa::ExplicitNoCa;
    let cert = params.self_signed(&kp).map_err(|e| fail(&e))?;
    let secret = p256::SecretKey::from_pkcs8_der(&kp.serialize_der()).map_err(|e| fail(&e))?;
    let sec1 = secret.to_sec1_der().map_err(|e| fail(&e))?;
    Ok((
        pem_encode(PEM_CERT, cert.der()),
        pem_encode(PEM_EC_KEY, &sec1),
    ))
}

/// Go `pem.EncodeToMemory` 와 같은 모양이다(64자 줄, `\n`).
fn pem_encode(kind: &str, der: &[u8]) -> Vec<u8> {
    let b64 = STANDARD.encode(der);
    let mut out = format!("-----BEGIN {kind}-----\n");
    for chunk in b64.as_bytes().chunks(PEM_LINE) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {kind}-----\n"));
    out.into_bytes()
}

struct PemBlock {
    kind: String,
    bytes: Vec<u8>,
}

/// Go `pem.Decode` 를 되풀이한 결과다. 모양이 틀린 블록은 건너뛴다. 머리줄(`Key: value`)은 버린다.
fn pem_blocks(data: &[u8]) -> Vec<PemBlock> {
    const BEGIN: &str = "-----BEGIN ";
    const DASHES: &str = "-----";
    let text = String::from_utf8_lossy(data);
    let mut out = Vec::new();
    let mut rest: &str = &text;
    loop {
        let start = if rest.starts_with(BEGIN) {
            0
        } else if let Some(i) = rest.find(&format!("\n{BEGIN}")) {
            i + 1
        } else {
            return out;
        };
        let after = &rest[start + BEGIN.len()..];
        let (line, body) = after.split_once('\n').unwrap_or((after, ""));
        let line = line.trim_end_matches([' ', '\t', '\r']);
        let Some(kind) = line.strip_suffix(DASHES) else {
            rest = after;
            continue;
        };
        let end_marker = format!("{DASHES}END {kind}{DASHES}");
        let (content, tail) = if let Some(t) = body.strip_prefix(&end_marker) {
            ("", t)
        } else if let Some(i) = body.find(&format!("\n{end_marker}")) {
            (&body[..i], &body[i + 1 + end_marker.len()..])
        } else {
            rest = after;
            continue;
        };
        let mut lines: Vec<&str> = content.lines().collect();
        if lines.iter().any(|l| l.contains(':')) {
            let blank = lines
                .iter()
                .position(|l| l.trim().is_empty())
                .unwrap_or(lines.len());
            lines.drain(..blank.min(lines.len()));
        }
        let b64: String = lines
            .concat()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        match STANDARD.decode(b64) {
            Ok(bytes) => out.push(PemBlock {
                kind: kind.to_string(),
                bytes,
            }),
            Err(_) => {
                rest = after;
                continue;
            }
        }
        rest = tail;
    }
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
