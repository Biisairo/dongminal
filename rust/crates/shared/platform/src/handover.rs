//! 데몬 교체(세션 유지 재시작)의 OS 쪽 (DAEMON_SESSION_KEEP_SRS FR-DSK-13). 구현은 이슈 1.4.6 이 채운다.

use std::fmt;

/// 데몬 교체에 터미널이 내놓는 능력.
pub trait Handover: Send + Sync {
    /// 읽기를 멈춘다. 그 뒤 read 는 바이트를 가져가지 않고 `Frozen` 을 감싼 오류를 돌려준다.
    fn freeze(&self);
    /// freeze 를 되돌린다.
    fn thaw(&self);
    /// 의사 터미널 마스터 쪽 fd. exec 로 넘길 때 쓴다.
    fn master_fd(&self) -> usize;
}

/// freeze 된 터미널의 read 오류. 끝이 아니다 — thaw 뒤에 다시 읽는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frozen;

impl fmt::Display for Frozen {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("터미널 읽기가 멈춰 있다")
    }
}

impl std::error::Error for Frozen {}

/// 오류가 `Frozen` 인지.
pub fn is_frozen(e: &std::io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<Frozen>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_roundtrip() {
        let e = std::io::Error::other(Frozen);
        assert!(is_frozen(&e));
        assert_eq!(e.to_string(), "터미널 읽기가 멈춰 있다");
        assert!(!is_frozen(&std::io::Error::other("x")));
    }
}
