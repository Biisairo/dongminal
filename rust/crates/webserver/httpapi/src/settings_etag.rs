//! 설정 계열 PUT 의 낙관적 동시성 (Go `settings_etag.go`).

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::req::Req;

/// ETag 로 쓰는 지문의 바이트 수다 (16진 16자).
const TAG_BYTES: usize = 8;

/// Go `settingsTag`: JSON 직렬화의 SHA-256 앞 8바이트를 16진으로. 직렬화 실패면 빈 문자열이다.
pub(crate) fn settings_tag<T: Serialize + ?Sized>(v: &T) -> String {
    match dm_gocompat::json::marshal(v) {
        Ok(b) => hex::encode(&Sha256::digest(&b)[..TAG_BYTES]),
        Err(_) => String::new(),
    }
}

/// Go `settingsStale`: `If-Match` 가 있고 지금 지문과 다르면 참이다. 없으면 검사하지 않는다.
pub(crate) fn settings_stale(r: &Req, cur: &str) -> bool {
    let im = r.header("If-Match");
    !im.is_empty() && im != cur
}
