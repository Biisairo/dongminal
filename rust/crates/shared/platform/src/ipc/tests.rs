use super::*;
use std::thread;

fn ipc() -> &'static dyn Ipc {
    current()
}

fn posix() -> UnixSocketIpc {
    UnixSocketIpc {
        is_endpoint: posix_is_endpoint,
    }
}

fn windows() -> UnixSocketIpc {
    UnixSocketIpc {
        is_endpoint: windows_is_endpoint,
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[test]
fn endpoint_is_under_home() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(
        ipc().endpoint(home.path()),
        home.path().join(SOCKET_FILE_NAME)
    );
}

/// listen → dial → 왕복 → remove 를 한 번에 확인한다.
#[test]
fn round_trip() {
    let home = tempfile::tempdir().unwrap();
    let ep = ipc().endpoint(home.path());
    assert!(!ipc().exists(&ep), "아직 없는 종단이 있다고 한다");
    let ln = ipc().listen(&ep).unwrap();
    assert!(ipc().exists(&ep), "만든 종단을 못 본다");

    let srv = thread::spawn(move || {
        let mut c = ln.accept().unwrap();
        let mut buf = [0u8; 4];
        let n = c.read(&mut buf).unwrap();
        c.write_all(&buf[..n]).unwrap();
        ln
    });

    let mut conn = ipc().dial(&ep, Duration::from_secs(2)).unwrap();
    conn.write_all(b"ping").unwrap();
    let mut buf = [0u8; 4];
    conn.read_exact(&mut buf).unwrap();
    assert_eq!(&buf, b"ping");
    let ln = srv.join().unwrap();

    drop(ln);
    ipc().remove(&ep).unwrap();
    assert!(!ipc().exists(&ep), "지운 종단이 남아 있다");
}

/// 없는 종단을 지우는 것은 오류가 아니다 — 잔여물 정리는 멱등이어야 한다.
#[test]
fn remove_missing_is_ok() {
    let home = tempfile::tempdir().unwrap();
    ipc().remove(&home.path().join("nope.sock")).unwrap();
}

/// 평범한 파일은 POSIX 판정에서 종단이 아니다. Windows 판정은 존재만 본다.
#[test]
fn exists_rejects_plain_file() {
    let home = tempfile::tempdir().unwrap();
    let p = home.path().join("plain");
    fs::write(&p, b"").unwrap();
    if cfg!(unix) {
        assert!(!posix().exists(&p), "평범한 파일을 종단으로 봤다");
    }
    assert!(
        windows().exists(&p),
        "Windows 판정이 존재하는 파일을 못 봤다"
    );
    assert!(!windows().exists(&home.path().join("nope")));
}

/// REFACTOR3_DEDUP_GO_SRS FR-RDG-42: 형제 소켓은 IPC 종단과 같은 폴더에 산다.
#[test]
fn sibling_socket_shares_folder() {
    let home = tempfile::tempdir().unwrap();
    let want = crate::atomic::parent_dir(&ipc().endpoint(home.path())).join("x.sock");
    assert_eq!(sibling_socket(home.path(), "x.sock"), want);
}

#[test]
fn dial_missing_error_matches_go() {
    let home = tempfile::tempdir().unwrap();
    let ep = home.path().join("s.sock");
    let e = ipc().dial(&ep, Duration::from_secs(1)).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::NotFound);
    if cfg!(unix) {
        assert_eq!(
            e.to_string(),
            format!("dial unix {}: connect: no such file or directory", s(&ep))
        );
    }
}

#[test]
fn listen_twice_error_matches_go() {
    let home = tempfile::tempdir().unwrap();
    let ep = home.path().join("s.sock");
    let _ln = ipc().listen(&ep).unwrap();
    let e = ipc().listen(&ep).unwrap_err();
    if cfg!(unix) {
        assert_eq!(
            e.to_string(),
            format!("listen unix {}: bind: address already in use", s(&ep))
        );
    }
}

#[cfg(unix)]
#[test]
fn too_long_path_is_einval_like_go() {
    let home = tempfile::tempdir().unwrap();
    let ep = home.path().join("a".repeat(120));
    let e = ipc().listen(&ep).unwrap_err();
    assert_eq!(
        e.to_string(),
        format!("listen unix {}: bind: invalid argument", s(&ep))
    );
    let e = ipc().dial(&ep, Duration::from_secs(1)).unwrap_err();
    assert_eq!(
        e.to_string(),
        format!("dial unix {}: connect: invalid argument", s(&ep))
    );
}

#[cfg(unix)]
#[test]
fn dial_plain_file_error_matches_go() {
    let home = tempfile::tempdir().unwrap();
    let p = home.path().join("plain");
    fs::write(&p, b"").unwrap();
    let e = ipc().dial(&p, Duration::from_secs(1)).unwrap_err();
    let want = if cfg!(target_os = "linux") {
        "connection refused"
    } else {
        "socket operation on non-socket"
    };
    assert_eq!(
        e.to_string(),
        format!("dial unix {}: connect: {want}", s(&p))
    );
}

/// 04-secops P1-6: 소켓은 umask 와 무관하게 0600 이다.
#[cfg(unix)]
#[test]
fn listen_sets_mode_0600() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let ep = home.path().join("s.sock");
    let _ln = ipc().listen(&ep).unwrap();
    let mode = fs::metadata(&ep).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
}

/// Go `UnixListener.Close` 는 자기가 만든 소켓 파일을 지운다.
#[test]
fn dropping_listener_unlinks() {
    let home = tempfile::tempdir().unwrap();
    let ep = home.path().join("s.sock");
    let ln = ipc().listen(&ep).unwrap();
    assert!(ep.exists() || ipc().exists(&ep));
    drop(ln);
    assert!(!ipc().exists(&ep));
    assert!(fs::symlink_metadata(&ep).is_err());
}

/// 연결 양쪽 이름과 오류 문구가 Go 와 같다: 거는 쪽은 `->경로`(linux 는 `@->경로`),
/// 받는 쪽은 `경로->`(linux 는 `경로->@`).
#[cfg(unix)]
#[test]
fn stream_errors_match_go() {
    let home = tempfile::tempdir().unwrap();
    let ep = home.path().join("s.sock");
    let ln = ipc().listen(&ep).unwrap();
    let c = ipc().dial(&ep, Duration::ZERO).unwrap();
    let a = ln.accept().unwrap();
    let unnamed = if cfg!(target_os = "linux") { "@" } else { "" };

    c.set_read_timeout(Some(Duration::from_millis(10))).unwrap();
    let e = (&c).read(&mut [0u8; 1]).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::TimedOut);
    assert_eq!(
        e.to_string(),
        format!("read unix {unnamed}->{}: i/o timeout", s(&ep))
    );

    drop(c);
    // 첫 쓰기는 버퍼에 들어갈 수 있다. 끊긴 것이 보일 때까지 쓴다.
    let e = loop {
        if let Err(e) = (&a).write(b"x") {
            break e;
        }
    };
    assert_eq!(
        e.to_string(),
        format!("write unix {}->{unnamed}: write: broken pipe", s(&ep))
    );
    assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
}

#[test]
fn eof_after_peer_shutdown() {
    let home = tempfile::tempdir().unwrap();
    let ep = home.path().join("s.sock");
    let ln = ipc().listen(&ep).unwrap();
    let c = ipc().dial(&ep, Duration::from_secs(1)).unwrap();
    let mut a = ln.accept().unwrap();
    (&c).write_all(b"hi").unwrap();
    c.shutdown(Shutdown::Write).unwrap();
    let mut got = Vec::new();
    a.read_to_end(&mut got).unwrap();
    assert_eq!(got, b"hi");
}

#[test]
fn zero_timeout_is_invalid() {
    let home = tempfile::tempdir().unwrap();
    let ep = home.path().join("s.sock");
    let ln = ipc().listen(&ep).unwrap();
    let c = ipc().dial(&ep, Duration::from_secs(1)).unwrap();
    let _a = ln.accept().unwrap();
    let e = c.set_read_timeout(Some(Duration::ZERO)).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::InvalidInput);
    c.set_read_timeout(None).unwrap();
    c.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
}

/// Go `os.Remove` 는 빈 디렉터리도 지운다.
#[test]
fn remove_takes_empty_dir() {
    let home = tempfile::tempdir().unwrap();
    let d = home.path().join("d");
    fs::create_dir(&d).unwrap();
    ipc().remove(&d).unwrap();
    assert!(!d.exists());
}

#[cfg(unix)]
#[test]
fn remove_error_matches_go() {
    let home = tempfile::tempdir().unwrap();
    let d = home.path().join("d");
    fs::create_dir(&d).unwrap();
    fs::write(d.join("f"), b"").unwrap();
    let e = ipc().remove(&d).unwrap_err();
    assert_eq!(
        e.to_string(),
        format!("remove {}: directory not empty", s(&d))
    );
}

#[cfg(unix)]
#[test]
fn into_std_keeps_connection() {
    let home = tempfile::tempdir().unwrap();
    let ep = home.path().join("s.sock");
    let ln = ipc().listen(&ep).unwrap();
    let c = ipc().dial(&ep, Duration::from_secs(1)).unwrap();
    let a = ln.accept().unwrap();
    let mut std_c = c.into_std();
    std_c.write_all(b"ok").unwrap();
    let mut buf = [0u8; 2];
    (&a).read_exact(&mut buf).unwrap();
    assert_eq!(&buf, b"ok");
}

#[test]
fn owner_only_sddl_grants_user_and_system() {
    assert_eq!(
        owner_only_sddl("S-1-5-21-1-2-3-1001"),
        "D:P(A;;FA;;;S-1-5-21-1-2-3-1001)(A;;FA;;;SY)"
    );
}
