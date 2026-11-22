//! oid 판정 (FR-OPT-1-11).

const OID_LEN_SHA1: usize = 40;
const OID_LEN_SHA256: usize = 64;

/// s 가 완전한 oid(40 또는 64자리 16진수)인가다.
pub fn is_oid(s: &str) -> bool {
    (s.len() == OID_LEN_SHA1 || s.len() == OID_LEN_SHA256)
        && s.bytes().all(|c| c.is_ascii_hexdigit())
}

/// s 가 모두 0 인 oid 인가다.
pub fn is_null_oid(s: &str) -> bool {
    is_oid(s) && s.bytes().all(|c| c == b'0')
}
