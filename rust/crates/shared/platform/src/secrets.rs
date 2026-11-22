//! OS 비밀 저장소 (CLAUDE_ACCOUNTS_SRS FR-CAC-4). macOS 만 키체인이 있다.
//! macOS 키체인 구현은 이슈 1.4.3 이 채운다.

use std::fmt;

/// 비밀 저장소의 오류. 문구는 Go 와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretsError {
    /// 이 OS 에 비밀 저장소가 없다.
    Unavailable,
    /// `security -i` 로 쓰기에는 값이 너무 길다.
    TooLong,
    Other(String),
}

impl fmt::Display for SecretsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretsError::Unavailable => f.write_str("비밀 저장소가 없습니다"),
            SecretsError::TooLong => f.write_str("keychain write: value too long for security -i"),
            SecretsError::Other(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for SecretsError {}

/// OS 의 비밀 저장소.
pub trait Secrets: Send + Sync {
    fn available(&self) -> bool;
    /// Claude Code 가 키체인 항목에 쓰는 계정명.
    fn account(&self) -> String;
    /// 값을 읽는다. 항목이 없으면 `Ok(None)`.
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, SecretsError>;
    fn set(&self, service: &str, account: &str, value: &str) -> Result<(), SecretsError>;
    /// 항목을 지운다. 없으면 성공이다.
    fn delete(&self, service: &str, account: &str) -> Result<(), SecretsError>;
}

/// 비밀 저장소가 없는 OS 의 구현.
struct NoSecrets;

/// Claude Code 가 키체인 항목에 쓰는 기본 계정명.
const KEYCHAIN_DEFAULT_ACCOUNT: &str = "claude-code-user";

impl Secrets for NoSecrets {
    fn available(&self) -> bool {
        false
    }
    fn account(&self) -> String {
        KEYCHAIN_DEFAULT_ACCOUNT.to_owned()
    }
    fn get(&self, _: &str, _: &str) -> Result<Option<String>, SecretsError> {
        Err(SecretsError::Unavailable)
    }
    fn set(&self, _: &str, _: &str, _: &str) -> Result<(), SecretsError> {
        Err(SecretsError::Unavailable)
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), SecretsError> {
        Ok(())
    }
}

pub(crate) fn current() -> &'static dyn Secrets {
    &NoSecrets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_secrets_contract() {
        let s = NoSecrets;
        assert!(!s.available());
        assert_eq!(s.account(), "claude-code-user");
        assert_eq!(s.get("a", "b"), Err(SecretsError::Unavailable));
        assert_eq!(s.set("a", "b", "c"), Err(SecretsError::Unavailable));
        assert_eq!(s.delete("a", "b"), Ok(()));
        assert_eq!(
            SecretsError::Unavailable.to_string(),
            "비밀 저장소가 없습니다"
        );
    }
}
