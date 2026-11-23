//! 설정·초대의 오류. `Display` 는 Go 의 오류 문구와 같다.

use std::fmt;

use crate::config::MAX_EDGES;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidName,
    InvalidPort,
    InvalidBind,
    InvalidEdge,
    EdgeNotFound,
    /// 지문 앞자리가 간선 둘 이상에 맞는다 (FR-EPR-30).
    Ambiguous,
    /// 허용 폴더·알릴 주소가 틀렸다.
    InvalidNodeField,
    /// 간선이 [`MAX_EDGES`] 개라 더 맺지 못한다 (FR-ATF-80).
    EdgeLimit,
    /// 저장 자체의 실패다. 사유는 로그로만 간다.
    SaveFailed,
    NoInvite,
    BadToken,
    InvalidInvite,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidName => {
                f.write_str("이름은 영문·한글·숫자·`_`·`-` 1~32자(64바이트 이내)입니다")
            }
            Error::InvalidPort => f.write_str("포트는 1~65535 입니다"),
            Error::InvalidBind => f.write_str("듣는 주소는 IP 주소여야 합니다"),
            Error::InvalidEdge => f.write_str("간선 항목의 이름·주소·포트·지문이 틀렸습니다"),
            Error::EdgeNotFound => f.write_str("그 지문의 간선이 없습니다"),
            Error::Ambiguous => f.write_str("지문 앞자리가 간선 둘 이상에 맞습니다"),
            Error::InvalidNodeField => {
                f.write_str("허용 폴더는 절대 경로, 알릴 주소는 IP 주소나 호스트명이어야 합니다")
            }
            Error::EdgeLimit => write!(f, "간선은 최대 {MAX_EDGES} 개입니다"),
            Error::SaveFailed => f.write_str("노드 설정을 저장하지 못했습니다"),
            Error::NoInvite => f.write_str("살아 있는 초대가 없습니다"),
            Error::BadToken => f.write_str("초대 토큰이 맞지 않습니다"),
            Error::InvalidInvite => f.write_str("초대 코드의 모양이 틀렸습니다"),
        }
    }
}

impl std::error::Error for Error {}
