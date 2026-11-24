//! 메서드 응답 — 일괄 busy·hello 판·인자 해석·생성 오류, 실제 셸 (busymany_test.go ·
//! hello_version_test.go · paned_decode_test.go · shellprobe_test.go · paned_test.go).

use std::time::{Duration, Instant};

use dm_gocompat::json::RawMessage;
use dm_shared_toolhub::{Placement, TOOL_CAP};
use dm_shared_toolipc::PanedRequest;
use serde::Deserialize;
use serde_json::Value;

use super::fake::fake_start;
use super::{Raw, daemon, raw};
use crate::handlers::decode;

/// 없는 도구는 busy 와 같이 false 다. 키는 사전순이다.
#[tokio::test(flavor = "multi_thread")]
async fn busy_many_wire() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    for (p, want) in [
        (
            r#"{"ids":["y","x"]}"#,
            r#"{"id":1,"result":{"busy":{"x":false,"y":false}}}"#,
        ),
        (r#"{"ids":[]}"#, r#"{"id":1,"result":{"busy":{}}}"#),
        ("{}", r#"{"id":1,"result":{"busy":{}}}"#),
    ] {
        assert_eq!(
            c.call(&format!(r#"{{"id":1,"method":"busymany","params":{p}}}"#)),
            want,
            "{p}"
        );
    }
}

/// hello 는 프로토콜 판과 빌드 판을 따로 싣는다 (FR-VHL-1).
#[tokio::test(flavor = "multi_thread")]
async fn hello_carries_protocol_and_build() {
    let d = daemon("1.2.3");
    let mut c = raw(&d.sock);
    let r: Value = serde_json::from_str(&c.call(r#"{"id":1,"method":"hello"}"#)).unwrap();
    assert_eq!(r["result"]["version"], dm_shared_toolipc::PROTOCOL_VERSION);
    assert_eq!(r["result"]["build"], "1.2.3");
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct P {
    id: String,
}

/// 인자 해석은 한 벌이다 — 잘못된 JSON 은 CODE_INVALID_PARAMS 이고 요청 id 를 싣는다.
#[test]
fn decode_invalid_is_invalid_params() {
    let req = PanedRequest {
        id: 7,
        params: RawMessage(br#"{"id":"#.to_vec()),
        ..PanedRequest::default()
    };
    let line = String::from_utf8(decode::<P>(&req).err().unwrap()).unwrap();
    assert!(
        line.starts_with(r#"{"id":7,"error":{"code":-32602,"message":"#),
        "{line}"
    );
    let req = PanedRequest {
        id: 8,
        params: RawMessage(br#"{"id":"a"}"#.to_vec()),
        ..PanedRequest::default()
    };
    assert_eq!(decode::<P>(&req).ok().unwrap().id, "a");
}

/// 상한 초과는 CODE_TOOL_CAP 으로 건넌다 — 문자열이 아니라.
#[tokio::test(flavor = "multi_thread")]
async fn create_tool_cap_has_its_own_code() {
    let d = daemon("b");
    let pm = &d.srv.inner.pm;
    let _reg = fake_start(pm, None);
    for _ in 0..TOOL_CAP {
        pm.create("/tmp", 80, 24, Placement::default()).unwrap();
    }
    let mut c = raw(&d.sock);
    assert_eq!(
        c.call(r#"{"id":1,"method":"create","params":{"cwd":"/tmp","cols":80,"rows":24}}"#),
        r#"{"id":1,"error":{"code":-32010,"message":"도구 수가 상한에 이르렀다"}}"#
    );
}

/// 실제 셸 위의 도구를 만들고 id 를 돌려준다. 응답 사이의 출력 push 는 건너뛴다.
fn create_shell(c: &mut Raw) -> (String, i64) {
    c.send(r#"{"id":1,"method":"create","params":{"cwd":"/tmp","cols":80,"rows":24}}"#);
    let r: Value = serde_json::from_str(&c.recv_id(1)).unwrap();
    let id = r["result"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("생성 실패: {r}"))
        .to_owned();
    (id, r["result"]["pid"].as_i64().unwrap())
}

fn kill_shell(c: &mut Raw, id: &str) {
    c.send(&format!(
        r#"{{"id":90,"method":"write","params":{{"id":"{id}","data":"Aw=="}}}}"#
    ));
    c.recv_id(90);
    c.send(&format!(
        r#"{{"id":91,"method":"kill","params":{{"id":"{id}"}}}}"#
    ));
    assert_eq!(c.recv_id(91), r#"{"id":91,"result":{}}"#);
}

#[tokio::test(flavor = "multi_thread")]
async fn create_write_snapshot_flow() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    let (id, _) = create_shell(&mut c);
    c.send(&format!(
        r#"{{"id":2,"method":"write","params":{{"id":"{id}","data":"ZWNobyB0ZXN0Cg=="}}}}"#
    ));
    assert_eq!(c.recv_id(2), r#"{"id":2,"result":{}}"#);
    c.send(&format!(
        r#"{{"id":3,"method":"snapshot","params":{{"id":"{id}"}}}}"#
    ));
    let r: Value = serde_json::from_str(&c.recv_id(3)).unwrap();
    assert!(
        r["result"]["data"].is_string(),
        "snapshot 에 data 가 없다: {r}"
    );
    kill_shell(&mut c, &id);
}

/// 빈 셸은 idle, 자식이 돌면 busy, 그 자식을 세션 pid 로 주면 here, 셸 밖의 살아 있는 pid 는
/// elsewhere 다. 표에 없는 pid 는 셸만 본다 (TC-RRC-3).
#[tokio::test(flavor = "multi_thread")]
async fn shell_probe_real_shell() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    let (id, shell) = create_shell(&mut c);
    let mut n = 10;
    let mut wait_state = |c: &mut Raw, want: &str, pids: &str| {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut got = String::new();
        while Instant::now() < deadline {
            n += 1;
            c.send(&format!(
                r#"{{"id":{n},"method":"shellprobe","params":{{"id":"{id}","pids":{pids}}}}}"#
            ));
            got = c.recv_id(n);
            if got == format!(r#"{{"id":{n},"result":{{"state":"{want}"}}}}"#) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("셸 판정 = {got}, want {want}");
    };
    wait_state(&mut c, "idle", "[]");
    c.send(&format!(
        r#"{{"id":2,"method":"write","params":{{"id":"{id}","data":"c2xlZXAgMzAN"}}}}"#
    ));
    c.recv_id(2);
    wait_state(&mut c, "busy", "[]");
    let parents = dm_shared_platform::current()
        .info
        .parents()
        .expect("프로세스 표를 읽지 못했다");
    let shell = i32::try_from(shell).unwrap();
    let child = parents
        .iter()
        .find(|&(_, &pp)| pp == shell)
        .map(|(&p, _)| p)
        .expect("셸의 자식을 찾지 못했다");
    wait_state(&mut c, "here", &format!("[{child}]"));
    wait_state(&mut c, "elsewhere", &format!("[{}]", std::process::id()));
    wait_state(&mut c, "busy", &format!("[{}]", 1 << 30));
    kill_shell(&mut c, &id);
}
