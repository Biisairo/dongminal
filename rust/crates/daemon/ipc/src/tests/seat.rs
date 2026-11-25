//! 답장 좌석(D-23): 서버가 쥔 동안 데몬 화면 상태는 질의에 답하지 않고, 연결이 끊기면 쥔 것을 놓는다.

use std::time::{Duration, Instant};

use super::fake::{fake_tools, get};
use super::{daemon, raw};

const STATUS: &[u8] = b"\x1b[5n";
const ANSWER: &[u8] = b"\x1b[0n";

fn wait(what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn held_seat_silences_daemon_and_dropped_conn_releases() {
    let d = daemon("b");
    let reg = fake_tools(&d.srv.inner.pm, None, &["a"]);
    let f = get(&reg, "a");
    let t = d.srv.inner.pm.get("a").unwrap();
    let off = || t.stream().unwrap().offset();

    f.feed(STATUS);
    wait("좌석이 비면 답한다", || f.written() == ANSWER);

    let mut c = raw(&d.sock);
    c.hello(&[]);
    assert_eq!(
        c.call(r#"{"id":1,"method":"seat","params":{"held":true,"id":"a"}}"#),
        r#"{"id":1,"result":{"repliedEnd":4}}"#
    );
    f.feed(STATUS);
    wait("출력이 들어간다", || off() == 8);
    assert_eq!(f.written(), ANSWER, "쥔 동안 답했다");

    drop(c);
    wait("끊긴 연결의 좌석을 놓는다", || {
        f.feed(STATUS);
        std::thread::sleep(Duration::from_millis(20));
        f.written().len() > ANSWER.len()
    });
}

#[tokio::test(flavor = "multi_thread")]
async fn seat_on_unknown_tool_is_not_found() {
    let d = daemon("b");
    let mut c = raw(&d.sock);
    c.hello(&[]);
    let r = c.call(r#"{"id":1,"method":"seat","params":{"held":true,"id":"zz"}}"#);
    assert!(r.contains(r#""code":-32011"#), "{r}");
}

/// 줄 저장소 검색(D-21): 앵커 앞의 줄을 새 줄부터 찾는다. 깨진 정규식은 인자 오류다.
#[tokio::test(flavor = "multi_thread")]
async fn search_finds_store_lines_and_rejects_bad_regex() {
    let d = daemon("b");
    let reg = fake_tools(&d.srv.inner.pm, None, &["a"]);
    let f = get(&reg, "a");
    let t = d.srv.inner.pm.get("a").unwrap();
    let out: String = (0..3_000).map(|i| format!("row-{i} tail\r\n")).collect();
    // 가짜 읽기는 버퍼보다 긴 조각의 뒤를 버린다 — 작게 나눠 넣는다.
    for c in out.as_bytes().chunks(1024) {
        f.feed(c);
    }
    let total = i64::try_from(out.len()).unwrap();
    wait("출력이 들어간다", || {
        t.stream().unwrap().offset() == total
    });
    let mut c = raw(&d.sock);
    c.hello(&[]);
    let r = c.call(
        r#"{"id":1,"method":"search","params":{"before":99999,"case":true,"id":"a","limit":5,"pattern":"row-1 ","regex":false,"word":false}}"#,
    );
    let first = t.with_screen(|s, _| s.store().first()).unwrap();
    assert_eq!(
        r,
        format!(
            r#"{{"id":1,"result":{{"hits":[{{"col":0,"line":{},"text":"row-1 tail"}}]}}}}"#,
            first + 1
        )
    );
    let r = c.call(
        r#"{"id":2,"method":"search","params":{"before":99999,"id":"a","limit":5,"pattern":"(","regex":true}}"#,
    );
    assert!(r.contains(r#""code":-32602"#), "{r}");
    let r = c.call(r#"{"id":3,"method":"search","params":{"id":"zz","pattern":"x"}}"#);
    assert!(r.contains(r#""code":-32011"#), "{r}");
}
