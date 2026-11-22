//! Go 기준선 `dongminal/internal/shared/editorlimit` 의 Rust 포팅.
//!
//! 편집기가 여는 한 파일의 상한이다 (FR-OPT-15-1 · D-OPT-9).

/// 한 파일의 상한이다 (디스크 바이트).
pub const FILE_MAX_BYTES: i64 = 32 << 20;

/// 요청 본문에서 텍스트가 아닌 필드의 여유다.
pub const BODY_ENVELOPE: i64 = 64 << 10;

/// 텍스트 한 바이트가 JSON 문자열에서 차지하는 최악의 바이트 수(`\u00XX`)다 (FR-OPT-16-4).
const JSON_ESCAPE_FACTOR: i64 = 6;

/// 파일 `file_max` 바이트를 JSON 문자열로 싣는 요청 본문의 상한이다.
pub const fn body_max_bytes(file_max: i64) -> i64 {
    file_max * JSON_ESCAPE_FACTOR + BODY_ENVELOPE
}

/// 파일 `file_max` 바이트의 unified diff(부분 스테이징) 출력 상한이다 (FR-OPT-16-4).
pub const fn patch_diff_max_bytes(file_max: i64) -> i64 {
    2 * 2 * file_max + BODY_ENVELOPE
}

/// 이진 판정이 NUL 을 찾는 앞쪽 폭이다 — git 의 휴리스틱과 같은 값이다 (FR-QG-52).
pub const BINARY_SNIFF_BYTES: usize = 8000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_max_bytes() {
        assert_eq!(FILE_MAX_BYTES, 32 << 20);
    }

    #[test]
    fn body_max() {
        assert_eq!(
            body_max_bytes(FILE_MAX_BYTES),
            6 * FILE_MAX_BYTES + BODY_ENVELOPE
        );
        assert_eq!(body_max_bytes(16), 96 + BODY_ENVELOPE);
    }

    #[test]
    fn patch_diff_max() {
        assert_eq!(
            patch_diff_max_bytes(FILE_MAX_BYTES),
            4 * FILE_MAX_BYTES + BODY_ENVELOPE
        );
    }

    #[test]
    fn binary_sniff() {
        assert_eq!(BINARY_SNIFF_BYTES, 8000);
    }
}
