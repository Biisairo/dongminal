//! Go 구조체 임베드의 JSON 모양과 `map[string]any` 응답의 조립.
//!
//! 임베드: 안쪽 값의 필드가 먼저 오고 바깥 필드가 뒤를 잇는다. 바깥에 같은 이름이 있으면 —
//! `omitempty` 로 빠졌더라도 — 안쪽 필드는 가려진다(Go 의 얕은 필드 우선).

use std::collections::BTreeMap;

use otter_gocompat::json::{self, RawMessage};
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Go `map[string]any`. 직렬화할 때 키 순서로 정렬된다.
pub(crate) type Obj = BTreeMap<&'static str, RawMessage>;

/// 값 하나를 `Obj` 의 칸으로 만든다.
pub(crate) fn raw<T: Serialize + ?Sized>(v: &T) -> RawMessage {
    RawMessage(json::marshal(v).unwrap_or_default())
}

/// `inner` 를 임베드한 구조체다. `hide` 는 바깥이 가진 이름 중 안쪽과 겹치는 것이다.
pub(crate) struct Embed<'a, I: ?Sized, O> {
    pub(crate) inner: &'a I,
    pub(crate) hide: &'static [&'static str],
    pub(crate) outer: O,
}

/// 최상위 필드를 나온 순서대로, 값은 직렬화된 바이트 그대로 담는다.
struct Fields(Vec<(String, RawMessage)>);

struct FieldsVisitor;

impl<'de> Visitor<'de> for FieldsVisitor {
    type Value = Fields;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JSON object")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Fields, A::Error> {
        let mut out = Vec::new();
        while let Some(kv) = m.next_entry::<String, RawMessage>()? {
            out.push(kv);
        }
        Ok(Fields(out))
    }
}

impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_map(FieldsVisitor)
    }
}

fn fields<T: Serialize + ?Sized>(v: &T) -> Result<Vec<(String, RawMessage)>, json::Error> {
    Ok(json::unmarshal::<Fields>(&json::marshal(v)?)?.0)
}

impl<I: Serialize + ?Sized, O: Serialize> Serialize for Embed<'_, I, O> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let err = serde::ser::Error::custom;
        let inner = fields(self.inner).map_err(err)?;
        let outer = fields(&self.outer).map_err(err)?;
        let mut out = vec![b'{'];
        let shown = inner
            .iter()
            .filter(|(k, _)| !self.hide.contains(&k.as_str()) && !outer.iter().any(|(o, _)| o == k))
            .chain(outer.iter());
        for (i, (k, v)) in shown.enumerate() {
            if i > 0 {
                out.push(b',');
            }
            out.extend(json::marshal(k).map_err(err)?);
            out.push(b':');
            out.extend_from_slice(&v.0);
        }
        out.push(b'}');
        RawMessage(out).serialize(s)
    }
}
