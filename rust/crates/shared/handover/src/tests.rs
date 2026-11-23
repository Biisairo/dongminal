use std::sync::mpsc;
use std::thread;

use super::*;

/// 소켓 경로 한도 안의 짧은 임시 홈.
fn short_home() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("dsk").tempdir().unwrap()
}

/// home 의 보고 소켓에서 연결 하나를 받는다. reply 가 있으면 요청 한 줄을 읽어 돌려주고 답한다.
/// 없으면 답 없이 끊는다.
fn fake_daemon(home: &Path, reply: Option<Reply>) -> mpsc::Receiver<Vec<u8>> {
    let ln = dm_shared_platform::current()
        .ipc
        .listen(&socket_path(home))
        .unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let Ok(mut c) = ln.accept() else { return };
        let Some(reply) = reply else { return };
        let mut line = Vec::new();
        let mut b = [0u8; 1];
        while c.read(&mut b).is_ok_and(|n| n == 1) {
            line.push(b[0]);
            if b[0] == b'\n' {
                break;
            }
        }
        let _ = tx.send(line);
        let _ = c.write_all(&Encoder::new().encode(&reply).unwrap());
    });
    rx
}

fn reply(ok: bool, error: &str) -> Reply {
    Reply {
        ok,
        error: error.to_owned(),
    }
}

#[test]
fn reload_sends_request_and_reads_swapped() {
    let home = short_home();
    let got = fake_daemon(home.path(), Some(reply(true, "")));
    let out = reload(home.path(), "/opt/dm/dongminal", Duration::from_secs(1));
    assert_eq!(out.kind, Kind::Swapped, "{out:?}");
    let line = got.recv().unwrap();
    assert_eq!(
        String::from_utf8(line).unwrap(),
        "{\"method\":\"daemon.reload\",\"body\":{\"exe\":\"/opt/dm/dongminal\",\"handover\":1}}\n"
    );
}

#[test]
fn reload_old_daemon_is_unsupported() {
    let home = short_home();
    let _rx = fake_daemon(
        home.path(),
        Some(reply(
            false,
            &format!("{OLD_DAEMON_UNKNOWN_METHOD}: {METHOD_RELOAD}"),
        )),
    );
    assert_eq!(
        reload(home.path(), "/x", Duration::from_secs(1)).kind,
        Kind::Unsupported
    );
}

#[test]
fn reload_no_report_socket_is_unsupported() {
    let home = short_home();
    let out = reload(home.path(), "/x", Duration::from_millis(200));
    assert_eq!(out.kind, Kind::Unsupported);
    assert!(out.detail.starts_with("dial unix "), "{}", out.detail);
}

#[test]
fn reload_refusal_carries_reason() {
    let home = short_home();
    let _rx = fake_daemon(
        home.path(),
        Some(reply(false, &format!("{REASON_PREFLIGHT}: 판이 다르다"))),
    );
    let out = reload(home.path(), "/x", Duration::from_secs(1));
    assert_eq!(
        out,
        Outcome::new(Kind::Refused, REASON_PREFLIGHT, "판이 다르다")
    );
}

#[test]
fn reload_no_reply_is_refused() {
    let home = short_home();
    let _rx = fake_daemon(home.path(), None);
    let out = reload(home.path(), "/x", Duration::from_secs(1));
    assert_eq!(out.kind, Kind::Refused);
    assert_eq!(out.reason, REASON_NO_REPLY);
}

#[test]
fn classify_table() {
    let cases = [
        (reply(true, ""), None, Kind::Swapped),
        (
            reply(
                false,
                &format!("{OLD_DAEMON_UNKNOWN_METHOD}: daemon.reload"),
            ),
            None,
            Kind::Unsupported,
        ),
        (
            reply(false, &format!("{REASON_BUSY}: 진행 중")),
            None,
            Kind::Refused,
        ),
        (reply(false, ""), None, Kind::Refused),
        (reply(false, ""), Some("EOF"), Kind::Refused),
    ];
    for (r, e, k) in cases {
        assert_eq!(classify(&r, e).kind, k, "{r:?} {e:?}");
    }
    assert_eq!(classify(&reply(false, ""), None).detail, "빈 답");
    assert_eq!(
        classify(&reply(false, "x"), None),
        Outcome::new(Kind::Refused, "x", "")
    );
}

#[test]
fn hello_needs_ok() {
    let home = short_home();
    assert!(!hello(home.path(), Duration::from_millis(200)));
    let got = fake_daemon(home.path(), Some(reply(true, "")));
    assert!(hello(home.path(), Duration::from_secs(1)));
    assert_eq!(
        String::from_utf8(got.recv().unwrap()).unwrap(),
        "{\"method\":\"daemon.hello\",\"body\":{}}\n"
    );
}

#[test]
fn parse_daemon_args_cases() {
    let v = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(parse_daemon_args(&[]).unwrap(), DaemonArgs::default());
    assert!(
        parse_daemon_args(&v(&["--handover-version"]))
            .unwrap()
            .version_query
    );
    assert_eq!(
        parse_daemon_args(&v(&["--handover-fd", "7"]))
            .unwrap()
            .handover_fd,
        7
    );
    assert_eq!(
        parse_daemon_args(&v(&["--handover-fd", "+7"]))
            .unwrap()
            .handover_fd,
        7
    );
    let err = |a: &[&str]| parse_daemon_args(&v(a)).unwrap_err();
    assert_eq!(err(&["--handover-fd"]), "--handover-fd 뒤에 fd 가 없습니다");
    assert_eq!(
        err(&["--handover-fd", "x"]),
        r#"--handover-fd 의 값이 fd 가 아닙니다: "x""#
    );
    assert_eq!(
        err(&["--handover-fd", "2"]),
        r#"--handover-fd 의 값이 fd 가 아닙니다: "2""#
    );
    assert_eq!(
        err(&["--handover-fd", " 7"]),
        r#"--handover-fd 의 값이 fd 가 아닙니다: " 7""#
    );
    assert_eq!(err(&["--what"]), "알 수 없는 데몬 인자: --what");
}
