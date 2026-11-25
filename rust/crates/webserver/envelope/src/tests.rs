use super::*;
use std::collections::BTreeMap;

// 봉투는 종전 map 조립과 바이트가 같다 (FR-OPT-0-3).
#[test]
fn payload_byte_compatible_with_map() {
    assert_eq!(
        payload::<()>("update_changed", None),
        br#"{"action":"update_changed"}"#
    );
    let empty: BTreeMap<&str, &str> = BTreeMap::new();
    assert_eq!(
        payload("access_changed", Some(&empty)),
        br#"{"action":"access_changed","args":{}}"#
    );
    let mut m = BTreeMap::new();
    m.insert("toolId", "t");
    m.insert("reason", "r");
    assert_eq!(
        payload("tool_attention", Some(&m)),
        br#"{"action":"tool_attention","args":{"reason":"r","toolId":"t"}}"#
    );
    assert_eq!(
        workspace_changed(7),
        br#"{"action":"workspace_changed","args":{"rev":7}}"#
    );
}

#[test]
fn payload_escapes_html() {
    let mut m = BTreeMap::new();
    m.insert("x", "<&>");
    assert_eq!(
        payload("a", Some(&m)),
        b"{\"action\":\"a\",\"args\":{\"x\":\"\\u003c\\u0026\\u003e\"}}"
    );
}

struct Unencodable;

impl serde::Serialize for Unencodable {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom(
            "json: unsupported type: chan int",
        ))
    }
}

#[test]
fn payload_marshal_error_keeps_action() {
    assert_eq!(payload("x", Some(&Unencodable)), br#"{"action":"x"}"#);
}
