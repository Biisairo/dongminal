use std::fs;

use p256::ecdsa::signature::Verifier;
use tempfile::TempDir;
use x509_parser::prelude::*;

use super::*;

const TESTDATA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata");

#[test]
fn creates() {
    let d = TempDir::new().unwrap();
    let id = load_or_create_identity(d.path()).unwrap();
    let (_, leaf) = parse_x509_certificate(&id.certificate).unwrap();
    let spki = &leaf.tbs_certificate.subject_pki;
    assert_eq!(
        spki.algorithm.algorithm,
        x509_parser::oid_registry::OID_KEY_TYPE_EC_PUBLIC_KEY
    );
    let vk = p256::ecdsa::VerifyingKey::from_sec1_bytes(&spki.subject_public_key.data).unwrap();
    let sig = p256::ecdsa::Signature::from_der(&leaf.signature_value.data).unwrap();
    vk.verify(leaf.tbs_certificate.as_ref(), &sig)
        .expect("자기 서명이 아니다");
    assert_eq!(
        leaf.tbs_certificate.issuer.as_raw(),
        leaf.tbs_certificate.subject.as_raw()
    );
    assert_eq!(leaf.subject().to_string(), "CN=dongminal node");
    let life = leaf.validity().not_after.timestamp() - leaf.validity().not_before.timestamp();
    let want = CERT_VALIDITY.as_secs() as i64;
    assert!((want - 86400..=want + 86400).contains(&life), "{life}");
    assert!(!leaf.is_ca());
    let ku = leaf.key_usage().unwrap().unwrap();
    assert!(ku.critical && ku.value.digital_signature());
    let eku = leaf.extended_key_usage().unwrap().unwrap().value;
    assert!(eku.server_auth && eku.client_auth);
    assert!(
        leaf.tbs_certificate.raw_serial()[0] & 0x80 == 0,
        "serial 이 음수다"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |n: &str| fs::metadata(d.path().join(n)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(dmenv::EDGE_KEY_FILE), 0o600);
        assert_eq!(mode(dmenv::EDGE_CERT_FILE), 0o644);
    }
    let key = fs::read_to_string(d.path().join(dmenv::EDGE_KEY_FILE)).unwrap();
    assert!(
        key.starts_with("-----BEGIN EC PRIVATE KEY-----\n")
            && key.ends_with("-----END EC PRIVATE KEY-----\n")
    );
    assert!(key.lines().all(|l| l.len() <= 64));
}

#[test]
fn fingerprint_is_spki_sha256() {
    let d = TempDir::new().unwrap();
    let id = load_or_create_identity(d.path()).unwrap();
    let (_, leaf) = parse_x509_certificate(&id.certificate).unwrap();
    let want = hex::encode(Sha256::digest(leaf.tbs_certificate.subject_pki.raw));
    assert_eq!(fingerprint_of(&id.certificate).unwrap(), want);
    assert_eq!(id.fingerprint, want);
}

#[test]
fn reads_go_identity() {
    let d = TempDir::new().unwrap();
    for n in [dmenv::EDGE_CERT_FILE, dmenv::EDGE_KEY_FILE] {
        fs::copy(format!("{TESTDATA}/{n}"), d.path().join(n)).unwrap();
    }
    let id = load_or_create_identity(d.path()).unwrap();
    assert_eq!(
        id.fingerprint,
        fs::read_to_string(format!("{TESTDATA}/go-fingerprint.txt")).unwrap()
    );
    assert!(matches!(id.private_key(), PrivateKeyDer::Sec1(_)));
}

#[test]
fn reuses() {
    let d = TempDir::new().unwrap();
    let first = load_or_create_identity(d.path()).unwrap();
    let before = fs::read(d.path().join(dmenv::EDGE_KEY_FILE)).unwrap();
    let second = load_or_create_identity(d.path()).unwrap();
    assert_eq!(first.fingerprint, second.fingerprint);
    assert_eq!(
        before,
        fs::read(d.path().join(dmenv::EDGE_KEY_FILE)).unwrap()
    );
}

#[test]
fn corrupt_fails() {
    let d = TempDir::new().unwrap();
    load_or_create_identity(d.path()).unwrap();
    let key = d.path().join(dmenv::EDGE_KEY_FILE);
    fs::write(&key, b"garbage").unwrap();
    let err = load_or_create_identity(d.path()).unwrap_err();
    assert_eq!(
        err.to_string(),
        "노드 인증서를 읽지 못했습니다: tls: failed to find any PEM data in key input"
    );
    assert_eq!(fs::read(&key).unwrap(), b"garbage");
}

#[test]
fn partial_fails() {
    let d = TempDir::new().unwrap();
    load_or_create_identity(d.path()).unwrap();
    let cert = d.path().join(dmenv::EDGE_CERT_FILE);
    fs::remove_file(&cert).unwrap();
    let err = load_or_create_identity(d.path()).unwrap_err();
    assert_eq!(
        err.to_string(),
        format!(
            "노드 인증서와 키 중 하나만 있습니다 ({}, {}) — 둘 다 지우면 새 신원을 만듭니다",
            cert.display(),
            d.path().join(dmenv::EDGE_KEY_FILE).display()
        )
    );
    assert!(!cert.exists());
}

#[test]
fn cert_write_failure_removes_key() {
    let d = TempDir::new().unwrap();
    let failing = |p: &Path, data: &[u8], m: u32| {
        if p.file_name().is_some_and(|n| n == dmenv::EDGE_CERT_FILE) {
            return Err(io::Error::other("disk full"));
        }
        dm_shared_platform::write_file_atomic(p, data, m)
    };
    let err = load_or_create_with(d.path(), &failing).unwrap_err();
    assert_eq!(err.to_string(), "노드 인증서 저장: disk full");
    assert!(!d.path().join(dmenv::EDGE_KEY_FILE).exists());
    load_or_create_identity(d.path()).unwrap();
}

/// Go 1.27.2 `tls.X509KeyPair` 문구 (testdata 의 Go 인증서로 뽑음).
#[test]
fn key_pair_errors_match_go() {
    let c = fs::read(format!("{TESTDATA}/edge-cert.pem")).unwrap();
    let k = fs::read(format!("{TESTDATA}/edge-key.pem")).unwrap();
    let msg = |a: &[u8], b: &[u8]| parse_identity(a, b).unwrap_err().to_string();
    let p = "노드 인증서를 읽지 못했습니다: ";
    assert_eq!(
        msg(b"x", b"y"),
        format!("{p}tls: failed to find any PEM data in certificate input")
    );
    assert_eq!(
        msg(&c, &c),
        format!("{p}tls: found a certificate rather than a key in the PEM for the private key")
    );
    assert_eq!(
        msg(&k, &k),
        format!(
            "{p}tls: failed to find certificate PEM data in certificate input, but did find a private key; PEM inputs may have been switched"
        )
    );
    assert_eq!(
        msg(&c, b"-----BEGIN FOO-----\nAAAA\n-----END FOO-----\n"),
        format!(
            "{p}tls: failed to find PEM block with type ending in \"PRIVATE KEY\" in key input after skipping PEM blocks of the following types: [FOO]"
        )
    );
    assert!(
        msg(
            &c,
            b"-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\n"
        )
        .starts_with(&format!("{p}tls: failed to parse private key"))
    );
    let d = TempDir::new().unwrap();
    let other = load_or_create_identity(d.path()).unwrap();
    let other_key = fs::read(d.path().join(dmenv::EDGE_KEY_FILE)).unwrap();
    assert_ne!(
        other.fingerprint,
        fingerprint_of(&pem_blocks(&c)[0].bytes).unwrap()
    );
    assert_eq!(
        msg(&c, &other_key),
        format!("{p}tls: private key does not match public key")
    );
}

#[test]
fn pem_round_trip_and_pkcs8() {
    let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let pk8 = pem_encode("PRIVATE KEY", &kp.serialize_der());
    let blocks = pem_blocks(&[b"junk\n".as_slice(), &pk8, &pk8].concat());
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].kind, "PRIVATE KEY");
    assert_eq!(blocks[0].bytes, kp.serialize_der());
}
