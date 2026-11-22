//! Go `encoding/json` 의 관측 규칙.
//!
//! 인코딩은 serde `Serialize` 를 받는다. Go 와 같은 출력을 내려면 다음을 지킨다.
//! - 구조체 필드 순서는 Rust 선언 순서다. Go 구조체와 같은 순서로 선언한다.
//! - `omitempty` 는 `#[serde(skip_serializing_if = "dm_gocompat::json::is_empty")]` 로 쓴다.
//! - Go `[]byte` 는 `#[serde(with = "dm_gocompat::json::bytes")]` 로 base64 문자열이 된다.
//! - Go 의 nil slice·nil map·nil 포인터(`null`)는 `Option<…>` 의 `None` 으로 쓴다. 빈 `Vec` 은 `[]` 이다.
//! - map(`HashMap`·`BTreeMap`·`serde_json::Value` 객체)은 Go map 처럼 키 바이트 순으로 정렬된다.
//! - `json.RawMessage` 는 [`RawMessage`] 다.
//! - `serde_json::to_*` 로 쓰면 이 규칙이 적용되지 않는다. 출력은 늘 이 모듈로 만든다.
//!
//! 디코딩([`unmarshal`]·[`Decoder`])은 serde `Deserialize` 를 받는다. go1.27 의 v1 의미를 따른다.
//! - 구조체에는 `#[serde(default)]` 를 단다. Go 는 없는 필드를 0 값으로 두고 오류를 내지 않는다.
//! - 필드 이름은 정확히 같은 것이 먼저, 없으면 대소문자를 무시하고 맞춘다(`_`·`-` 는 구별한다).
//!   알 수 없는 키는 무시한다. 원래 키가 필요하면 같은 입력을 `BTreeMap<String, RawMessage>` 로도 푼다.
//! - 같은 필드의 키가 여럿이면 마지막 값이 이긴다. 객체끼리는 합치고, 뒤의 `null` 은 무시한다.
//! - `null` 은 값을 바꾸지 않는다(0 값으로 남는다). `Option` 은 `None` 이 된다.
//! - `serde_json::Value` 로 풀면 숫자는 Go `float64` 와 같은 값이 된다(±2^53 안의 정수는 i64 로 담는다).
//! - 오류 문구는 go1.27.2 실측과 같다. 타입 이름은 Rust 타입에서 고른다: i64 → `int`, u64 → `uint`,
//!   i32 → `int32`, f64 → `float64`, String → `string`, `[]byte` → `[]uint8`, 구조체는 serde 이름
//!   (Go 와 같게 하려면 `#[serde(rename = "pkg.Type")]`). slice·map 의 원소 타입은 알 수 없어
//!   `slice`·`map` 으로 쓴다(Go 는 `[]int`·`map[string]int`).
//! - Go 는 타입 오류가 나도 나머지 필드를 채운 값을 남기지만, 여기서는 값을 돌려주지 않는다.

mod decode;
mod encode;
mod parse;
mod scanner;

use std::fmt;

pub use decode::{Decoder, unmarshal};
pub use encode::{Encoder, append_string, marshal, marshal_indent};
pub use scanner::{SyntaxError, compact, indent, valid};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// 인코딩·디코딩 오류. `Display` 는 Go 의 `err.Error()` 와 같은 문구다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    msg: String,
}

impl Error {
    pub(crate) fn new(msg: String) -> Self {
        Self { msg }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.msg)
    }
}

impl std::error::Error for Error {}

impl From<SyntaxError> for Error {
    fn from(e: SyntaxError) -> Self {
        Self::new(e.msg)
    }
}

impl serde::ser::Error for Error {
    fn custom<T: fmt::Display>(msg: T) -> Self {
        Self::new(msg.to_string())
    }
}

impl serde::de::Error for Error {
    fn custom<T: fmt::Display>(msg: T) -> Self {
        Self::new(msg.to_string())
    }
}

/// Go `json.RawMessage`. 인코딩하면 내용을 compact 하고 HTML 이스케이프한다. 비어 있으면 `null`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct RawMessage(pub Vec<u8>);

struct RawBytes<'a>(&'a [u8]);

impl Serialize for RawBytes<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(self.0)
    }
}

impl Serialize for RawMessage {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_newtype_struct(encode::RAW_TOKEN, &RawBytes(&self.0))
    }
}

struct RawVisitor;

impl serde::de::Visitor<'_> for RawVisitor {
    type Value = RawMessage;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("raw JSON")
    }
    fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<RawMessage, E> {
        Ok(RawMessage(v.to_vec()))
    }
    fn visit_byte_buf<E: serde::de::Error>(self, v: Vec<u8>) -> Result<RawMessage, E> {
        Ok(RawMessage(v))
    }
}

impl<'de> Deserialize<'de> for RawMessage {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_newtype_struct(encode::RAW_TOKEN, RawVisitor)
    }
}

/// Go `omitempty` 의 "빈 값": false, 0, "", 길이 0 인 slice·map, nil(`None`).
pub trait IsEmpty {
    fn is_go_empty(&self) -> bool;
}

/// `#[serde(skip_serializing_if = "dm_gocompat::json::is_empty")]` 용.
pub fn is_empty<T: IsEmpty + ?Sized>(v: &T) -> bool {
    v.is_go_empty()
}

macro_rules! empty_zero {
    ($($t:ty),*) => {
        $(impl IsEmpty for $t {
            fn is_go_empty(&self) -> bool {
                *self == <$t>::default()
            }
        })*
    };
}

empty_zero!(
    bool, i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize, f32, f64
);

impl IsEmpty for str {
    fn is_go_empty(&self) -> bool {
        self.is_empty()
    }
}

impl IsEmpty for String {
    fn is_go_empty(&self) -> bool {
        self.is_empty()
    }
}

impl<T> IsEmpty for Vec<T> {
    fn is_go_empty(&self) -> bool {
        self.is_empty()
    }
}

impl<T> IsEmpty for [T] {
    fn is_go_empty(&self) -> bool {
        self.is_empty()
    }
}

impl<K, V, S> IsEmpty for std::collections::HashMap<K, V, S> {
    fn is_go_empty(&self) -> bool {
        self.is_empty()
    }
}

impl<K, V> IsEmpty for std::collections::BTreeMap<K, V> {
    fn is_go_empty(&self) -> bool {
        self.is_empty()
    }
}

impl IsEmpty for serde_json::Map<String, serde_json::Value> {
    fn is_go_empty(&self) -> bool {
        self.is_empty()
    }
}

/// Go 포인터·interface 는 nil 일 때만 비었다. 가리키는 값이 0 이어도 비지 않았다.
impl<T> IsEmpty for Option<T> {
    fn is_go_empty(&self) -> bool {
        self.is_none()
    }
}

impl IsEmpty for RawMessage {
    fn is_go_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Go `interface{}` 필드(`serde_json::Value`): `null` 만 비었다.
impl IsEmpty for serde_json::Value {
    fn is_go_empty(&self) -> bool {
        self.is_null()
    }
}

/// Go `[]byte` 필드: `#[serde(with = "dm_gocompat::json::bytes")]`. base64(StdEncoding) 문자열.
pub mod bytes {
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(v)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        d.deserialize_byte_buf(super::BytesVisitor)
    }
}

/// nil 일 수 있는 Go `[]byte` 필드: `Option<Vec<u8>>` 에 `#[serde(with = "dm_gocompat::json::opt_bytes")]`. `None` 은 `null`.
pub mod opt_bytes {
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(b) => s.serialize_bytes(b),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        d.deserialize_option(super::OptBytesVisitor)
    }
}

struct OptBytesVisitor;

impl<'de> serde::de::Visitor<'de> for OptBytesVisitor {
    type Value = Option<Vec<u8>>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("base64 string or null")
    }
    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_byte_buf(BytesVisitor).map(Some)
    }
}

pub(crate) struct BytesVisitor;

impl serde::de::Visitor<'_> for BytesVisitor {
    type Value = Vec<u8>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("base64 string")
    }
    fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<Vec<u8>, E> {
        Ok(v.to_vec())
    }
    fn visit_byte_buf<E: serde::de::Error>(self, v: Vec<u8>) -> Result<Vec<u8>, E> {
        Ok(v)
    }
    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Vec<u8>, E> {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(v)
            .map_err(E::custom)
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Vec<u8>, E> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod decode_tests;
#[cfg(test)]
mod parse_tests;
#[cfg(test)]
mod tests;
