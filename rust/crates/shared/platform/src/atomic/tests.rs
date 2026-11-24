use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;

pub(crate) fn file_id(p: &Path) -> Option<(u64, u64)> {
    crate::paths::file_id(p)
}

fn assert_only(dir: &Path, keep: &[&str]) {
    for e in fs::read_dir(dir).unwrap() {
        let name = e.unwrap().file_name().to_string_lossy().into_owned();
        assert!(
            keep.contains(&name.as_str()),
            "잔여물 {name:?} — FR-CAF-9·FR-ATI-4 위반"
        );
    }
}

#[test]
fn writes_content_and_perm() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("state.json");
    write_file_atomic(&p, br#"{"a":1}"#, 0o644).unwrap();
    assert_eq!(fs::read(&p).unwrap(), br#"{"a":1}"#);
    let perm = file_perm(&fs::metadata(&p).unwrap());
    assert_eq!(perm & 0o600, 0o600);
    #[cfg(unix)]
    assert_eq!(perm, 0o644, "umask 가 먹은 비트를 되돌려야 한다");
}

#[test]
fn replaces_existing() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("state.json");
    fs::write(&p, "아주 긴 이전 내용입니다").unwrap();
    write_file_atomic(&p, "짧다".as_bytes(), 0o644).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "짧다");
}

#[cfg(unix)]
fn can_deny_write_to_dir() -> bool {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let sub = d.path().join("ro");
    fs::create_dir(&sub).unwrap();
    fs::set_permissions(&sub, fs::Permissions::from_mode(0o500)).unwrap();
    let denied = fs::write(sub.join("probe"), "x").is_err();
    fs::set_permissions(&sub, fs::Permissions::from_mode(0o755)).unwrap();
    denied
}

#[cfg(unix)]
#[test]
fn keeps_previous_on_failure() {
    use std::os::unix::fs::PermissionsExt;
    if !can_deny_write_to_dir() {
        return;
    }
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("state.json");
    let before = r#"{"windows":[{"tabs":3}]}"#;
    fs::write(&p, before).unwrap();
    fs::set_permissions(d.path(), fs::Permissions::from_mode(0o500)).unwrap();
    let res = write_file_atomic(&p, br#"{"windows":[]}"#, 0o644);
    fs::set_permissions(d.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let e = res.expect_err("쓸 수 없는 디렉터리인데 성공했다");
    assert!(
        e.to_string().starts_with("open "),
        "Go 와 같은 open 오류여야 한다: {e}"
    );
    assert_eq!(fs::read_to_string(&p).unwrap(), before, "FR-CAF-10 위반");
}

#[test]
fn leaves_no_temp_on_failure() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("state.json");
    fs::create_dir(&p).unwrap();
    let e = write_file_atomic(&p, b"x", 0o644).expect_err("목적이 디렉터리인데 성공했다");
    assert!(e.to_string().starts_with("rename "), "{e}");
    assert_only(d.path(), &["state.json"]);
}

#[test]
fn leaves_no_temp_on_success() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("state.json");
    for i in 0..3u8 {
        write_file_atomic(&p, &[b'a' + i], 0o644).unwrap();
    }
    assert_only(d.path(), &["state.json"]);
}

#[test]
fn syncs_dir_after_rename() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("f.json");
    let synced = RefCell::new(Vec::<PathBuf>::new());
    write_file_atomic_with(&p, b"x", 0o600, |dir| {
        assert!(p.exists(), "rename 전에 디렉터리를 fsync 했다");
        synced.borrow_mut().push(dir.to_path_buf());
        sync_dir(dir)
    })
    .unwrap();
    assert_eq!(*synced.borrow(), vec![d.path().to_path_buf()]);
    #[cfg(unix)]
    assert!(sync_dir(&d.path().join("없음")).is_err());
}

#[test]
fn dir_sync_failure_is_not_write_failure() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("f.json");
    write_file_atomic_with(&p, b"x", 0o600, |_| Err(io::Error::other("boom"))).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"x");
}

#[test]
fn parent_dir_of_bare_name_is_dot() {
    assert_eq!(parent_dir(Path::new("f.json")), Path::new("."));
    assert_eq!(parent_dir(Path::new("/a/b")), Path::new("/a"));
}

#[test]
fn temp_sibling_shape() {
    let t = temp_sibling(Path::new("/x/otterctl"));
    let s = t.to_string_lossy();
    let prefix = format!("/x/otterctl.tmp{}.", std::process::id());
    assert!(s.starts_with(&prefix), "{s}");
    assert!(s[prefix.len()..].parse::<u64>().is_ok(), "{s}");
}

#[test]
fn if_changed_skips_same_content() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("hook.sh");
    write_file_if_changed(&p, b"a", 0o755).unwrap();
    let before = file_id(&p);
    write_file_if_changed(&p, b"a", 0o755).unwrap();
    assert_eq!(before, file_id(&p), "같은 내용인데 교체했다");
}

#[test]
fn if_changed_replaces_atomically() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("hook.sh");
    fs::write(&p, "old").unwrap();
    let before = file_id(&p);
    write_file_if_changed(&p, b"new", 0o755).unwrap();
    assert_eq!(fs::read_to_string(&p).unwrap(), "new");
    assert_ne!(before, file_id(&p), "제자리에서 덮어썼다");
    #[cfg(unix)]
    assert_eq!(file_perm(&fs::metadata(&p).unwrap()), 0o755);
}

#[cfg(unix)]
#[test]
fn if_changed_fixes_mode() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("hook.sh");
    fs::write(&p, "a").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
    write_file_if_changed(&p, b"a", 0o755).unwrap();
    assert_eq!(file_perm(&fs::metadata(&p).unwrap()), 0o755);
}

#[test]
fn copy_executable_copies_with_exec_bit() {
    let d = tempfile::tempdir().unwrap();
    let (src, dst) = (d.path().join("src"), d.path().join("dst"));
    fs::write(&src, "payload").unwrap();
    copy_executable(&src, &dst).unwrap();
    assert_eq!(fs::read_to_string(&dst).unwrap(), "payload");
    #[cfg(unix)]
    assert_ne!(file_perm(&fs::metadata(&dst).unwrap()) & 0o111, 0);
}

#[test]
fn copy_executable_overwrites() {
    let d = tempfile::tempdir().unwrap();
    let (src, dst) = (d.path().join("src"), d.path().join("dst"));
    fs::write(&src, "new").unwrap();
    fs::write(&dst, "old-and-longer").unwrap();
    copy_executable(&src, &dst).unwrap();
    assert_eq!(fs::read_to_string(&dst).unwrap(), "new");
}

#[test]
fn copy_executable_missing_src_is_go_open_error() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("nope");
    let e = copy_executable(&src, &d.path().join("dst")).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::NotFound);
    #[cfg(unix)]
    assert_eq!(
        e.to_string(),
        format!("open {}: no such file or directory", src.display())
    );
}

/// dst 를 계속 지켜보며 사라진 순간을 센다 (FR-ATI-1, V-ATI-1).
fn watch_missing(path: PathBuf) -> (Arc<AtomicBool>, std::thread::JoinHandle<usize>) {
    let stop = Arc::new(AtomicBool::new(false));
    let s = stop.clone();
    let h = std::thread::spawn(move || {
        let mut misses = 0;
        while !s.load(Ordering::Relaxed) {
            if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == io::ErrorKind::NotFound) {
                misses += 1;
            }
            std::thread::sleep(Duration::from_micros(200));
        }
        misses
    });
    (stop, h)
}

#[test]
fn link_or_copy_never_leaves_destination_missing() {
    let d = tempfile::tempdir().unwrap();
    let (a, b, dst) = (
        d.path().join("srcA"),
        d.path().join("srcB"),
        d.path().join("otterctl"),
    );
    fs::write(&a, "srcA").unwrap();
    fs::write(&b, "srcB").unwrap();
    let p = crate::current().paths;
    p.link_or_copy(&a, &dst).unwrap();
    let (stop, h) = watch_missing(dst.clone());
    for i in 0..120 {
        let src = if i % 2 == 1 { &b } else { &a };
        p.link_or_copy(src, &dst).unwrap();
    }
    stop.store(true, Ordering::Relaxed);
    assert_eq!(
        h.join().unwrap(),
        0,
        "설치 중 dst 가 사라졌다 — FR-ATI-1 위반"
    );
}

#[test]
fn copy_never_exposes_partial_content() {
    let d = tempfile::tempdir().unwrap();
    let blob_a = vec![b'A'; 256 << 10];
    let blob_b = vec![b'B'; 256 << 10];
    let (a, b, dst) = (
        d.path().join("srcA"),
        d.path().join("srcB"),
        d.path().join("otterctl"),
    );
    fs::write(&a, &blob_a).unwrap();
    fs::write(&b, &blob_b).unwrap();
    for (src, want) in [(&a, &blob_a), (&b, &blob_b), (&a, &blob_a)] {
        copy_executable(src, &dst).unwrap();
        assert_eq!(&fs::read(&dst).unwrap(), want);
    }
    if cfg!(windows) {
        return; // 열려 있는 파일을 대체할 수 없는 호스트다.
    }
    let stop = Arc::new(AtomicBool::new(false));
    let bad = Arc::new(Mutex::new(None::<String>));
    let h = {
        let (stop, bad, dst) = (stop.clone(), bad.clone(), dst.clone());
        let (ba, bb) = (blob_a.clone(), blob_b.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match fs::read(&dst) {
                    Ok(got) if got == ba || got == bb => {}
                    Ok(got) => {
                        *bad.lock().unwrap() = Some(format!("부분 내용 관측: len={}", got.len()));
                        return;
                    }
                    Err(e) => {
                        *bad.lock().unwrap() = Some(format!("읽기 실패: {e}"));
                        return;
                    }
                }
            }
        })
    };
    for i in 0..12 {
        copy_executable(if i % 2 == 1 { &b } else { &a }, &dst).unwrap();
    }
    stop.store(true, Ordering::Relaxed);
    h.join().unwrap();
    assert_eq!(*bad.lock().unwrap(), None, "FR-ATI-2 위반");
}

#[test]
fn link_or_copy_leaves_no_temp_files() {
    let d = tempfile::tempdir().unwrap();
    let (a, b, dst) = (
        d.path().join("srcA"),
        d.path().join("srcB"),
        d.path().join("otterctl"),
    );
    fs::write(&a, "srcA").unwrap();
    fs::write(&b, "srcB").unwrap();
    let p = crate::current().paths;
    for s in [&a, &b, &a] {
        p.link_or_copy(s, &dst).unwrap();
    }
    assert_only(d.path(), &["srcA", "srcB", "otterctl"]);
}

#[test]
fn link_or_copy_same_target_is_noop() {
    let d = tempfile::tempdir().unwrap();
    let (src, dst) = (d.path().join("src"), d.path().join("otterctl"));
    fs::write(&src, "x").unwrap();
    let p = crate::current().paths;
    p.link_or_copy(&src, &dst).unwrap();
    if fs::read_link(&dst).is_err() {
        return; // 이 호스트는 심링크로 설치하지 않는다.
    }
    let before = fs::symlink_metadata(&dst).unwrap().modified().unwrap();
    std::thread::sleep(Duration::from_millis(20));
    p.link_or_copy(&src, &dst).unwrap();
    let after = fs::symlink_metadata(&dst).unwrap().modified().unwrap();
    assert_eq!(before, after, "같은 대상인데 다시 걸었다 — FR-ATI-3 위반");
}

#[test]
fn link_or_copy_resolves_to_source() {
    let d = tempfile::tempdir().unwrap();
    let (a, b, dst) = (
        d.path().join("srcA"),
        d.path().join("srcB"),
        d.path().join("otterctl"),
    );
    fs::write(&a, "payload-A").unwrap();
    fs::write(&b, "payload-B").unwrap();
    let p = crate::current().paths;
    for (src, want) in [(&a, "payload-A"), (&b, "payload-B"), (&a, "payload-A")] {
        p.link_or_copy(src, &dst).unwrap();
        assert_eq!(fs::read_to_string(&dst).unwrap().trim(), want);
    }
}

/// Go `os.Remove` 처럼 옆으로 밀어 둔 빈 디렉터리도 지운다 — `<dst>.old` 가 남지 않는다.
#[test]
fn copy_executable_over_empty_dir_leaves_no_aside() {
    let d = tempfile::tempdir().unwrap();
    let src = d.path().join("src");
    std::fs::write(&src, b"bin").unwrap();
    let dst = d.path().join("otterctl");
    std::fs::create_dir(&dst).unwrap();
    std::fs::create_dir(d.path().join("otterctl.old")).unwrap();
    crate::copy_executable(&src, &dst).unwrap();
    assert_eq!(std::fs::read(&dst).unwrap(), b"bin");
    assert!(!d.path().join("otterctl.old").exists());
}
