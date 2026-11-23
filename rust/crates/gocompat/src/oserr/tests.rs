use std::io;

use super::{errno_string, go_error_string, path_error, raw_os_error, syscall_error};

// testdata/go_errno_darwin_arm64.txt: go1.27.2 darwin/arm64 의 syscall.Errno(n).Error() 와 os 오류 문구.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn errno_strings_match_go_darwin_arm64() {
    let g = crate::testutil::golden("go_errno_darwin_arm64.txt");
    for n in -1..=140 {
        let want = crate::testutil::golden_str(&g, &format!("errno_{n}"));
        assert_eq!(errno_string(n), want, "errno {n}");
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[test]
fn real_os_errors_match_go_darwin_arm64() {
    let g = crate::testutil::golden("go_errno_darwin_arm64.txt");
    let want = |n: &str| crate::testutil::golden_str(&g, n);

    let p = "/nonexistent-dm/x";
    let e = std::fs::File::open(p).map_err(|e| path_error("open", p, e));
    let e = e.expect_err("missing");
    assert_eq!(e.to_string(), want("open_missing"));
    assert_eq!(e.kind(), io::ErrorKind::NotFound);
    assert_eq!(raw_os_error(&e), Some(2));

    let (a, b) = ("/nonexistent-dm/a", "/nonexistent-dm/b");
    let e = std::fs::rename(a, b)
        .map_err(|e| super::link_error("rename", a, b, e))
        .expect_err("missing");
    assert_eq!(e.to_string(), want("rename_missing"));

    let e = syscall_error("bind", io::Error::from_raw_os_error(48));
    assert_eq!(e.to_string(), want("syscall_err"));
    assert_eq!(e.kind(), io::ErrorKind::AddrInUse);

    let e = std::fs::create_dir("/")
        .map_err(|e| path_error("mkdir", "/", e))
        .expect_err("exists");
    assert_eq!(e.to_string(), want("mkdir_root"));
}

#[test]
fn wrapping_keeps_kind_and_errno() {
    let e = path_error("open", "/x", io::Error::from_raw_os_error(13));
    assert_eq!(e.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(raw_os_error(&e), Some(13));
    assert_eq!(go_error_string(&e), e.to_string());
    let nested = syscall_error(
        "x",
        path_error("open", "/x", io::Error::from_raw_os_error(2)),
    );
    assert_eq!(raw_os_error(&nested), Some(2));
    assert_eq!(raw_os_error(&io::Error::other("plain")), None);
    assert_eq!(go_error_string(&io::Error::other("plain")), "plain");
}

#[cfg(unix)]
#[test]
fn unix_errno_lowercase_and_unknown() {
    assert_eq!(errno_string(2), "no such file or directory");
    assert_eq!(errno_string(0), "errno 0");
    assert_eq!(errno_string(100_000), "errno 100000");
}

#[test]
fn errno_string_has_no_rust_tail() {
    let s = errno_string(2);
    assert!(!s.contains("(os error"), "{s}");
    assert!(!s.ends_with(['\r', '\n']), "{s}");
    assert!(!s.is_empty());
}

// go1.27.2 darwin/arm64 실측 (FR-RDF-9): os.MkdirAll 은 막힌 그 칸의 경로로 오류를 낸다.
#[cfg(unix)]
#[test]
fn mkdir_all_matches_go_messages() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("dm-gocompat-mk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let r = root.to_string_lossy().into_owned();
    std::fs::write(format!("{r}/f"), "x").unwrap();
    let msg = |p: &str| super::mkdir_all(p, 0o755).unwrap_err().to_string();

    assert_eq!(
        msg(&format!("{r}/f/a/b")),
        format!("mkdir {r}/f: not a directory")
    );
    assert_eq!(
        msg(&format!("{r}/f")),
        format!("mkdir {r}/f: not a directory")
    );
    let e = super::mkdir_all(&format!("{r}/f"), 0o755).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::NotADirectory);
    assert_eq!(raw_os_error(&e), Some(20));
    #[cfg(target_os = "macos")]
    assert_eq!(
        msg(&format!("{r}/f/")),
        format!("mkdir {r}/f/: not a directory")
    );

    std::fs::create_dir(format!("{r}/ro")).unwrap();
    std::fs::set_permissions(format!("{r}/ro"), std::fs::Permissions::from_mode(0o555)).unwrap();
    // root 는 권한 검사를 건너뛴다.
    if std::fs::create_dir(format!("{r}/ro/probe")).is_err() {
        let e = super::mkdir_all(&format!("{r}/ro/a/b"), 0o755).unwrap_err();
        assert_eq!(e.to_string(), format!("mkdir {r}/ro/a: permission denied"));
        assert_eq!(e.kind(), io::ErrorKind::PermissionDenied);
    }
    std::fs::set_permissions(format!("{r}/ro"), std::fs::Permissions::from_mode(0o755)).unwrap();

    super::mkdir_all(&format!("{r}/d1/d2/."), 0o755).unwrap();
    assert!(std::fs::metadata(format!("{r}/d1/d2")).unwrap().is_dir());
    super::mkdir_all(&format!("{r}/x//y/"), 0o700).unwrap();
    let mode = std::fs::metadata(format!("{r}/x/y"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o077, 0, "{mode:o}");
    super::mkdir_all(&format!("{r}/x/y"), 0o700).unwrap();
    assert_eq!(msg(""), "mkdir : no such file or directory");
    let _ = std::fs::remove_dir_all(&root);
}
