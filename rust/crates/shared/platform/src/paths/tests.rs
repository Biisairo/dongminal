use std::fs;
use std::path::{Path, PathBuf};

use super::*;

#[test]
fn windows_log_file_uses_local_app_data() {
    let lad: PathBuf = ["C:", "Users", "u", "AppData", "Local"].iter().collect();
    let lad_s = lad.to_string_lossy().into_owned();
    let got = windows_log_file(
        |k| {
            if k == "LOCALAPPDATA" {
                lad_s.clone()
            } else {
                String::new()
            }
        },
        || PathBuf::from("T:"),
    );
    assert_eq!(got, lad.join("dongminal").join("dongminal.log"));
}

#[test]
fn windows_log_file_falls_back_to_temp() {
    let temp = Path::new("C:").join("Temp");
    let t2 = temp.clone();
    let got = windows_log_file(|_| String::new(), move || t2.clone());
    assert_eq!(got, temp.join("dongminal.log"));
}

#[test]
fn posix_default_log_file() {
    assert_eq!(
        PosixPaths.default_log_file(),
        Path::new("/tmp/dongminal.log")
    );
    assert_eq!(PosixPaths.exe_suffix(), "");
    assert_eq!(WindowsPaths.exe_suffix(), ".exe");
}

#[test]
fn win_executable_names() {
    const CUSTOM: &str = ".EXE;.PY";
    for (path, pathext, want) in [
        (r"C:\lsp\bin\gopls.exe", "", true),
        (r"C:\lsp\bin\gopls.EXE", "", true),
        (r"C:\lsp\node_modules\.bin\tsserver.cmd", "", true),
        (r"C:\x\a.bat", "", true),
        (r"C:\x\a.com", "", true),
        (r"C:\lsp\node_modules\.bin\tsserver", "", false),
        (r"C:\x\a.ps1", "", false),
        (r"C:\x\a.txt", "", false),
        (r"C:\x\a.py", CUSTOM, true),
        (r"C:\x\a.cmd", CUSTOM, false),
        (r"C:\x\a.py", "EXE ; PY", true),
    ] {
        assert_eq!(
            win_executable_name(path, pathext),
            want,
            "{path:?} {pathext:?}"
        );
    }
}

#[test]
fn is_executable_rejects_dir_and_missing() {
    let d = tempfile::tempdir().unwrap();
    for p in [&PosixPaths as &dyn Paths, &WindowsPaths] {
        assert!(!p.is_executable(d.path()));
        assert!(!p.is_executable(&d.path().join("nope.exe")));
        assert!(!p.is_executable(Path::new("")));
    }
}

#[cfg(unix)]
#[test]
fn posix_is_executable_needs_exec_bit() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let plain = d.path().join("plain");
    fs::write(&plain, "x").unwrap();
    fs::set_permissions(&plain, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(!PosixPaths.is_executable(&plain));
    let exe = d.path().join("exe");
    fs::write(&exe, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(PosixPaths.is_executable(&exe));
}

#[test]
fn file_uri_shape_per_os() {
    assert_eq!(PosixPaths.file_uri("/a/b.go"), "file:///a/b.go");
    assert_eq!(WindowsPaths.file_uri(r"C:\a\b.go"), "file:///C:/a/b.go");
}

#[test]
fn file_uri_round_trip_per_os() {
    for p in ["/a/b/c.go", "/a/b c/d.go", "/a/한글/e.go"] {
        assert_eq!(
            PosixPaths
                .path_from_file_uri(&PosixPaths.file_uri(p))
                .unwrap(),
            p
        );
    }
    for p in [r"C:\a\b.go", r"C:\a b\c.go", r"C:\한글\e.go"] {
        assert_eq!(
            WindowsPaths
                .path_from_file_uri(&WindowsPaths.file_uri(p))
                .unwrap(),
            p
        );
    }
}

#[test]
fn path_from_file_uri_rejects_non_file() {
    for p in [&PosixPaths as &dyn Paths, &WindowsPaths] {
        for uri in ["", "http://x/a.go", "::not a uri::"] {
            assert!(p.path_from_file_uri(uri).is_err(), "{uri:?}");
        }
    }
    assert_eq!(
        PosixPaths.path_from_file_uri("").unwrap_err().to_string(),
        "platform: empty file uri"
    );
    assert_eq!(
        PosixPaths
            .path_from_file_uri("http://x/a.go")
            .unwrap_err()
            .to_string(),
        "platform: not a file uri: http://x/a.go"
    );
}

/// Go 판과 같은 벡터 파일을 그대로 읽는다.
#[test]
fn file_uri_vectors_shared() {
    let raw =
        include_str!("../../../../../../internal/shared/platform/testdata/file_uri_vectors.json");
    let vs: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
    assert!(!vs.is_empty());
    for v in vs {
        let (os, path, uri) = (
            v["os"].as_str().unwrap(),
            v["path"].as_str().unwrap(),
            v["uri"].as_str().unwrap(),
        );
        let p: &dyn Paths = if os == "windows" {
            &WindowsPaths
        } else {
            &PosixPaths
        };
        assert_eq!(p.file_uri(path), uri, "{os} file_uri({path:?})");
        assert_eq!(
            p.path_from_file_uri(uri).unwrap(),
            path,
            "{os} path_from_file_uri({uri:?})"
        );
    }
}

/// go1.27.2 `url.URL{Scheme:"file",Path:p}.String()` 실측값.
#[test]
fn file_uri_matches_go_url_string() {
    for (p, want) in [
        ("", "file:"),
        ("a/b", "file://a/b"),
        ("//x/y", "file:////x/y"),
        ("/a!*()'b", "file:///a%21%2A%28%29%27b"),
        ("/a b+c", "file:///a%20b+c"),
        ("/%", "file:///%25"),
        ("/é", "file:///%C3%A9"),
        ("/a\u{1}b", "file:///a%01b"),
        ("/a\\b", "file:///a%5Cb"),
        ("/:x", "file:///:x"),
    ] {
        assert_eq!(file_uri(p, false), want, "{p:?}");
    }
}

/// go1.27.2 `url.Parse(s).Path` 실측값.
#[test]
fn path_from_uri_matches_go_url_parse() {
    for (uri, want) in [
        ("file:///a/b%20c", "/a/b c"),
        ("file://host/x", "/x"),
        ("file:/a/b", "/a/b"),
        ("file:a/b", ""),
        ("FILE:///x", "/x"),
        ("file:///a?q#f", "/a"),
        ("file:///a%2Fb", "/a/b"),
    ] {
        assert_eq!(PosixPaths.path_from_file_uri(uri).unwrap(), want, "{uri:?}");
    }
    assert_eq!(
        PosixPaths
            .path_from_file_uri("file:///%zz")
            .unwrap_err()
            .to_string(),
        "parse \"file:///%zz\": invalid URL escape \"%zz\""
    );
    assert_eq!(
        PosixPaths
            .path_from_file_uri("::not a uri::")
            .unwrap_err()
            .to_string(),
        "parse \"::not a uri::\": missing protocol scheme"
    );
}

#[test]
fn windows_link_or_copy_prefers_hard_link() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("dongminal.exe");
    fs::write(&src, "payload").unwrap();
    let dst = d.path().join("dmctl.exe");
    WindowsPaths.link_or_copy(&src, &dst).unwrap();
    assert!(
        same_file_at(&src, &dst),
        "복사가 일어났다 — 하드링크를 먼저 시도해야 한다"
    );
}

#[test]
fn windows_link_or_copy_idempotent() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("dongminal.exe");
    fs::write(&src, "payload").unwrap();
    let dst = d.path().join("dmctl.exe");
    WindowsPaths.link_or_copy(&src, &dst).unwrap();
    let before = file_id(&dst);
    WindowsPaths.link_or_copy(&src, &dst).unwrap();
    assert_eq!(before, file_id(&dst), "두 번째 설치가 파일을 갈아치웠다");
}

#[test]
fn windows_link_or_copy_replaces_stale() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("dongminal.exe");
    fs::write(&src, "new").unwrap();
    let dst = d.path().join("dmctl.exe");
    fs::write(&dst, "old").unwrap();
    WindowsPaths.link_or_copy(&src, &dst).unwrap();
    assert_eq!(fs::read_to_string(&dst).unwrap(), "new");
}
