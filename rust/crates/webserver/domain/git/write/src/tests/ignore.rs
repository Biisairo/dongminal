//! Go `ignore_test.go`.

use dm_gocompat::filepath;

use super::support::*;
use crate::*;

#[test]
fn ignore_pattern_rejects_escape() {
    let root = abs_repo();
    let sibling = filepath::join(&[abs_repo_other().as_str(), "f.txt"]);
    let etc = abs_etc_passwd();
    let cases = [
        ("부모 참조", "../outside.txt"),
        ("중간의 부모 참조", "src/../../outside.txt"),
        ("루트 밖 절대경로", etc.as_str()),
        ("루트의 형제", sibling.as_str()),
        ("빈 경로", ""),
        ("공백뿐", "   "),
        ("NUL", "a\0b"),
        ("정규화되지 않음", "src//a.txt"),
        ("저장소 루트 자신", "."),
    ];
    for (name, p) in cases {
        let r = ignore_pattern(&root, p);
        assert!(
            r.as_ref().is_err_and(|e| e.is(WriteKind::IgnorePath)),
            "{name}: IgnorePattern({p:?}) = {r:?}"
        );
    }
}

#[test]
fn ignore_pattern_accepts() {
    let root = abs_repo();
    let a = filepath::join(&[root.as_str(), "a.txt"]);
    let deep = filepath::join(&[root.as_str(), "src", "deep", "a.txt"]);
    let cases = [
        ("a.txt", "/a.txt"),
        ("src/a.txt", "/src/a.txt"),
        (
            "디렉터리 한글/파일 이름.txt",
            "/디렉터리 한글/파일 이름.txt",
        ),
        (a.as_str(), "/a.txt"),
        (deep.as_str(), "/src/deep/a.txt"),
    ];
    for (input, want) in cases {
        assert_eq!(ignore_pattern(&root, input).unwrap(), want, "{input:?}");
    }
}

#[test]
fn ignore_file_root_only() {
    let fx = temp_fx();
    assert_eq!(ignore_file(fx.p()), filepath::join(&[fx.p(), ".gitignore"]));
}

fn read(p: &str) -> String {
    std::fs::read_to_string(p).unwrap()
}

#[test]
fn ignore_add_no_duplicate_line() {
    let fx = temp_fx();
    let first = ignore_add(fx.p(), &sv(&["a.txt", "src/b.txt"])).unwrap();
    assert_eq!(first.added.join(","), "/a.txt,/src/b.txt");
    assert!(first.skipped.is_empty(), "{:?}", first.skipped);

    let second = ignore_add(fx.p(), &sv(&["a.txt", "c.txt"])).unwrap();
    assert_eq!(second.added.join(","), "/c.txt");
    assert_eq!(second.skipped.join(","), "/a.txt");

    let body = read(&ignore_file(fx.p()));
    assert_eq!(body.matches("/a.txt\n").count(), 1, "{body}");
    assert_eq!(body, "/a.txt\n/src/b.txt\n/c.txt\n");
}

#[test]
fn ignore_add_duplicate_within_request() {
    let fx = temp_fx();
    let abs_a = filepath::join(&[fx.p(), "a.txt"]);
    let res = ignore_add(fx.p(), &sv(&["a.txt", "a.txt", &abs_a])).unwrap();
    assert_eq!(res.added.join(","), "/a.txt");
    assert_eq!(read(&ignore_file(fx.p())), "/a.txt\n");
}

#[test]
fn ignore_add_fixes_missing_trailing_newline() {
    let fx = temp_fx();
    std::fs::write(ignore_file(fx.p()), "node_modules").unwrap();
    ignore_add(fx.p(), &sv(&["a.txt"])).unwrap();
    assert_eq!(read(&ignore_file(fx.p())), "node_modules\n/a.txt\n");
}

#[test]
fn ignore_add_matches_unanchored_existing() {
    let fx = temp_fx();
    std::fs::write(ignore_file(fx.p()), "# 주석\n\na.txt\n").unwrap();
    let res = ignore_add(fx.p(), &sv(&["a.txt"])).unwrap();
    assert!(
        res.added.is_empty() && res.skipped.join(",") == "/a.txt",
        "{res:?}"
    );
    assert_eq!(read(&ignore_file(fx.p())), "# 주석\n\na.txt\n");
}

#[test]
fn ignore_add_rejects_before_writing() {
    let fx = temp_fx();
    let e = ignore_add(fx.p(), &sv(&["a.txt", "../outside.txt"])).unwrap_err();
    assert!(e.is(WriteKind::IgnorePath), "{e}");
    assert!(!std::path::Path::new(&ignore_file(fx.p())).exists());
}

#[test]
fn ignore_add_empty_list() {
    let fx = temp_fx();
    let e = ignore_add(fx.p(), &[]).unwrap_err();
    assert!(e.is(WriteKind::IgnorePath), "{e}");
}

// DIFF-15: 저장소 밖을 가리키는 `.gitignore` 링크에는 쓰지 않는다. 안을 가리키면 쓴다.
#[cfg(unix)]
#[test]
fn ignore_add_rejects_link_outside_repo() {
    let repo = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = repo.path().to_str().unwrap().to_owned();
    let victim = outside.path().join("victim");
    std::fs::write(&victim, "keep\n").unwrap();
    std::os::unix::fs::symlink(&victim, repo.path().join(".gitignore")).unwrap();
    let e = ignore_add(&root, &["a.txt".to_owned()]).unwrap_err();
    assert!(e.is(WriteKind::IgnorePath), "{e}");
    assert!(e.to_string().contains("저장소 밖"), "{e}");
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep\n");

    // 대상이 없는 링크도 밖이면 거절한다.
    std::fs::remove_file(repo.path().join(".gitignore")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("nope"), repo.path().join(".gitignore"))
        .unwrap();
    assert!(
        ignore_add(&root, &["a.txt".to_owned()])
            .unwrap_err()
            .is(WriteKind::IgnorePath)
    );

    // 저장소 안을 가리키면 그대로 쓴다.
    std::fs::remove_file(repo.path().join(".gitignore")).unwrap();
    std::fs::write(repo.path().join("real-ignore"), "").unwrap();
    std::os::unix::fs::symlink("real-ignore", repo.path().join(".gitignore")).unwrap();
    let res = ignore_add(&root, &["a.txt".to_owned()]).unwrap();
    assert_eq!(res.added, vec!["/a.txt".to_owned()]);
    assert_eq!(
        std::fs::read_to_string(repo.path().join("real-ignore")).unwrap(),
        "/a.txt\n"
    );
}
