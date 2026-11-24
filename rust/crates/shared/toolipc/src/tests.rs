use std::collections::BTreeMap;

use otter_gocompat::json::{self, RawMessage};
use otter_shared_chatwire as chatwire;
use otter_shared_toolhub::{AgentState, BackgroundEntry, TermModes, ToolInfo};
use serde::Serialize;

use super::*;

const DATA: &[u8] = b"hi\x1b[0m";
const B64: &str = "aGkbWzBt";

fn enc<T: Serialize>(v: &T) -> String {
    String::from_utf8(json::marshal(v).unwrap()).unwrap()
}

fn raw(s: &str) -> RawMessage {
    RawMessage(s.as_bytes().to_vec())
}

#[test]
fn wire_golden() {
    let modes = TermModes {
        bracketed_paste: true,
        mouse_protocol: 1002,
        ..Default::default()
    };
    let cases: Vec<(&str, String, String)> = vec![
        ("hello-params", enc(&HelloParams::default()), "{}".into()),
        (
            "hello-result",
            enc(&HelloResult {
                build: "1.2.3".into(),
                version: PROTOCOL_VERSION,
                ..Default::default()
            }),
            r#"{"build":"1.2.3","version":1}"#.into(),
        ),
        (
            "create-params",
            enc(&CreateParams {
                cwd: "/tmp".into(),
                cols: 80,
                rows: 24,
                window: "w".into(),
                profile: "p".into(),
                command: "c".into(),
                work: "k".into(),
                extra_env: Some(vec!["A=1".into()]),
            }),
            r#"{"cols":80,"command":"c","cwd":"/tmp","extraEnv":["A=1"],"profile":"p","rows":24,"window":"w","work":"k"}"#.into(),
        ),
        (
            "create-params-nil-env",
            enc(&CreateParams::default()),
            r#"{"cols":0,"command":"","cwd":"","extraEnv":null,"profile":"","rows":0,"window":"","work":""}"#.into(),
        ),
        (
            "create-result",
            enc(&CreateResult { id: "a".into(), name: "S1".into(), pid: 42, cols: 80, rows: 24 }),
            r#"{"cols":80,"id":"a","name":"S1","pid":42,"rows":24}"#.into(),
        ),
        (
            "restore-params",
            enc(&RestoreParams { id: "a".into(), name: "R".into(), cwd: "/h".into(), cols: 100, rows: 30 }),
            r#"{"cols":100,"cwd":"/h","id":"a","name":"R","rows":30}"#.into(),
        ),
        (
            "restore-result",
            enc(&RestoreResult { id: "a".into(), cols: 100, rows: 30 }),
            r#"{"cols":100,"id":"a","rows":30}"#.into(),
        ),
        ("id-params", enc(&IdParams { id: "a".into() }), r#"{"id":"a"}"#.into()),
        (
            "terminate-params",
            enc(&TerminateParams { id: "a".into(), grace_ms: 1500 }),
            r#"{"graceMs":1500,"id":"a"}"#.into(),
        ),
        (
            "write-params",
            enc(&WriteParams { id: "a".into(), data: DATA.to_vec() }),
            format!(r#"{{"data":"{B64}","id":"a"}}"#),
        ),
        (
            "write-params-empty",
            enc(&WriteParams { id: "a".into(), data: vec![] }),
            r#"{"data":"","id":"a"}"#.into(),
        ),
        (
            "paste-params",
            enc(&PasteParams { id: "a".into(), data: DATA.to_vec(), submit: true }),
            format!(r#"{{"data":"{B64}","id":"a","submit":true}}"#),
        ),
        (
            "resize-params",
            enc(&ResizeParams { id: "a".into(), cols: 90, rows: 20 }),
            r#"{"cols":90,"id":"a","rows":20}"#.into(),
        ),
        (
            "snapshot-params",
            enc(&SnapshotParams { id: "a".into(), since: -1 }),
            r#"{"id":"a","since":-1}"#.into(),
        ),
        (
            "snapshot-result",
            enc(&SnapshotResult {
                data: DATA.to_vec(),
                total_bytes_in: 9,
                total_bytes_drop: 1,
                retained: 7,
                end: 9,
                resumed: true,
                cols: 80,
                rows: 24,
                modes,
            }),
            format!(r#"{{"cols":80,"data":"{B64}","end":9,"modes":{{"bracketedPaste":true,"mouseProtocol":1002,"mouseEncoding":0,"focusEvent":false,"altScreen":false}},"resumed":true,"retained":7,"rows":24,"totalBytesDrop":1,"totalBytesIn":9}}"#),
        ),
        (
            "snapshot-result-empty",
            enc(&SnapshotResult::default()),
            r#"{"cols":0,"data":"","end":0,"modes":{"bracketedPaste":false,"mouseProtocol":0,"mouseEncoding":0,"focusEvent":false,"altScreen":false},"resumed":false,"retained":0,"rows":0,"totalBytesDrop":0,"totalBytesIn":0}"#.into(),
        ),
        ("cwd-result", enc(&CwdResult { cwd: "/x".into() }), r#"{"cwd":"/x"}"#.into()),
        ("busy-result", enc(&BusyResult { busy: true }), r#"{"busy":true}"#.into()),
        (
            "setbg-params",
            enc(&SetBackgroundParams { id: "a".into(), background: true }),
            r#"{"background":true,"id":"a"}"#.into(),
        ),
        ("setbg-result", enc(&SetBackgroundResult { ok: true }), r#"{"ok":true}"#.into()),
        (
            "list-result",
            enc(&ListResult {
                tools: Some(vec![ToolInfo { id: "a".into(), name: "S1".into(), ..Default::default() }]),
            }),
            r#"{"tools":[{"id":"a","name":"S1","pid":0,"sizeCols":0,"sizeRows":0,"fgName":""}]}"#.into(),
        ),
        ("list-result-nil", enc(&ListResult::default()), r#"{"tools":null}"#.into()),
        (
            "bglist-result",
            enc(&BackgroundListResult {
                background: Some(vec![BackgroundEntry {
                    tool_id: "a".into(),
                    name: "S1".into(),
                    cwd: "/".into(),
                    since: 3,
                }]),
            }),
            r#"{"background":[{"toolId":"a","name":"S1","cwd":"/","since":3}]}"#.into(),
        ),
        (
            "output-event",
            enc(&OutputEvent { event: EVENT_OUTPUT.into(), tool: "a".into(), data: DATA.to_vec(), end: 9 }),
            format!(r#"{{"data":"{B64}","end":9,"event":"output","tool":"a"}}"#),
        ),
        (
            "exit-event",
            enc(&ExitEvent { event: EVENT_EXIT.into(), tool: "a".into(), code: -1 }),
            r#"{"code":-1,"event":"exit","tool":"a"}"#.into(),
        ),
        (
            "fg-event",
            enc(&ForegroundEvent { event: EVENT_FOREGROUND.into(), tool: "a".into(), name: "vim".into() }),
            r#"{"event":"fg","name":"vim","tool":"a"}"#.into(),
        ),
        (
            "size-event",
            enc(&SizeEvent { event: EVENT_SIZE.into(), tool: "a".into(), cols: 80, rows: 24 }),
            r#"{"cols":80,"event":"size","rows":24,"tool":"a"}"#.into(),
        ),
    ];
    for (name, got, want) in cases {
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn chat_wire_golden() {
    let cases = [
        (
            enc(&ChatParams {
                args: raw(r#"{"room":"r1"}"#),
                op: "join".into(),
            }),
            r#"{"args":{"room":"r1"},"op":"join"}"#,
        ),
        (
            enc(&ChatParams {
                op: "state".into(),
                ..Default::default()
            }),
            r#"{"op":"state"}"#,
        ),
        (
            enc(&ChatResult {
                result: raw(r#"{"ok":true}"#),
                ..Default::default()
            }),
            r#"{"result":{"ok":true}}"#,
        ),
        (
            enc(&ChatResult {
                error: Some(chatwire::Error {
                    code: "not_in_room".into(),
                    message: "m".into(),
                }),
                ..Default::default()
            }),
            r#"{"error":{"code":"not_in_room","message":"m"}}"#,
        ),
        (
            enc(&ChatEvent {
                chat: Some(chatwire::Message {
                    id: "m1".into(),
                    ..Default::default()
                }),
                chat_kind: CHAT_KIND_MSG.into(),
                event: EVENT_CHAT.into(),
            }),
            r#"{"chat":{"id":"m1","room":"","roomKind":"","roomName":"","roomPurpose":"","from":"","fromLabel":"","fromKind":"","node":"","text":"","at":0},"chatKind":"msg","event":"chat"}"#,
        ),
        (
            enc(&ChatEvent {
                chat_kind: CHAT_KIND_CHANGED.into(),
                event: EVENT_CHAT.into(),
                ..Default::default()
            }),
            r#"{"chatKind":"changed","event":"chat"}"#,
        ),
    ];
    for (got, want) in cases {
        assert_eq!(got, want);
    }
    assert!(
        has_feature(DAEMON_FEATURES, FEATURE_CHAT) && has_feature(SERVER_FEATURES, FEATURE_CHAT)
    );
}

#[test]
fn edge_wire_golden() {
    let fb = || {
        Some(EdgeRef {
            fp: "f".into(),
            name: "b".into(),
        })
    };
    let cases = [
        (
            enc(&EdgeParams {
                args: raw(r#"{"id":"p1"}"#),
                if_match: "e1".into(),
                op: "approve".into(),
            }),
            r#"{"args":{"id":"p1"},"ifMatch":"e1","op":"approve"}"#,
        ),
        (
            enc(&EdgeParams {
                op: "get".into(),
                ..Default::default()
            }),
            r#"{"op":"get"}"#,
        ),
        (
            enc(&EdgeResult {
                body: raw(r#"{"a":1}"#),
                etag: "t".into(),
                status: 200,
                ..Default::default()
            }),
            r#"{"body":{"a":1},"etag":"t","status":200}"#,
        ),
        (
            enc(&EdgeResult {
                code: "edge_unreachable".into(),
                message: "m".into(),
                status: 502,
                ..Default::default()
            }),
            r#"{"code":"edge_unreachable","message":"m","status":502}"#,
        ),
        (
            enc(&EdgePortParams {
                addr: "0.0.0.0:58147".into(),
                listening: true,
                ..Default::default()
            }),
            r#"{"addr":"0.0.0.0:58147","listening":true}"#,
        ),
        (
            enc(&EdgesEvent {
                event: EVENT_EDGES.into(),
                paired: fb(),
                ..Default::default()
            }),
            r#"{"event":"edges","paired":{"fp":"f","name":"b"}}"#,
        ),
        (
            enc(&EdgesEvent {
                event: EVENT_EDGES.into(),
                removed: fb(),
                ..Default::default()
            }),
            r#"{"event":"edges","removed":{"fp":"f","name":"b"}}"#,
        ),
        (
            enc(&EdgesEvent {
                event: EVENT_EDGES.into(),
                removed: fb(),
                by_peer: true,
                ..Default::default()
            }),
            r#"{"event":"edges","removed":{"fp":"f","name":"b"},"byPeer":true}"#,
        ),
    ];
    for (got, want) in cases {
        assert_eq!(got, want);
    }
    assert!(
        has_feature(DAEMON_FEATURES, FEATURE_EDGE) && has_feature(SERVER_FEATURES, FEATURE_EDGE)
    );
}

#[test]
fn has_feature_cases() {
    assert!(!has_feature::<String>(&[], "x"));
    assert!(has_feature(&["a".to_string(), "x".to_string()], "x"));
}

#[test]
fn records_and_attn_wire() {
    let mut recs = BTreeMap::new();
    recs.insert("usage".to_string(), raw(r#"{"n":1}"#));
    let got = enc(&RecordsResult {
        tools: Some(vec![ToolRecords {
            agent: AgentState::default(),
            records: recs,
            tool: "a".into(),
        }]),
        ..Default::default()
    });
    assert_eq!(
        got,
        r#"{"tools":[{"agent":{"agentSeen":false,"armed":false,"attention":false,"lastOutputAt":0,"rearmLocked":false,"turn":{"inProgress":false,"waitingSignaled":false,"turnRan":false}},"records":{"usage":{"n":1}},"tool":"a"}]}"#
    );
    assert_eq!(
        enc(&RecordSetParams {
            kind: "agent".into(),
            ..Default::default()
        }),
        r#"{"kind":"agent","value":null}"#
    );
    assert_eq!(
        enc(&AttendParams {
            tool: "a".into(),
            typed: false
        }),
        r#"{"tool":"a"}"#
    );
    assert_eq!(record_is_global(RECORD_LIMITS), Some(true));
    assert_eq!(record_is_global(RECORD_AGENT), Some(false));
    assert_eq!(record_is_global("x"), None);
}

#[test]
fn rpc_frames() {
    let req: PanedRequest =
        json::unmarshal(br#"{"id":3,"method":"list","params":{"a":1}}"#).unwrap();
    assert_eq!(
        (req.id, req.method.as_str(), req.params.0.as_slice()),
        (3, "list", &br#"{"a":1}"#[..])
    );
    assert_eq!(
        enc(&PanedResponse {
            id: 3,
            result: BusyResult { busy: true }
        }),
        r#"{"id":3,"result":{"busy":true}}"#
    );
    assert_eq!(
        enc(&PanedError {
            id: 3,
            error: PanedErrObj {
                code: CODE_NOT_FOUND,
                message: "m".into()
            }
        }),
        r#"{"id":3,"error":{"code":-32011,"message":"m"}}"#
    );
    assert_eq!(
        RpcError {
            code: 1,
            message: "x".into()
        }
        .to_string(),
        "paned error: x"
    );
}
