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
