use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::support::*;
use crate::*;
use dm_webserver_domain_git_core::Service;

/// rev 마다 blob 을 답하는 가짜. 없는 rev 는 "does not exist in 'HEAD'" 다.
#[derive(Clone, Default)]
pub(crate) struct DiffFake {
    pub blobs: HashMap<String, Vec<u8>>,
    pub sizes: HashMap<String, i64>,
    pub argvs: Arc<Mutex<Vec<String>>>,
}

impl DiffFake {
    pub(crate) fn blob(mut self, rev: &str, body: &[u8]) -> Self {
        self.blobs.insert(rev.into(), body.to_vec());
        self
    }

    pub(crate) fn service(&self) -> Service {
        let me = self.clone();
        Service::builder()
            .runner(runner(move |_, _, a| {
                me.argvs.lock().unwrap().push(a.join(" "));
                let rev = a.last().unwrap();
                let Some(body) = me.blobs.get(rev) else {
                    let p = rev.strip_prefix("HEAD:").unwrap_or(rev);
                    let p = p.strip_prefix(':').unwrap_or(p);
                    return Ok(out(
                        "",
                        &format!("fatal: path '{p}' does not exist in 'HEAD'\n"),
                        128,
                    ));
                };
                if a[0] == "cat-file" {
                    let n = me.sizes.get(rev).copied().unwrap_or(body.len() as i64);
                    return Ok(out(&format!("{n}\n"), "", 0));
                }
                Ok(dm_webserver_domain_git_core::Output {
                    stdout: body.clone(),
                    ..Default::default()
                })
            }))
            .build()
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        self.argvs.lock().unwrap().clone()
    }
}

fn pfake() -> DiffFake {
    DiffFake::default()
        .blob(":p.txt", b"index\n")
        .blob("HEAD:p.txt", b"head\n")
}

#[tokio::test]
async fn axis_argv_and_sides() {
    let cases = [
        (
            AXIS_WORKTREE_INDEX,
            &["cat-file -s :p.txt", "show :p.txt"][..],
            "index\n",
            "work\n",
        ),
        (
            AXIS_INDEX_HEAD,
            &[
                "cat-file -s HEAD:p.txt",
                "show HEAD:p.txt",
                "cat-file -s :p.txt",
                "show :p.txt",
            ],
            "head\n",
            "index\n",
        ),
        (
            AXIS_WORKTREE_HEAD,
            &["cat-file -s HEAD:p.txt", "show HEAD:p.txt"],
            "head\n",
            "work\n",
        ),
    ];
    for (axis, want, orig, modi) in cases {
        let repo = temp_dir();
        write_file(&repo.path, "p.txt", "work\n");
        let f = pfake();
        let dc = diff_content_of(&f.service(), &bg(), &repo.path, axis, "p.txt", "")
            .await
            .unwrap();
        assert_eq!(f.calls(), want);
        assert!(
            dc.axis == axis
                && dc.path == "p.txt"
                && dc.orig_path == "p.txt"
                && dc.repo == repo.path
        );
        assert!(
            dc.original.kind == DIFF_KIND_TEXT
                && dc.modified.kind == DIFF_KIND_TEXT
                && dc.note.is_empty()
        );
        assert_eq!(
            (dc.original.content.as_str(), dc.modified.content.as_str()),
            (orig, modi)
        );
    }
}

#[tokio::test]
async fn added_deleted_dir_untracked_initial() {
    let repo = temp_dir();
    write_file(&repo.path, "new.txt", "hello\n");
    let f = DiffFake::default();
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "new.txt",
        "",
    )
    .await
    .unwrap();
    assert!(
        dc.original.kind == DIFF_KIND_ABSENT
            && dc.original.content.is_empty()
            && dc.original.size == 0
    );
    assert!(
        dc.modified.kind == DIFF_KIND_TEXT
            && dc.modified.content == "hello\n"
            && dc.modified.size == 6
    );
    assert_eq!(dc.note, "새로 추가된 파일입니다 — 이전 내용이 없습니다");
    assert!(f.calls().iter().all(|c| !c.starts_with("show")));

    let f = DiffFake::default().blob(":gone.txt", b"bye\n");
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "gone.txt",
        "",
    )
    .await
    .unwrap();
    assert!(dc.original.content == "bye\n" && dc.modified.kind == DIFF_KIND_ABSENT);
    assert_eq!(dc.note, "삭제된 파일입니다 — 현재 내용이 없습니다");

    std::fs::create_dir_all(format!("{}/d", repo.path)).unwrap();
    let f = DiffFake::default().blob(":d", b"x\n");
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "d",
        "",
    )
    .await
    .unwrap();
    assert_eq!(dc.modified.kind, DIFF_KIND_ABSENT);

    for stderr in [
        "fatal: path 'new.txt' exists on disk, but not in the index\n",
        "fatal: invalid object name 'HEAD'.\n",
    ] {
        let (s, _) = fake(out("", stderr, 128));
        let dc = diff_content_of(&s, &bg(), &repo.path, AXIS_WORKTREE_HEAD, "new.txt", "")
            .await
            .unwrap();
        assert!(dc.original.kind == DIFF_KIND_ABSENT && dc.modified.kind == DIFF_KIND_TEXT);
    }
    let (s, _) = fake(out("", "fatal: unable to read object\n", 128));
    assert!(
        diff_content_of(&s, &bg(), &repo.path, AXIS_INDEX_HEAD, "a.txt", "")
            .await
            .is_err()
    );

    let f = DiffFake::default().blob(":deep/gone.txt", b"x\n");
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "deep/gone.txt",
        "",
    )
    .await
    .unwrap();
    assert_eq!(dc.modified.kind, DIFF_KIND_ABSENT);
    let e = diff_content_of(
        &DiffFake::default().service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "nowhere.txt",
        "",
    )
    .await
    .unwrap_err();
    assert!(e.is(QueryKind::DiffBothAbsent));
    assert_eq!(
        e.to_string(),
        format!(
            "diff_both_absent: {} 의 worktree-index 축 양쪽에 \"nowhere.txt\" 가 없다",
            repo.path
        )
    );
}

#[tokio::test]
async fn binary_lfs_too_large() {
    let repo = temp_dir();
    std::fs::write(format!("{}/b.bin", repo.path), b"PNG\x00\x01\x02").unwrap();
    let f = DiffFake::default().blob(":b.bin", b"GIF\x00head");
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "b.bin",
        "",
    )
    .await
    .unwrap();
    for side in [&dc.original, &dc.modified] {
        assert!(side.kind == DIFF_KIND_BINARY && side.content.is_empty() && side.size != 0);
    }
    assert_eq!(dc.note, "바이너리 파일입니다 — 본문을 표시하지 않습니다");

    let late = "a".repeat(dm_shared_editorlimit::BINARY_SNIFF_BYTES) + "\0";
    write_file(&repo.path, "late.txt", &late);
    let f = DiffFake::default().blob(":late.txt", b"x\n");
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "late.txt",
        "",
    )
    .await
    .unwrap();
    assert_eq!(dc.modified.kind, DIFF_KIND_TEXT);

    let ptr = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";
    write_file(&repo.path, "big.psd", ptr);
    let f = DiffFake::default().blob(":big.psd", ptr.as_bytes());
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "big.psd",
        "",
    )
    .await
    .unwrap();
    for side in [&dc.original, &dc.modified] {
        assert!(side.kind == DIFF_KIND_LFS && side.content.is_empty());
        assert_eq!(
            (side.lfs_oid.as_str(), side.lfs_size),
            (
                "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393",
                12345
            )
        );
    }
    assert_eq!(
        json(&dc.original),
        r#"{"kind":"lfs","content":"","size":130,"lfsOid":"4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393","lfsSize":12345}"#
    );

    let notlfs = "version https://git-lfs.github.com/spec/v1\n".to_owned()
        + &"x".repeat(LFS_MAX_POINTER_BYTES as usize);
    write_file(&repo.path, "notlfs.txt", &notlfs);
    let f = DiffFake::default().blob(":notlfs.txt", b"x\n");
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "notlfs.txt",
        "",
    )
    .await
    .unwrap();
    assert_eq!(dc.modified.kind, DIFF_KIND_TEXT);

    let big = vec![b'z'; DIFF_MAX_BYTES as usize + 1];
    std::fs::write(format!("{}/huge.txt", repo.path), big).unwrap();
    let mut f = DiffFake::default().blob(":huge.txt", b"index\n");
    f.sizes.insert(":huge.txt".into(), DIFF_MAX_BYTES + 1);
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "huge.txt",
        "",
    )
    .await
    .unwrap();
    assert!(dc.original.kind == DIFF_KIND_TOO_LARGE && dc.original.size == DIFF_MAX_BYTES + 1);
    assert_eq!(dc.modified.kind, DIFF_KIND_TOO_LARGE);
    assert_eq!(f.calls(), ["cat-file -s :huge.txt"]);
    assert_eq!(
        dc.note,
        "파일이 상한(32MiB)을 넘습니다 — 본문을 표시하지 않습니다"
    );

    let mut f = DiffFake::default().blob(":at.txt", b"zzzzzzzz");
    f.sizes.insert(":at.txt".into(), DIFF_MAX_BYTES);
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "at.txt",
        "",
    )
    .await
    .unwrap();
    assert_eq!(dc.original.kind, DIFF_KIND_TEXT);
}

#[tokio::test]
async fn rename_uses_orig_path() {
    let repo = temp_dir();
    let f = DiffFake::default()
        .blob("HEAD:old.txt", b"old\n")
        .blob(":new.txt", b"new\n");
    let dc = diff_content_of(
        &f.service(),
        &bg(),
        &repo.path,
        AXIS_INDEX_HEAD,
        "new.txt",
        "old.txt",
    )
    .await
    .unwrap();
    assert_eq!(
        f.calls(),
        [
            "cat-file -s HEAD:old.txt",
            "show HEAD:old.txt",
            "cat-file -s :new.txt",
            "show :new.txt"
        ]
    );
    assert!(dc.orig_path == "old.txt" && dc.path == "new.txt");
    assert!(dc.original.content == "old\n" && dc.modified.content == "new\n");
}

#[tokio::test]
async fn rejects_path_escape_and_axis() {
    let repo = temp_dir();
    let f = DiffFake::default();
    let s = f.service();
    for (p, o) in [
        ("", ""),
        ("../secret.txt", ""),
        ("a/../../secret.txt", ""),
        ("/etc/passwd", ""),
        ("a.txt", "../secret.txt"),
        ("a.txt", "/etc/passwd"),
    ] {
        let e = diff_content_of(&s, &bg(), &repo.path, AXIS_WORKTREE_INDEX, p, o)
            .await
            .unwrap_err();
        assert!(e.is(QueryKind::DiffPath), "{p} {o}: {e}");
    }
    let e = diff_content_of(&s, &bg(), &repo.path, AXIS_WORKTREE_INDEX, "../x", "")
        .await
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "unsafe_diff_path: 부모 참조가 있다: \"../x\""
    );
    for axis in ["", "commit-parent", "worktree", "INDEX-HEAD"] {
        let e = diff_content_of(&s, &bg(), &repo.path, axis, "a.txt", "")
            .await
            .unwrap_err();
        assert!(e.is(QueryKind::DiffAxis));
    }
    assert!(f.calls().is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_symlink_escape() {
    let outside = temp_dir();
    write_file(&outside.path, "secret.txt", "s\n");
    let repo = temp_dir();
    let secret = format!("{}/secret.txt", outside.path);
    std::os::unix::fs::symlink(&secret, format!("{}/link.txt", repo.path)).unwrap();
    std::os::unix::fs::symlink(&outside.path, format!("{}/dir", repo.path)).unwrap();
    let f = DiffFake::default()
        .blob(":link.txt", b"x\n")
        .blob(":dir/secret.txt", b"x\n");
    let s = f.service();
    let e = diff_content_of(
        &s,
        &bg(),
        &repo.path,
        AXIS_WORKTREE_INDEX,
        "dir/secret.txt",
        "",
    )
    .await
    .unwrap_err();
    assert!(e.is(QueryKind::DiffPath));
    let dc = diff_content_of(&s, &bg(), &repo.path, AXIS_WORKTREE_INDEX, "link.txt", "")
        .await
        .unwrap();
    assert!(dc.modified.kind == DIFF_KIND_TEXT && dc.modified.content == secret);
}

#[tokio::test]
async fn diff_content_real_git() {
    let Some(repo) = git_repo() else { return };
    let s = Service::new();
    let p = repo.path.as_str();
    write_file(p, "added.txt", "new\n");
    let dc = diff_content_of(&s, &bg(), p, AXIS_WORKTREE_INDEX, "added.txt", "")
        .await
        .unwrap();
    assert!(dc.original.kind == DIFF_KIND_ABSENT && dc.modified.kind == DIFF_KIND_TEXT);
    std::fs::remove_file(format!("{p}/README.md")).unwrap();
    let dc = diff_content_of(&s, &bg(), p, AXIS_WORKTREE_HEAD, "README.md", "")
        .await
        .unwrap();
    assert!(dc.original.content == "x\n" && dc.modified.kind == DIFF_KIND_ABSENT);
    git_run(p, &["add", "added.txt"]);
    git_run(p, &["mv", "added.txt", "moved.txt"]);
    let dc = diff_content_of(&s, &bg(), p, AXIS_INDEX_HEAD, "moved.txt", "README.md")
        .await
        .unwrap();
    assert!(dc.original.content == "x\n" && dc.modified.content == "new\n");
    let init = git_init();
    write_file(&init.path, "only.txt", "o\n");
    let dc = diff_content_of(&s, &bg(), &init.path, AXIS_WORKTREE_HEAD, "only.txt", "")
        .await
        .unwrap();
    assert!(dc.original.kind == DIFF_KIND_ABSENT && dc.modified.kind == DIFF_KIND_TEXT);
}

#[test]
fn diff_max_bytes_is_editor_limit() {
    assert_eq!(DIFF_MAX_BYTES, dm_shared_editorlimit::FILE_MAX_BYTES);
}
