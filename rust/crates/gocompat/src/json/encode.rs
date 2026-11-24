//! Go `encoding/json` 의 Marshal 관측 규칙을 serde `Serializer` 로 구현한다.

use serde::ser::{self, Serialize};

use super::Error;
use super::scanner::{append_compact, append_indent};
use crate::strconv::format_float;

pub(crate) const RAW_TOKEN: &str = "$otter_gocompat::json::RawMessage";

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Go `appendString`. `src` 의 잘못된 UTF-8 은 `�` 가 된다.
pub fn append_string(dst: &mut Vec<u8>, src: &[u8], escape_html: bool) {
    dst.push(b'"');
    let mut start = 0;
    let mut i = 0;
    while i < src.len() {
        let b = src[i];
        if b < 0x80 {
            let safe = b >= 0x20
                && b != b'"'
                && b != b'\\'
                && (!escape_html || (b != b'<' && b != b'>' && b != b'&'));
            if safe {
                i += 1;
                continue;
            }
            dst.extend_from_slice(&src[start..i]);
            match b {
                b'\\' | b'"' => dst.extend_from_slice(&[b'\\', b]),
                0x08 => dst.extend_from_slice(b"\\b"),
                0x0c => dst.extend_from_slice(b"\\f"),
                b'\n' => dst.extend_from_slice(b"\\n"),
                b'\r' => dst.extend_from_slice(b"\\r"),
                b'\t' => dst.extend_from_slice(b"\\t"),
                _ => {
                    dst.extend_from_slice(b"\\u00");
                    dst.push(HEX[usize::from(b >> 4)]);
                    dst.push(HEX[usize::from(b & 0xf)]);
                }
            }
            i += 1;
            start = i;
            continue;
        }
        let end = (i + 4).min(src.len());
        let (c, size) = decode_rune(&src[i..end]);
        match c {
            None => {
                dst.extend_from_slice(&src[start..i]);
                dst.extend_from_slice("\u{fffd}".as_bytes());
                i += 1;
                start = i;
            }
            Some('\u{2028}' | '\u{2029}') => {
                dst.extend_from_slice(&src[start..i]);
                dst.extend_from_slice(b"\\u202");
                dst.push(HEX[usize::from(src[i + 2] & 0xf)]);
                i += size;
                start = i;
            }
            Some(_) => i += size,
        }
    }
    dst.extend_from_slice(&src[start..]);
    dst.push(b'"');
}

/// Go `utf8.DecodeRune` 의 성공 여부와 길이. 잘못된 바이트면 `(None, 1)`.
pub(crate) fn decode_rune(p: &[u8]) -> (Option<char>, usize) {
    for n in (1..=p.len().min(4)).rev() {
        if let Ok(s) = std::str::from_utf8(&p[..n])
            && let Some(c) = s.chars().next()
            && c.len_utf8() == n
        {
            return (Some(c), n);
        }
    }
    (None, 1)
}

/// Go `floatEncoder.encode`.
pub(crate) fn append_float(dst: &mut Vec<u8>, f: f64, bits: u32) -> Result<(), Error> {
    if f.is_nan() || f.is_infinite() {
        return Err(Error::new(format!(
            "json: unsupported value: {}",
            format_float(f, b'g', -1, bits)
        )));
    }
    let abs = f.abs();
    let mut fmt = b'f';
    if abs != 0.0 {
        let exp = if bits == 32 {
            let a = abs as f32;
            !(1e-6..1e21).contains(&a)
        } else {
            !(1e-6..1e21).contains(&abs)
        };
        if exp {
            fmt = b'e';
        }
    }
    let mut s = format_float(f, fmt, -1, bits).into_bytes();
    if fmt == b'e' {
        let n = s.len();
        if n >= 4 && s[n - 4] == b'e' && s[n - 3] == b'-' && s[n - 2] == b'0' {
            s[n - 2] = s[n - 1];
            s.truncate(n - 1);
        }
    }
    dst.extend_from_slice(&s);
    Ok(())
}

pub(crate) struct Serializer<'a> {
    pub(crate) out: &'a mut Vec<u8>,
    pub(crate) escape_html: bool,
    raw_next: bool,
}

impl<'a> Serializer<'a> {
    pub(crate) fn new(out: &'a mut Vec<u8>, escape_html: bool) -> Self {
        Self {
            out,
            escape_html,
            raw_next: false,
        }
    }

    fn sub(&mut self) -> Serializer<'_> {
        Serializer::new(self.out, self.escape_html)
    }

    fn int(&mut self, v: impl ToString) -> Result<(), Error> {
        self.out.extend_from_slice(v.to_string().as_bytes());
        Ok(())
    }
}

pub(crate) struct Compound<'s, 'a> {
    ser: &'s mut Serializer<'a>,
    first: bool,
    /// 변형(variant) 을 감싼 `{"V":` 를 닫아야 하면 참.
    close_variant: bool,
}

impl Compound<'_, '_> {
    fn comma(&mut self) {
        if !self.first {
            self.ser.out.push(b',');
        }
        self.first = false;
    }
}

pub(crate) struct MapCompound<'s, 'a> {
    ser: &'s mut Serializer<'a>,
    entries: Vec<(String, Vec<u8>)>,
    pending_key: Option<String>,
    close_variant: bool,
}

impl<'s, 'a> ser::Serializer for &'s mut Serializer<'a> {
    type Ok = ();
    type Error = Error;
    type SerializeSeq = Compound<'s, 'a>;
    type SerializeTuple = Compound<'s, 'a>;
    type SerializeTupleStruct = Compound<'s, 'a>;
    type SerializeTupleVariant = Compound<'s, 'a>;
    type SerializeMap = MapCompound<'s, 'a>;
    type SerializeStruct = Compound<'s, 'a>;
    type SerializeStructVariant = Compound<'s, 'a>;

    fn serialize_bool(self, v: bool) -> Result<(), Error> {
        self.out
            .extend_from_slice(if v { b"true" } else { b"false" });
        Ok(())
    }
    fn serialize_i8(self, v: i8) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_i16(self, v: i16) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_i32(self, v: i32) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_i64(self, v: i64) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_i128(self, v: i128) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_u8(self, v: u8) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_u16(self, v: u16) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_u32(self, v: u32) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_u64(self, v: u64) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_u128(self, v: u128) -> Result<(), Error> {
        self.int(v)
    }
    fn serialize_f32(self, v: f32) -> Result<(), Error> {
        append_float(self.out, f64::from(v), 32)
    }
    fn serialize_f64(self, v: f64) -> Result<(), Error> {
        append_float(self.out, v, 64)
    }
    fn serialize_char(self, v: char) -> Result<(), Error> {
        let mut buf = [0u8; 4];
        append_string(
            self.out,
            v.encode_utf8(&mut buf).as_bytes(),
            self.escape_html,
        );
        Ok(())
    }
    fn serialize_str(self, v: &str) -> Result<(), Error> {
        append_string(self.out, v.as_bytes(), self.escape_html);
        Ok(())
    }
    fn serialize_bytes(self, v: &[u8]) -> Result<(), Error> {
        if self.raw_next {
            self.raw_next = false;
            if v.is_empty() {
                self.out.extend_from_slice(b"null");
                return Ok(());
            }
            return append_compact(self.out, v, self.escape_html).map_err(|e| {
                Error::new(format!(
                    "json: error calling MarshalJSON for type *jsontext.Value: {e}"
                ))
            });
        }
        use base64::Engine as _;
        self.out.push(b'"');
        self.out.extend_from_slice(
            base64::engine::general_purpose::STANDARD
                .encode(v)
                .as_bytes(),
        );
        self.out.push(b'"');
        Ok(())
    }
    fn serialize_none(self) -> Result<(), Error> {
        self.out.extend_from_slice(b"null");
        Ok(())
    }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<(), Error> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<(), Error> {
        self.serialize_none()
    }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<(), Error> {
        self.serialize_none()
    }
    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
    ) -> Result<(), Error> {
        self.serialize_str(variant)
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        name: &'static str,
        value: &T,
    ) -> Result<(), Error> {
        if name == RAW_TOKEN {
            self.raw_next = true;
            let r = value.serialize(&mut *self);
            self.raw_next = false;
            return r;
        }
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<(), Error> {
        self.out.push(b'{');
        append_string(self.out, variant.as_bytes(), self.escape_html);
        self.out.push(b':');
        value.serialize(&mut *self)?;
        self.out.push(b'}');
        Ok(())
    }
    fn serialize_seq(self, _len: Option<usize>) -> Result<Self::SerializeSeq, Error> {
        self.out.push(b'[');
        Ok(Compound {
            ser: self,
            first: true,
            close_variant: false,
        })
    }
    fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_struct(
        self,
        _name: &'static str,
        len: usize,
    ) -> Result<Self::SerializeTupleStruct, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleVariant, Error> {
        self.out.push(b'{');
        append_string(self.out, variant.as_bytes(), self.escape_html);
        self.out.extend_from_slice(b":[");
        Ok(Compound {
            ser: self,
            first: true,
            close_variant: true,
        })
    }
    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap, Error> {
        Ok(MapCompound {
            ser: self,
            entries: Vec::new(),
            pending_key: None,
            close_variant: false,
        })
    }
    fn serialize_struct(
        self,
        _name: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStruct, Error> {
        self.out.push(b'{');
        Ok(Compound {
            ser: self,
            first: true,
            close_variant: false,
        })
    }
    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStructVariant, Error> {
        self.out.push(b'{');
        append_string(self.out, variant.as_bytes(), self.escape_html);
        self.out.extend_from_slice(b":{");
        Ok(Compound {
            ser: self,
            first: true,
            close_variant: true,
        })
    }
}

impl Compound<'_, '_> {
    fn element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.comma();
        value.serialize(&mut self.ser.sub())
    }

    fn field<T: ?Sized + Serialize>(&mut self, key: &str, value: &T) -> Result<(), Error> {
        self.comma();
        append_string(self.ser.out, key.as_bytes(), self.ser.escape_html);
        self.ser.out.push(b':');
        value.serialize(&mut self.ser.sub())
    }

    fn close(self, c: u8) {
        self.ser.out.push(c);
        if self.close_variant {
            self.ser.out.push(b'}');
        }
    }
}

impl ser::SerializeSeq for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.element(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close(b']');
        Ok(())
    }
}

impl ser::SerializeTuple for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.element(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close(b']');
        Ok(())
    }
}

impl ser::SerializeTupleStruct for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.element(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close(b']');
        Ok(())
    }
}

impl ser::SerializeTupleVariant for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        self.element(value)
    }
    fn end(self) -> Result<(), Error> {
        self.close(b']');
        Ok(())
    }
}

impl ser::SerializeStruct for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Error> {
        self.field(key, value)
    }
    fn end(self) -> Result<(), Error> {
        self.close(b'}');
        Ok(())
    }
}

impl ser::SerializeStructVariant for Compound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Error> {
        self.field(key, value)
    }
    fn end(self) -> Result<(), Error> {
        self.close(b'}');
        Ok(())
    }
}

impl ser::SerializeMap for MapCompound<'_, '_> {
    type Ok = ();
    type Error = Error;
    fn serialize_key<T: ?Sized + Serialize>(&mut self, key: &T) -> Result<(), Error> {
        self.pending_key = Some(key.serialize(KeySerializer)?);
        Ok(())
    }
    fn serialize_value<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        let key = self
            .pending_key
            .take()
            .ok_or_else(|| Error::new("json: map value without key".to_owned()))?;
        let mut buf = Vec::new();
        value.serialize(&mut Serializer::new(&mut buf, self.ser.escape_html))?;
        self.entries.push((key, buf));
        Ok(())
    }
    fn end(mut self) -> Result<(), Error> {
        // Go: 키 문자열의 바이트 순서로 정렬한다. 같은 키가 여럿이면 순서를 지킨다.
        self.entries.sort_by(|a, b| a.0.cmp(&b.0));
        let out = &mut *self.ser.out;
        out.push(b'{');
        for (i, (k, v)) in self.entries.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            append_string(out, k.as_bytes(), self.ser.escape_html);
            out.push(b':');
            out.extend_from_slice(v);
        }
        out.push(b'}');
        if self.close_variant {
            out.push(b'}');
        }
        Ok(())
    }
}

/// map 키를 Go 처럼 문자열로 만든다: 문자열은 그대로, 정수는 십진수.
struct KeySerializer;

fn unsupported_key() -> Error {
    Error::new("json: unsupported type: map key must be a string or an integer".to_owned())
}

macro_rules! key_int {
    ($($f:ident: $t:ty),*) => {
        $(fn $f(self, v: $t) -> Result<String, Error> {
            Ok(v.to_string())
        })*
    };
}

macro_rules! key_unsupported {
    ($($f:ident: $t:ty),*) => {
        $(fn $f(self, _v: $t) -> Result<String, Error> {
            Err(unsupported_key())
        })*
    };
}

impl ser::Serializer for KeySerializer {
    type Ok = String;
    type Error = Error;
    type SerializeSeq = ser::Impossible<String, Error>;
    type SerializeTuple = ser::Impossible<String, Error>;
    type SerializeTupleStruct = ser::Impossible<String, Error>;
    type SerializeTupleVariant = ser::Impossible<String, Error>;
    type SerializeMap = ser::Impossible<String, Error>;
    type SerializeStruct = ser::Impossible<String, Error>;
    type SerializeStructVariant = ser::Impossible<String, Error>;

    key_int!(serialize_i8: i8, serialize_i16: i16, serialize_i32: i32, serialize_i64: i64,
        serialize_i128: i128, serialize_u8: u8, serialize_u16: u16, serialize_u32: u32,
        serialize_u64: u64, serialize_u128: u128);
    key_unsupported!(serialize_bool: bool, serialize_f32: f32, serialize_f64: f64,
        serialize_bytes: &[u8]);

    fn serialize_char(self, v: char) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_str(self, v: &str) -> Result<String, Error> {
        Ok(v.to_owned())
    }
    fn serialize_none(self) -> Result<String, Error> {
        Err(unsupported_key())
    }
    fn serialize_some<T: ?Sized + Serialize>(self, _value: &T) -> Result<String, Error> {
        Err(unsupported_key())
    }
    fn serialize_unit(self) -> Result<String, Error> {
        Err(unsupported_key())
    }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<String, Error> {
        Err(unsupported_key())
    }
    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
    ) -> Result<String, Error> {
        Ok(variant.to_owned())
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        _name: &'static str,
        value: &T,
    ) -> Result<String, Error> {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        _name: &'static str,
        _index: u32,
        _variant: &'static str,
        _value: &T,
    ) -> Result<String, Error> {
        Err(unsupported_key())
    }
    fn serialize_seq(self, _len: Option<usize>) -> Result<Self::SerializeSeq, Error> {
        Err(unsupported_key())
    }
    fn serialize_tuple(self, _len: usize) -> Result<Self::SerializeTuple, Error> {
        Err(unsupported_key())
    }
    fn serialize_tuple_struct(
        self,
        _name: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleStruct, Error> {
        Err(unsupported_key())
    }
    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        _variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeTupleVariant, Error> {
        Err(unsupported_key())
    }
    fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap, Error> {
        Err(unsupported_key())
    }
    fn serialize_struct(
        self,
        _name: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStruct, Error> {
        Err(unsupported_key())
    }
    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        _variant: &'static str,
        _len: usize,
    ) -> Result<Self::SerializeStructVariant, Error> {
        Err(unsupported_key())
    }
}

/// Go `json.Marshal`.
pub fn marshal<T: ?Sized + Serialize>(v: &T) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    v.serialize(&mut Serializer::new(&mut out, true))?;
    Ok(out)
}

/// Go `json.MarshalIndent`.
pub fn marshal_indent<T: ?Sized + Serialize>(
    v: &T,
    prefix: &str,
    indent: &str,
) -> Result<Vec<u8>, Error> {
    let b = marshal(v)?;
    let mut out = Vec::with_capacity(b.len() * 2);
    append_indent(&mut out, &b, prefix, indent).map_err(Error::from)?;
    Ok(out)
}

/// Go `json.Encoder` 의 설정. 기본값은 `json.NewEncoder(w)` 와 같다(HTML 이스케이프, 들여쓰기 없음).
#[derive(Debug, Clone)]
pub struct Encoder {
    escape_html: bool,
    prefix: String,
    indent: String,
}

impl Default for Encoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Encoder {
    pub fn new() -> Self {
        Self {
            escape_html: true,
            prefix: String::new(),
            indent: String::new(),
        }
    }

    /// Go `Encoder.SetEscapeHTML`.
    pub fn set_escape_html(&mut self, on: bool) -> &mut Self {
        self.escape_html = on;
        self
    }

    /// Go `Encoder.SetIndent`.
    pub fn set_indent(&mut self, prefix: &str, indent: &str) -> &mut Self {
        self.prefix = prefix.to_owned();
        self.indent = indent.to_owned();
        self
    }

    /// Go `Encoder.Encode` 가 쓰는 바이트. 끝에 `\n` 이 붙는다.
    pub fn encode<T: ?Sized + Serialize>(&self, v: &T) -> Result<Vec<u8>, Error> {
        let mut b = Vec::new();
        v.serialize(&mut Serializer::new(&mut b, self.escape_html))?;
        b.push(b'\n');
        if self.prefix.is_empty() && self.indent.is_empty() {
            return Ok(b);
        }
        let mut out = Vec::with_capacity(b.len() * 2);
        append_indent(&mut out, &b, &self.prefix, &self.indent).map_err(Error::from)?;
        Ok(out)
    }

    /// [`Encoder::encode`] 의 결과를 `w` 에 쓴다.
    pub fn encode_to<W: std::io::Write, T: ?Sized + Serialize>(
        &self,
        w: &mut W,
        v: &T,
    ) -> Result<(), Error> {
        let b = self.encode(v)?;
        w.write_all(&b).map_err(|e| Error::new(e.to_string()))
    }
}
