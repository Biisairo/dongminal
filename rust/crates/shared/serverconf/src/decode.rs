//! JSON 디코딩의 한 자리. dm-gocompat 의 디코더(이슈 1.1)가 들어오면 이 파일만 바꾼다.
//! 그때까지 serde_json 으로 읽으며, Go v1 의미 중 null 은 "건드리지 않음" 으로 맞춘다.

use std::collections::BTreeMap;
use std::fmt;

use dm_gocompat::json::RawMessage;
use serde::de::DeserializeOwned;
use serde_json::Value;

#[derive(Debug)]
pub struct DecodeError(String);

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DecodeError {}

fn parse(b: &[u8]) -> Result<Value, DecodeError> {
    serde_json::from_slice(b).map_err(|e| DecodeError(e.to_string()))
}

fn strip_nulls(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|_, x| !x.is_null());
            m.values_mut().for_each(strip_nulls);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_nulls),
        _ => {}
    }
}

/// Go `json.Unmarshal(b, &v)` 에 새 `T::default()` 를 넘긴 결과.
pub(crate) fn unmarshal<T: DeserializeOwned + Default>(b: &[u8]) -> Result<T, DecodeError> {
    let mut v = parse(b)?;
    if v.is_null() {
        return Ok(T::default());
    }
    strip_nulls(&mut v);
    serde_json::from_value(v).map_err(|e| DecodeError(e.to_string()))
}

/// Go `map[string]json.RawMessage` 로 읽기. `null` 은 `None`(nil map)이다.
pub(crate) fn unmarshal_raw_map(
    b: &[u8],
) -> Result<Option<BTreeMap<String, RawMessage>>, DecodeError> {
    match parse(b)? {
        Value::Null => Ok(None),
        Value::Object(m) => Ok(Some(
            m.into_iter()
                .map(|(k, v)| (k, RawMessage(v.to_string().into_bytes())))
                .collect(),
        )),
        other => Err(DecodeError(format!(
            "invalid type: expected object, got {other}"
        ))),
    }
}
