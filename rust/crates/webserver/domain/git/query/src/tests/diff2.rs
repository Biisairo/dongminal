use super::diff::DiffFake;
use super::support::*;
use crate::*;
use otter_webserver_domain_git_core::{Service, WriteSpec};

#[cfg(unix)]
#[tokio::test]
async fn tracked_symlink_compares_link_text() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    write_file(p, "real.txt", "REAL\n");
    write_file(p, "other.txt", "OTHER\n");
    std::os::unix::fs::symlink("real.txt", format!("{p}/in")).unwrap();
    git_run(p, &["add", "real.txt", "other.txt", "in"]);
    git_run(p, &["commit", "-q", "-m", "link"]);
    std::fs::remove_file(format!("{p}/in")).unwrap();
    std::os::unix::fs::symlink("other.txt", format!("{p}/in")).unwrap();
    let dc = diff_content_of(&Service::new(), &bg(), p, AXIS_WORKTREE_HEAD, "in", "")
        .await
        .unwrap();
    assert_eq!(
        (dc.original.content.as_str(), dc.modified.content.as_str()),
        ("real.txt", "other.txt")
    );
}

/// 서브모듈 포인터를 바꾼 커밋. (repo, oid, parent).
fn add_submodule_commit() -> Option<(Temp, Temp, String, String)> {
    let sub = git_repo()?;
    write_file(&sub.path, "own.txt", "own\n");
    git_run(&sub.path, &["add", "own.txt"]);
    git_run(&sub.path, &["commit", "-q", "-m", "own"]);
    let repo = git_repo()?;
    git_run(
        &repo.path,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &sub.path,
            "sub",
        ],
    );
    git_run(&repo.path, &["commit", "-q", "-m", "add sub"]);
    let parent = git_run(&repo.path, &["rev-parse", "HEAD"]);
    write_file(&sub.path, "more.txt", "m\n");
    git_run(&sub.path, &["add", "more.txt"]);
    git_run(&sub.path, &["commit", "-q", "-m", "more"]);
    let inner = format!("{}/sub", repo.path);
    git_run(
        &inner,
        &[
            "-c",
            "protocol.file.allow=always",
            "pull",
            "-q",
            "origin",
            "HEAD",
        ],
    );
    git_run(&repo.path, &["add", "sub"]);
    git_run(&repo.path, &["commit", "-q", "-m", "bump sub"]);
    let oid = git_run(&repo.path, &["rev-parse", "HEAD"]);
    Some((repo, sub, oid, parent))
}

#[tokio::test]
async fn submodule_pointer_is_submodule_kind() {
    let Some((repo, _sub, oid, parent)) = add_submodule_commit() else {
        return;
    };
    let dc = diff_commit(&Service::new(), &bg(), &repo.path, &oid, &parent, "sub", "")
        .await
        .unwrap();
    assert!(dc.original.kind == DIFF_KIND_SUBMODULE && dc.modified.kind == DIFF_KIND_SUBMODULE);
    assert!(
        dc.original.oid.len() == 40
            && dc.modified.oid.len() == 40
            && dc.original.oid != dc.modified.oid
    );
    let dc = diff_content_of(
        &Service::new(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_HEAD,
        "sub",
        "",
    )
    .await
    .unwrap();
    assert!(dc.original.kind == DIFF_KIND_SUBMODULE && dc.modified.kind == DIFF_KIND_SUBMODULE);
    assert_eq!(dc.note, "서브모듈입니다 — 가리키는 커밋이 바뀌었습니다");
}

#[tokio::test]
async fn side_bytes_worktree() {
    let Some(repo) = git_repo() else { return };
    write_file(&repo.path, "big.bin", &"x".repeat(100));
    let img = Service::builder().max_output(10).build();
    let e = side_bytes(
        &img,
        &bg(),
        &repo.path,
        AXIS_WORKTREE_HEAD,
        "big.bin",
        "",
        "",
        "",
        DIFF_SIDE_MODIFIED,
    )
    .await
    .unwrap_err();
    assert!(e.is(QueryKind::DiffTooLarge));
    assert_eq!(e.to_string(), "diff_image_too_large");
    #[cfg(unix)]
    {
        let outside = temp_dir();
        write_file(&outside.path, "secret.png", "SECRET");
        std::os::unix::fs::symlink(
            format!("{}/secret.png", outside.path),
            format!("{}/l.png", repo.path),
        )
        .unwrap();
        let b = side_bytes(
            &Service::new(),
            &bg(),
            &repo.path,
            AXIS_WORKTREE_HEAD,
            "l.png",
            "",
            "",
            "",
            DIFF_SIDE_MODIFIED,
        )
        .await
        .unwrap();
        assert_ne!(b, b"SECRET");
    }
}

#[tokio::test]
async fn decode_as_per_side() {
    let repo = temp_dir();
    write_file(&repo.path, "k.txt", "한글 줄\n");
    let cp949: &[u8] = &[0xC7, 0xD1, 0xB1, 0xDB, 0x20, 0xC1, 0xD9, 0x0A];
    let f = DiffFake::default().blob(":k.txt", cp949);
    let mut dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "k.txt",
        "",
    )
    .await
    .unwrap();
    dc.decode_as("cp949");
    assert!(dc.original.content == "한글 줄\n" && dc.original.encoding == "cp949");
    assert!(dc.modified.content == "한글 줄\n" && dc.modified.encoding == "utf-8");
    assert_eq!(dc.original.decodable, Some(true));

    std::fs::write(
        format!("{}/w.txt", repo.path),
        [0xFF, 0xFE, b'h', 0, b'i', 0],
    )
    .unwrap();
    let f = DiffFake::default().blob(":w.txt", &[0, 1, 2, 3]);
    let mut dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "w.txt",
        "",
    )
    .await
    .unwrap();
    assert_eq!(dc.modified.kind, DIFF_KIND_BINARY);
    dc.decode_as("utf-16le");
    assert!(
        dc.modified.kind == DIFF_KIND_TEXT
            && dc.modified.content == "hi"
            && dc.modified.encoding == "utf-16le"
    );
    assert_eq!(dc.original.kind, DIFF_KIND_BINARY);

    std::fs::write(format!("{}/x.txt", repo.path), [0xFF, 0xFF, 0x80, b'a']).unwrap();
    let f = DiffFake::default().blob(":x.txt", b"a\n");
    let mut dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "x.txt",
        "",
    )
    .await
    .unwrap();
    dc.decode_as("utf-8");
    assert!(dc.modified.kind == DIFF_KIND_TEXT && dc.modified.decodable == Some(false));
}

#[tokio::test]
async fn diff_commit_fakes() {
    let (s, seen) = fake(out("3\n", "", 0));
    let dc = diff_commit(&s, &bg(), &abs_r(), "aaa", "bbb", "new.txt", "old.txt")
        .await
        .unwrap();
    assert_eq!(dc.axis, AXIS_COMMIT_PARENT);
    let all: Vec<String> = seen.lock().unwrap().iter().map(|a| a.join(" ")).collect();
    assert!(
        all.contains(&"cat-file -s bbb:old.txt".to_owned())
            && all.contains(&"cat-file -s aaa:new.txt".to_owned())
    );

    let s = Service::builder()
        .runner(runner(|_, _, a| {
            Ok(if a[0] == "cat-file" {
                out("2\n", "", 0)
            } else {
                out("a\n", "", 0)
            })
        }))
        .build();
    let dc = diff_commit(&s, &bg(), &abs_r(), "aaa", "", "f.txt", "")
        .await
        .unwrap();
    assert!(
        dc.original.kind == DIFF_KIND_ABSENT
            && dc.modified.kind == DIFF_KIND_TEXT
            && !dc.note.is_empty()
    );

    let s = Service::builder()
        .runner(runner(|_, _, _| panic!("거부돼야 한다")))
        .build();
    for (o, p) in [("-x", "bbb"), ("aaa", "-x"), ("", "bbb")] {
        assert!(
            diff_commit(&s, &bg(), &abs_r(), o, p, "f.txt", "")
                .await
                .unwrap_err()
                .is(QueryKind::UnsafeRev)
        );
    }
    assert!(
        diff_commit(&s, &bg(), &abs_r(), "aaa", "bbb", "../etc/passwd", "")
            .await
            .unwrap_err()
            .is(QueryKind::DiffPath)
    );
}

#[tokio::test]
async fn diff_commit_real_git() {
    let Some(repo) = git_repo() else { return };
    let s = Service::new();
    let p = repo.path.as_str();
    let first = git_run(p, &["rev-parse", "HEAD"]);
    write_file(p, "README.md", "x\nsecond line\n");
    for argv in [vec!["add", "-A"], vec!["commit", "-qm", "second"]] {
        let spec = WriteSpec {
            argv: argv.into_iter().map(String::from).collect(),
            ..WriteSpec::default()
        };
        s.exec_write(&bg(), p, &spec).await.unwrap();
    }
    let second = git_run(p, &["rev-parse", "HEAD"]);
    let dc = diff_commit(&s, &bg(), p, &second, &first, "README.md", "")
        .await
        .unwrap();
    assert!(dc.original.content == "x\n" && dc.modified.content == "x\nsecond line\n");
    let root = diff_commit(&s, &bg(), p, &first, "", "README.md", "")
        .await
        .unwrap();
    assert_eq!(root.original.kind, DIFF_KIND_ABSENT);
}
