//! Go 표준 라이브러리의 관측 규칙(JSON·flag·시간·오류 문자열)을 흉내 내는 공통 코드 (RUST_PORT_SRS FR-RSP-32).

pub mod fmt;
pub mod json;
pub mod oserr;
pub mod strconv;
pub mod time;

#[cfg(test)]
mod testutil;
