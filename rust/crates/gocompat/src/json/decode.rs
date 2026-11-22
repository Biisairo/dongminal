//! go1.27 `json.Unmarshal`(JSONv2 기본, v1 호환 옵션) 의 관측 의미를 serde `Deserializer` 로 구현한다.

use serde::de::{self, DeserializeOwned, IntoDeserializer, Visitor};

use super::encode::RAW_TOKEN;
use super::parse::{Node, Value, parse_document, parse_prefix};
use super::{Error, ErrorKind};

/// 정수로 정확히 담기는 범위(float64 의 정수 정밀도). `any` 로 풀 때 이 범위의 정수는 i64 로 넘긴다.
const MAX_EXACT_INT: i64 = 1 << 53;

/// 디코딩 중첩 깊이 상한. serde 는 재귀로 풀기 때문에 스택을 지키려고 둔다.
/// Go 는 10000 까지 받으므로 이보다 깊은 입력에서만 Go 와 다르다(구문 검사는 10000 까지 Go 와 같다).
const MAX_DECODE_DEPTH: usize = 512;

/// 타입 이름을 받지 못한 slice·map 의 기본 이름. Go 의 `[]any`·`map[string]any` 와 같다.
const DEFAULT_SLICE_TYPE: &str = "[]interface {}";
const DEFAULT_MAP_TYPE: &str = "map[string]interface {}";

/// [`GoTypeName::TOKEN`] 의 앞부분. 뒤에 Go 타입 이름이 붙는다.
pub const GO_TYPE_TOKEN: &str = "$dm_gocompat::json::go_type::";

/// 타입 오류 문구에 쓸 Go 타입 이름을 지닌 표식. [`go_type!`](crate::go_type) 으로 만든다.
pub trait GoTypeName {
    /// `GO_TYPE_TOKEN` + Go 타입 이름.
    const TOKEN: &'static str;
}

/// 필드의 Go 타입 이름을 정한다:
/// `#[serde(deserialize_with = "dm_gocompat::json::with_go_type::<표식, _, _>")]`.
/// 이 crate 밖의 serde 디코더에서는 아무 일도 하지 않는다.
pub fn with_go_type<'de, N: GoTypeName, T: de::Deserialize<'de>, D: de::Deserializer<'de>>(
    d: D,
) -> Result<T, D::Error> {
    struct Named<T>(std::marker::PhantomData<T>);
    impl<'de, T: de::Deserialize<'de>> Visitor<'de> for Named<T> {
        type Value = T;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a value")
        }
        fn visit_newtype_struct<D: de::Deserializer<'de>>(self, d: D) -> Result<T, D::Error> {
            T::deserialize(d)
        }
    }
    d.deserialize_newtype_struct(N::TOKEN, Named(std::marker::PhantomData))
}

/// 맨 위 값의 Go 타입 이름을 정하는 감싸개: `unmarshal::<GoTyped<표식, Vec<X>>>(..)`.
#[derive(Debug, Clone, PartialEq)]
pub struct GoTyped<N, T>(pub T, std::marker::PhantomData<N>);

impl<N, T> GoTyped<N, T> {
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<'de, N: GoTypeName, T: de::Deserialize<'de>> de::Deserialize<'de> for GoTyped<N, T> {
    fn deserialize<D: de::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        with_go_type::<N, T, D>(d).map(|v| GoTyped(v, std::marker::PhantomData))
    }
}

/// Go 타입 이름 표식을 만든다. 예: `dm_gocompat::go_type!(pub WsWindows = "[]workspace.WsWindow");`
#[macro_export]
macro_rules! go_type {
    ($vis:vis $name:ident = $go:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        $vis struct $name;
        impl $crate::json::GoTypeName for $name {
            const TOKEN: &'static str = concat!("$dm_gocompat::json::go_type::", $go);
        }
    };
}

struct Ctx {
    /// 입력의 시작 주소. 값의 offset 을 셀 때 쓴다.
    base: usize,
    root: String,
    disallow_unknown: bool,
}

fn type_error(ctx: &Ctx, path: &[String], value: &str, go_type: &str, offset: i64) -> Error {
    let field = path.join(".");
    let kind = |struct_name: &str| ErrorKind::Type {
        value: value.to_owned(),
        field: field.clone(),
        struct_name: struct_name.to_owned(),
        go_type: go_type.to_owned(),
        offset,
    };
    if field.is_empty() {
        return Error::with_kind(
            format!("json: cannot unmarshal {value} into Go value of type {go_type}"),
            kind(""),
        );
    }
    let last = field.rsplit('.').next().unwrap_or("");
    let into = if !last.is_empty() && last.bytes().all(|c| c.is_ascii_digit()) {
        ""
    } else {
        "Go struct field "
    };
    Error::with_kind(
        format!(
            "json: cannot unmarshal {value} into {into}{}.{field} of type {go_type}",
            ctx.root
        ),
        kind(&ctx.root),
    )
}

fn kind_of(node: &Node<'_>) -> &'static str {
    match node {
        Node::Null => "null",
        Node::Bool(_) => "bool",
        Node::Number(_) => "number",
        Node::String(_) => "string",
        Node::Array(_) => "array",
        Node::Object(_) => "object",
    }
}

/// Go v1 의 이름 접기: ASCII 는 대문자로, `_`·`-` 는 그대로 둔다(MatchCaseSensitiveDelimiter).
fn fold(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if c.is_ascii() {
                vec![c.to_ascii_uppercase()]
            } else {
                c.to_uppercase().collect()
            }
        })
        .collect()
}

fn short_name(name: &str) -> String {
    name.rsplit('.').next().unwrap_or(name).to_owned()
}

struct De<'c, 'a> {
    v: Value<'a>,
    ctx: &'c mut Ctx,
    path: Vec<String>,
    /// [`with_go_type`] 로 받은 Go 타입 이름. 이 값의 타입 오류에만 쓴다(자식에게 넘기지 않는다).
    go_type: Option<&'static str>,
}

macro_rules! de_int {
    ($($method:ident => $visit:ident, $t:ty, $go:expr);* $(;)?) => {
        $(fn $method<V: Visitor<'de>>(mut self, visitor: V) -> Result<V::Value, Error> {
            match self.v.take_node() {
                Node::Null => visitor.$visit(0),
                Node::Number(n) => match n.parse::<$t>() {
                    Ok(x) => visitor.$visit(x),
                    Err(_) => Err(self.err(&format!("number {n}"), $go)),
                },
                other => Err(self.err(kind_of(&other), $go)),
            }
        })*
    };
}

impl De<'_, '_> {
    fn err(&self, value: &str, go_type: &str) -> Error {
        let go_type = self.go_type.unwrap_or(go_type);
        type_error(self.ctx, &self.path, value, go_type, self.offset())
    }

    /// Go `UnmarshalTypeError.Offset`: 스칼라는 값의 끝, 객체·배열은 여는 괄호 다음.
    fn offset(&self) -> i64 {
        let start = (self.v.raw.as_ptr() as usize).saturating_sub(self.ctx.base);
        let end = match self.v.raw.first() {
            Some(b'{' | b'[') => start + 1,
            _ => start + self.v.raw.len(),
        };
        i64::try_from(end).unwrap_or(i64::MAX)
    }

    /// 컨테이너로 들어가기 전에 부른다. 경로 길이가 곧 중첩 깊이다.
    fn check_depth(&self) -> Result<(), Error> {
        if self.path.len() >= MAX_DECODE_DEPTH {
            return Err(Error::new("exceeded max depth".to_owned()));
        }
        Ok(())
    }
}

impl<'de> de::Deserializer<'de> for De<'_, '_> {
    type Error = Error;

    fn deserialize_any<V: Visitor<'de>>(mut self, visitor: V) -> Result<V::Value, Error> {
        self.check_depth()?;
        match self.v.take_node() {
            Node::Null => visitor.visit_unit(),
            Node::Bool(b) => visitor.visit_bool(b),
            Node::Number(n) => {
                let integral = !n.contains(['.', 'e', 'E']) && n != "-0";
                if integral
                    && let Ok(i) = n.parse::<i64>()
                    && (-MAX_EXACT_INT..=MAX_EXACT_INT).contains(&i)
                {
                    return visitor.visit_i64(i);
                }
                match n.parse::<f64>() {
                    Ok(f) if f.is_finite() => visitor.visit_f64(f),
                    _ => Err(self.err(&format!("number {n}"), "float64")),
                }
            }
            Node::String(s) => visitor.visit_string(s),
            Node::Array(items) => visitor.visit_seq(Seq::new(items, self.ctx, self.path)),
            Node::Object(members) => visitor.visit_map(Map::new(members, self.ctx, self.path)),
        }
    }

    fn deserialize_bool<V: Visitor<'de>>(mut self, visitor: V) -> Result<V::Value, Error> {
        match self.v.take_node() {
            Node::Null => visitor.visit_bool(false),
            Node::Bool(b) => visitor.visit_bool(b),
            other => Err(self.err(kind_of(&other), "bool")),
        }
    }

    de_int! {
        deserialize_i8 => visit_i8, i8, "int8";
        deserialize_i16 => visit_i16, i16, "int16";
        deserialize_i32 => visit_i32, i32, "int32";
        deserialize_i64 => visit_i64, i64, "int";
        deserialize_i128 => visit_i128, i128, "int";
        deserialize_u8 => visit_u8, u8, "uint8";
        deserialize_u16 => visit_u16, u16, "uint16";
        deserialize_u32 => visit_u32, u32, "uint32";
        deserialize_u64 => visit_u64, u64, "uint";
        deserialize_u128 => visit_u128, u128, "uint";
    }

    fn deserialize_f32<V: Visitor<'de>>(mut self, visitor: V) -> Result<V::Value, Error> {
        match self.v.take_node() {
            Node::Null => visitor.visit_f32(0.0),
            Node::Number(n) => match n.parse::<f32>() {
                Ok(f) if f.is_finite() => visitor.visit_f32(f),
                _ => Err(self.err(&format!("number {n}"), "float32")),
            },
            other => Err(self.err(kind_of(&other), "float32")),
        }
    }

    fn deserialize_f64<V: Visitor<'de>>(mut self, visitor: V) -> Result<V::Value, Error> {
        match self.v.take_node() {
            Node::Null => visitor.visit_f64(0.0),
            Node::Number(n) => match n.parse::<f64>() {
                Ok(f) if f.is_finite() => visitor.visit_f64(f),
                _ => Err(self.err(&format!("number {n}"), "float64")),
            },
            other => Err(self.err(kind_of(&other), "float64")),
        }
    }

    fn deserialize_char<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_string(visitor)
    }

    fn deserialize_str<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_string(visitor)
    }

    fn deserialize_string<V: Visitor<'de>>(mut self, visitor: V) -> Result<V::Value, Error> {
        match self.v.take_node() {
            Node::Null => visitor.visit_string(String::new()),
            Node::String(s) => visitor.visit_string(s),
            other => Err(self.err(kind_of(&other), "string")),
        }
    }

    fn deserialize_bytes<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_byte_buf(visitor)
    }

    fn deserialize_byte_buf<V: Visitor<'de>>(mut self, visitor: V) -> Result<V::Value, Error> {
        match self.v.take_node() {
            Node::Null => visitor.visit_byte_buf(Vec::new()),
            Node::String(s) => match decode_base64(&s) {
                Ok(b) => visitor.visit_byte_buf(b),
                Err(at) => {
                    let e = self.err("string", "[]uint8");
                    let kind = e.kind().clone();
                    Err(Error::with_kind(
                        format!("{e}: illegal base64 data at input byte {at}"),
                        kind,
                    ))
                }
            },
            other => Err(self.err(kind_of(&other), "[]uint8")),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if matches!(self.v.node, Node::Null) {
            return visitor.visit_none();
        }
        visitor.visit_some(self)
    }

    fn deserialize_unit<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        visitor.visit_unit()
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        visitor.visit_unit()
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        if name == RAW_TOKEN {
            return visitor.visit_byte_buf(self.v.raw.to_vec());
        }
        if let Some(go) = name.strip_prefix(GO_TYPE_TOKEN) {
            return visitor.visit_newtype_struct(De {
                go_type: Some(go),
                ..self
            });
        }
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_seq<V: Visitor<'de>>(mut self, visitor: V) -> Result<V::Value, Error> {
        self.check_depth()?;
        match self.v.take_node() {
            Node::Null => visitor.visit_seq(Seq::new(Vec::new(), self.ctx, self.path)),
            Node::Array(items) => visitor.visit_seq(Seq::new(items, self.ctx, self.path)),
            other => Err(self.err(kind_of(&other), DEFAULT_SLICE_TYPE)),
        }
    }

    fn deserialize_tuple<V: Visitor<'de>>(
        self,
        _len: usize,
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.deserialize_seq(visitor)
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _len: usize,
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.deserialize_seq(visitor)
    }

    fn deserialize_map<V: Visitor<'de>>(mut self, visitor: V) -> Result<V::Value, Error> {
        self.check_depth()?;
        match self.v.take_node() {
            Node::Null => visitor.visit_map(Map::new(Vec::new(), self.ctx, self.path)),
            Node::Object(members) => visitor.visit_map(Map::new(members, self.ctx, self.path)),
            other => Err(self.err(kind_of(&other), DEFAULT_MAP_TYPE)),
        }
    }

    fn deserialize_struct<V: Visitor<'de>>(
        mut self,
        name: &'static str,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.check_depth()?;
        if self.path.is_empty() && self.ctx.root.is_empty() {
            self.ctx.root = short_name(name);
        }
        match self.v.take_node() {
            Node::Null => visitor.visit_map(Map::new(Vec::new(), self.ctx, self.path)),
            Node::Object(members) => {
                let members = resolve_fields(members, fields, self.ctx.disallow_unknown)?;
                visitor.visit_map(Map::new(members, self.ctx, self.path))
            }
            other => Err(self.err(kind_of(&other), name)),
        }
    }

    fn deserialize_enum<V: Visitor<'de>>(
        mut self,
        name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.check_depth()?;
        match self.v.take_node() {
            Node::String(s) => visitor.visit_enum(IntoDeserializer::<Error>::into_deserializer(s)),
            Node::Object(mut members) if members.len() == 1 => {
                let (key, value) = members.remove(0);
                visitor.visit_enum(Enum {
                    key,
                    value,
                    ctx: self.ctx,
                    path: self.path,
                })
            }
            other => Err(self.err(kind_of(&other), name)),
        }
    }

    fn deserialize_identifier<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_string(visitor)
    }

    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        visitor.visit_unit()
    }
}

/// 구조체 필드 매칭: 정확히 같은 이름이 먼저, 없으면 대소문자 무시(`_`·`-` 는 구별).
/// 같은 필드로 가는 키가 여럿이면 마지막 값이 이긴다. 다만 객체끼리는 Go 처럼 합치고, 뒤의 null 은 무시한다.
fn resolve_fields<'a>(
    members: Vec<(String, Value<'a>)>,
    fields: &'static [&'static str],
    disallow_unknown: bool,
) -> Result<Vec<(String, Value<'a>)>, Error> {
    let folded: Vec<String> = fields.iter().map(|f| fold(f)).collect();
    let mut out: Vec<(String, Value<'a>)> = Vec::with_capacity(members.len());
    // 필드 위치 → out 안의 위치. 중복 키를 상수 시간에 찾는다.
    let mut slot_of: Vec<Option<usize>> = vec![None; fields.len()];
    for (key, value) in members {
        let field = fields.iter().position(|f| *f == key).or_else(|| {
            let k = fold(&key);
            folded.iter().position(|f| *f == k)
        });
        let Some(fi) = field else {
            if disallow_unknown {
                return Err(Error::new(format!(
                    "json: unknown field {}",
                    crate::strconv::quote(&key)
                )));
            }
            out.push((key, value));
            continue;
        };
        match slot_of[fi] {
            Some(at) => merge_into(&mut out[at].1, value),
            None => {
                slot_of[fi] = Some(out.len());
                out.push((fields[fi].to_owned(), value));
            }
        }
    }
    Ok(out)
}

fn merge_into<'a>(dst: &mut Value<'a>, mut src: Value<'a>) {
    // Go v1: null 은 이미 있는 값을 건드리지 않는다.
    if matches!(src.node, Node::Null) {
        return;
    }
    if let (Node::Object(old), Node::Object(_)) = (&mut dst.node, &src.node)
        && let Node::Object(new) = src.take_node()
    {
        old.extend(new);
        return;
    }
    *dst = src;
}

/// Go `base64.StdEncoding.DecodeString` 처럼 `\r`·`\n` 을 건너뛰고 푼다. 실패하면 Go 가 말하는 입력 위치.
fn decode_base64(s: &str) -> Result<Vec<u8>, usize> {
    use base64::Engine as _;
    let cleaned: Vec<u8> = s.bytes().filter(|&c| c != b'\r' && c != b'\n').collect();
    base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .map_err(|e| match e {
            base64::DecodeError::InvalidByte(at, _) => at,
            base64::DecodeError::InvalidLastSymbol { offset, .. } => offset,
            _ => cleaned.len() / 4 * 4,
        })
}

struct Seq<'c, 'a> {
    items: std::vec::IntoIter<Value<'a>>,
    ctx: &'c mut Ctx,
    path: Vec<String>,
    index: usize,
}

impl<'c, 'a> Seq<'c, 'a> {
    fn new(items: Vec<Value<'a>>, ctx: &'c mut Ctx, path: Vec<String>) -> Self {
        Self {
            items: items.into_iter(),
            ctx,
            path,
            index: 0,
        }
    }
}

impl<'de> de::SeqAccess<'de> for Seq<'_, '_> {
    type Error = Error;

    fn next_element_seed<T: de::DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> Result<Option<T::Value>, Error> {
        let Some(v) = self.items.next() else {
            return Ok(None);
        };
        let mut path = self.path.clone();
        path.push(self.index.to_string());
        self.index += 1;
        seed.deserialize(De {
            v,
            ctx: self.ctx,
            path,
            go_type: None,
        })
        .map(Some)
    }
}

struct Map<'c, 'a> {
    members: std::vec::IntoIter<(String, Value<'a>)>,
    pending: Option<(String, Value<'a>)>,
    ctx: &'c mut Ctx,
    path: Vec<String>,
}

impl<'c, 'a> Map<'c, 'a> {
    fn new(members: Vec<(String, Value<'a>)>, ctx: &'c mut Ctx, path: Vec<String>) -> Self {
        Self {
            members: members.into_iter(),
            pending: None,
            ctx,
            path,
        }
    }
}

impl<'de> de::MapAccess<'de> for Map<'_, '_> {
    type Error = Error;

    fn next_key_seed<K: de::DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Error> {
        let Some((key, value)) = self.members.next() else {
            return Ok(None);
        };
        let k = seed.deserialize(Key {
            key: key.clone(),
            ctx: self.ctx,
            path: &self.path,
        })?;
        self.pending = Some((key, value));
        Ok(Some(k))
    }

    fn next_value_seed<V: de::DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Error> {
        let (key, v) = self
            .pending
            .take()
            .ok_or_else(|| Error::new("json: map value without key".to_owned()))?;
        let mut path = self.path.clone();
        path.push(key);
        seed.deserialize(De {
            v,
            ctx: self.ctx,
            path,
            go_type: None,
        })
    }
}

/// map 키. 정수 키는 Go 처럼 문자열을 정수로 푼다.
struct Key<'c, 'p> {
    key: String,
    ctx: &'c Ctx,
    path: &'p [String],
}

macro_rules! key_int {
    ($($method:ident => $visit:ident, $t:ty, $go:expr);* $(;)?) => {
        $(fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
            match self.key.parse::<$t>() {
                Ok(x) => visitor.$visit(x),
                Err(_) => {
                    let mut path = self.path.to_vec();
                    path.push(self.key.clone());
                    Err(type_error(self.ctx, &path, &format!("number {}", self.key), $go, 0))
                }
            }
        })*
    };
}

impl<'de> de::Deserializer<'de> for Key<'_, '_> {
    type Error = Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        visitor.visit_string(self.key)
    }

    key_int! {
        deserialize_i8 => visit_i8, i8, "int8";
        deserialize_i16 => visit_i16, i16, "int16";
        deserialize_i32 => visit_i32, i32, "int32";
        deserialize_i64 => visit_i64, i64, "int";
        deserialize_u8 => visit_u8, u8, "uint8";
        deserialize_u16 => visit_u16, u16, "uint16";
        deserialize_u32 => visit_u32, u32, "uint32";
        deserialize_u64 => visit_u64, u64, "uint";
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        visitor.visit_enum(IntoDeserializer::<Error>::into_deserializer(self.key))
    }

    serde::forward_to_deserialize_any! {
        bool i128 u128 f32 f64 char str string bytes byte_buf option unit unit_struct
        seq tuple tuple_struct map struct identifier ignored_any
    }
}

struct Enum<'c, 'a> {
    key: String,
    value: Value<'a>,
    ctx: &'c mut Ctx,
    path: Vec<String>,
}

impl<'de, 'c, 'a> de::EnumAccess<'de> for Enum<'c, 'a> {
    type Error = Error;
    type Variant = De<'c, 'a>;

    fn variant_seed<V: de::DeserializeSeed<'de>>(
        self,
        seed: V,
    ) -> Result<(V::Value, Self::Variant), Error> {
        let variant = seed.deserialize(IntoDeserializer::<Error>::into_deserializer(
            self.key.clone(),
        ))?;
        let mut path = self.path;
        path.push(self.key);
        Ok((
            variant,
            De {
                v: self.value,
                ctx: self.ctx,
                path,
                go_type: None,
            },
        ))
    }
}

impl<'de> de::VariantAccess<'de> for De<'_, '_> {
    type Error = Error;

    fn unit_variant(self) -> Result<(), Error> {
        Ok(())
    }

    fn newtype_variant_seed<T: de::DeserializeSeed<'de>>(self, seed: T) -> Result<T::Value, Error> {
        seed.deserialize(self)
    }

    fn tuple_variant<V: Visitor<'de>>(self, _len: usize, visitor: V) -> Result<V::Value, Error> {
        de::Deserializer::deserialize_seq(self, visitor)
    }

    fn struct_variant<V: Visitor<'de>>(
        self,
        fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        de::Deserializer::deserialize_struct(self, "", fields, visitor)
    }
}

fn decode_value<T: DeserializeOwned>(
    data: &[u8],
    v: Value<'_>,
    disallow_unknown: bool,
) -> Result<T, Error> {
    let mut ctx = Ctx {
        base: data.as_ptr() as usize,
        root: String::new(),
        disallow_unknown,
    };
    T::deserialize(De {
        v,
        ctx: &mut ctx,
        path: Vec::new(),
        go_type: None,
    })
}

/// Go `json.Unmarshal`. 입력 전체가 JSON 값 하나여야 하고, 구문 오류가 타입 오류보다 먼저다.
pub fn unmarshal<T: DeserializeOwned>(data: &[u8]) -> Result<T, Error> {
    let v = parse_document(data)?;
    decode_value(data, v, false)
}

/// Go `json.NewDecoder(r)` 로 값 하나를 읽는 경우. 입력은 이미 읽어 둔 바이트다.
#[derive(Debug, Clone, Default)]
pub struct Decoder {
    disallow_unknown: bool,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Go `Decoder.DisallowUnknownFields`. 구조체에 없는 키가 있으면 `json: unknown field "k"`.
    pub fn disallow_unknown_fields(&mut self) -> &mut Self {
        self.disallow_unknown = true;
        self
    }

    /// Go `Decoder.Decode` 를 한 번 부른 결과. 앞의 값 하나만 읽고 뒤의 바이트는 보지 않는다.
    /// 값이 없으면(빈 입력·공백뿐) `EOF`, 값이 중간에 끊기면 `unexpected EOF` 다.
    pub fn decode<T: DeserializeOwned>(&self, data: &[u8]) -> Result<T, Error> {
        if data
            .iter()
            .all(|&c| matches!(c, b' ' | b'\t' | b'\r' | b'\n'))
        {
            return Err(Error::with_kind("EOF".to_owned(), ErrorKind::Eof));
        }
        let (v, _) = parse_prefix(data).map_err(|e| {
            if e.msg == "unexpected end of JSON input" {
                Error::with_kind("unexpected EOF".to_owned(), ErrorKind::UnexpectedEof)
            } else {
                Error::from(e)
            }
        })?;
        decode_value(data, v, self.disallow_unknown)
    }

    /// [`Decoder::decode`] 와 같되, `Unmarshal` 처럼 입력 전체가 값 하나여야 한다.
    pub fn unmarshal<T: DeserializeOwned>(&self, data: &[u8]) -> Result<T, Error> {
        let v = parse_document(data)?;
        decode_value(data, v, self.disallow_unknown)
    }
}
