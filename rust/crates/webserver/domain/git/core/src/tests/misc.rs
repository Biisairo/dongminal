use std::sync::{Arc, Mutex};

use super::support::*;
use crate::*;

#[test]
fn oid_checks() {
    let cases = [
        ("a".repeat(40), true),
        ("F".repeat(64), true),
        ("0".repeat(64), true),
        (String::new(), false),
        ("abc1234".into(), false),
        ("a".repeat(41), false),
        ("a".repeat(63), false),
        ("g".repeat(40), false),
        ("a".repeat(39) + " ", false),
    ];
    for (s, w) in cases {
        assert_eq!(is_oid(&s), w, "{s}");
    }
    assert!(is_null_oid(&"0".repeat(40)) && is_null_oid(&"0".repeat(64)));
    assert!(
        !is_null_oid(&("0".repeat(39) + "1")) && !is_null_oid(&"0".repeat(7)) && !is_null_oid("")
    );
}

#[test]
fn unix_sec_to_milli_parses() {
    assert_eq!(unix_sec_to_milli(" 12\n"), 12000);
    assert_eq!(unix_sec_to_milli("+3"), 3000);
    assert_eq!(unix_sec_to_milli("x"), 0);
}

#[test]
fn destructive_actions_cover_fr89() {
    let want = [
        ACTION_DISCARD,
        ACTION_BRANCH_DELETE,
        ACTION_STASH_DROP,
        ACTION_TAG_DELETE,
        ACTION_RESET_HARD,
        ACTION_FORCE_PUSH,
        ACTION_REMOTE_REF_DELETE,
        ACTION_RESOLVE_SIDE,
        ACTION_REBASE,
        ACTION_COMMIT_DROP,
        ACTION_CLEAN_UNTRACKED,
        ACTION_OPERATION_ABORT,
        ACTION_INDEX_LOCK_REMOVE,
    ];
    assert_eq!(DESTRUCTIVE_ACTIONS, want);
}

#[test]
fn sanitize_and_redact() {
    let cases = [
        ("https://u:p@host/x.git", "https://***@host/x.git"),
        (
            "remote: https://ghp_abcdef@github.com/o/r.git 에 밀었다",
            "remote: https://***@github.com/o/r.git 에 밀었다",
        ),
        ("ssh://git@host:22/o/r.git", "ssh://***@host:22/o/r.git"),
        ("git@github.com:o/r.git", "git@github.com:o/r.git"),
        ("https://github.com/o/r.git", "https://github.com/o/r.git"),
        ("진행 중 50%", "진행 중 50%"),
        (
            "https://user:ghp_secret@github.com/o/r.git",
            "https://***@github.com/o/r.git",
        ),
        (
            "fatal: could not read from https://u:p@host/x",
            "fatal: could not read from https://***@host/x",
        ),
        // Go `\s` 는 ASCII 공백뿐이다 — U+00A0 는 userinfo 에 남는다.
        ("https://a\u{a0}b@h", "https://***@h"),
        ("https://a\x0bb@h", "https://***@h"),
        ("https://a b@h", "https://a b@h"),
        ("", ""),
    ];
    for (i, w) in cases {
        assert_eq!(sanitize_remote(i), w, "{i:?}");
        assert_eq!(redact_secrets(i), sanitize_remote(i));
    }
    assert_eq!(sanitize_argv(&["https://u:p@h/x"]), ["https://***@h/x"]);
}

#[test]
fn hint_log_seq_and_eviction() {
    let l = HintLog::new(3);
    for i in 0..5u64 {
        let h = l.add(Hint {
            repo: abs_r(),
            action: ACTION_DISCARD.into(),
            targets: Some(vec![i.to_string()]),
            ..Hint::default()
        });
        assert!(h.seq == i + 1 && h.at_unix_ms != 0);
    }
    let mut recent = l.recent(0);
    assert_eq!(recent.len(), 3);
    for (i, h) in recent.iter().enumerate() {
        assert_eq!(
            (h.seq, h.targets.as_ref().unwrap()[0].clone()),
            (i as u64 + 3, (i + 2).to_string())
        );
    }
    assert_eq!(l.recent(1)[0].seq, 5);
    assert_eq!(l.recent(99).len(), 3);
    recent[0].action = "바뀜".into();
    assert_eq!(l.recent(0)[0].action, ACTION_DISCARD);
    let z = HintLog::default();
    assert_eq!(z.add(Hint::default()).seq, 1);
    assert_eq!(z.len(), 1);
    assert!(HintLog::new(0).recent(0).is_empty());
}

#[test]
fn hint_log_concurrent() {
    let l = Arc::new(HintLog::new(16));
    let hs: Vec<_> = (0..8)
        .map(|_| {
            let l = l.clone();
            std::thread::spawn(move || {
                for _ in 0..50 {
                    l.add(Hint::default());
                    let _ = l.recent(4);
                }
            })
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(l.len(), 16);
    assert_eq!(l.recent(1)[0].seq, 400);
}

#[test]
fn service_hints_and_wire() {
    let s = Service::new();
    assert!(s.hints(0).is_empty());
    let h = s.add_hint(Hint {
        at_unix_ms: 5,
        repo: "/r".into(),
        action: ACTION_BRANCH_DELETE.into(),
        targets: Some(vec!["feature".into()]),
        command: "git branch feature x".into(),
        ..Hint::default()
    });
    assert_eq!(h.seq, 1);
    assert_eq!(s.hints(0)[0].command, h.command);
    let j = String::from_utf8(otter_gocompat::json::marshal(&h).unwrap()).unwrap();
    assert_eq!(
        j,
        r#"{"seq":1,"atUnixMs":5,"repo":"/r","action":"branch_delete","targets":["feature"],"values":null,"command":"git branch feature x","note":""}"#
    );
    let li = LockInfo {
        path: "/p".into(),
        mtime_unix_ms: None,
    };
    assert_eq!(
        String::from_utf8(otter_gocompat::json::marshal(&li).unwrap()).unwrap(),
        r#"{"path":"/p"}"#
    );
}

#[tokio::test]
async fn git_dirs_cases() {
    let git_dir = otter_gocompat::filepath::join(&[abs_r().as_str(), ".git"]);
    let wt = otter_gocompat::filepath::join(&[git_dir.as_str(), "worktrees", "w"]);
    let cases: Vec<(Output, Result<(String, String), Kind>)> = vec![
        (
            out(&format!("{git_dir}\n.git\n"), "", 0),
            Ok((git_dir.clone(), git_dir.clone())),
        ),
        (
            out(&format!("{wt}\n{git_dir}\n"), "", 0),
            Ok((wt.clone(), git_dir.clone())),
        ),
        (out("\n", "", 0), Err(Kind::NotRepo)),
        (
            out("", "fatal: not a git repository", 128),
            Err(Kind::NotRepo),
        ),
    ];
    for (o, want) in cases {
        let got_args = Arc::new(Mutex::new(Vec::new()));
        let g = got_args.clone();
        let s = Service::builder()
            .runner(runner(move |_, _, a| {
                *g.lock().unwrap() = a;
                Ok(o.clone())
            }))
            .build();
        match (s.git_dirs(&bg(), &abs_r()).await, want) {
            (Ok(got), Ok(w)) => assert_eq!(got, w),
            (Err(e), Err(k)) => assert!(e.is(k), "{e}"),
            (got, w) => panic!("{got:?} want {w:?}"),
        }
        assert_eq!(
            got_args.lock().unwrap().join(" "),
            "rev-parse --absolute-git-dir --git-common-dir"
        );
    }
}

#[tokio::test]
async fn repo_root_cases() {
    let u = abs_user_repo();
    let cases: Vec<(Output, Result<String, Kind>)> = vec![
        (out(&format!("{u}\n"), "", 0), Ok(u.clone())),
        (
            out(
                "",
                "fatal: not a git repository (or any of the parent directories): .git\n",
                128,
            ),
            Err(Kind::NotRepo),
        ),
        (out("\n  \n", "", 0), Err(Kind::NotRepo)),
        (out("repo\n", "", 0), Err(Kind::NotRepo)),
        (out(&format!("{u}/sub/..\n"), "", 0), Ok(u.clone())),
    ];
    let cwd = otter_gocompat::filepath::join(&[u.as_str(), "sub"]);
    for (o, want) in cases {
        let s = Service::builder()
            .runner(runner(move |_, _, a| {
                assert_eq!(a, ["rev-parse", "--show-toplevel"]);
                Ok(o.clone())
            }))
            .build();
        match (s.repo_root(&bg(), &cwd).await, want) {
            (Ok(got), Ok(w)) => assert_eq!(got, w),
            (Err(e), Err(k)) => assert!(e.is(k), "{e}"),
            (got, w) => panic!("{got:?} want {w:?}"),
        }
    }
    let s = Service::builder()
        .runner(runner(|_, _, _| panic!("호출되면 안 된다")))
        .build();
    for cwd in ["", "relative"] {
        assert!(
            s.repo_root(&bg(), cwd)
                .await
                .unwrap_err()
                .is(Kind::UnsafeArgument)
        );
    }
}

#[tokio::test]
async fn repo_root_real_git() {
    if git_path().is_none() {
        return;
    }
    let repo = git_repo();
    let s = Service::new();
    assert_eq!(s.repo_root(&bg(), &repo.path).await.unwrap(), repo.path);
    let t = temp_dir();
    if let Err(e) = s.repo_root(&bg(), &t.path).await {
        assert!(e.is(Kind::NotRepo), "{e}");
    }
}

#[tokio::test]
async fn classify_index_locked() {
    let cases = [
        (
            "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running",
            true,
        ),
        (
            "fatal: Unable to create '/r/.git/worktrees/w/index.lock': File exists.",
            true,
        ),
        (
            "error: Unable to create '/r/.git/refs/heads/main.lock': File exists.",
            false,
        ),
        (
            "fatal: Unable to create '/r/.git/index.lock': Permission denied",
            false,
        ),
        ("error: pathspec 'x' did not match", false),
    ];
    for (stderr, want) in cases {
        let s = Service::builder()
            .runner(runner(move |_, _, _| Ok(out("", stderr, 128))))
            .build();
        let e = s
            .exec(&bg(), &abs_tmp_repo(), &["status"])
            .await
            .unwrap_err();
        assert_eq!(e.is(Kind::IndexLocked), want, "{stderr}");
        assert!(!is_terminal(&e) || e.is(Kind::NotRepo));
    }
    assert!(!is_terminal(&Error::new(Kind::IndexLocked, "x")));
    assert!(is_terminal(&Error::new(Kind::RepoMissing, "x")));
}

#[cfg(unix)]
#[test]
fn exclusion_key_resolves_symlink_prefix() {
    let real = temp_dir();
    let holder = temp_dir();
    let link = format!("{}/link", holder.path);
    std::os::unix::fs::symlink(&real.path, &link).unwrap();
    let real_key = exclusion_key(&real.path);
    assert_eq!(exclusion_key(&link), real_key);
    assert_eq!(
        exclusion_key(&format!("{link}/gone/deeper")),
        format!("{real_key}/gone/deeper")
    );
    assert_eq!(exclusion_key(&format!("{}/", real.path)), real_key);
}

#[tokio::test]
async fn index_lock_path_and_common_dir_key() {
    if git_path().is_none() {
        return;
    }
    let repo = git_repo();
    let s = Service::new();
    let got = s.index_lock_path(&bg(), &repo.path).await.unwrap();
    assert!(
        otter_gocompat::filepath::is_abs(&got)
            && otter_gocompat::filepath::base(&got) == "index.lock"
    );
    let dotgit = otter_gocompat::filepath::join(&[repo.path.as_str(), ".git"]);
    assert_eq!(
        exclusion_key(&otter_gocompat::filepath::dir(&got)),
        exclusion_key(&dotgit)
    );
    let info = s.index_lock_info(&bg(), &repo.path).await.unwrap();
    assert!(info.path == got && info.mtime_unix_ms.is_none());

    let base = temp_dir();
    let wt = otter_gocompat::filepath::join(&[base.path.as_str(), "wt"]);
    git_run(&repo.path, &["worktree", "add", "-q", "-b", "side", &wt]);
    let got = s.index_lock_path(&bg(), &wt).await.unwrap();
    assert!(
        otter_gocompat::filepath::to_slash(&got).contains("/worktrees/"),
        "{got}"
    );

    let main = common_dir_key(None, &bg(), &repo.path).await.unwrap();
    assert_eq!(main, exclusion_key(&dotgit));
    let linked = otter_gocompat::filepath::join(&[base.path.as_str(), "linked"]);
    git_run(&repo.path, &["worktree", "add", "--detach", "-q", &linked]);
    assert_eq!(
        Service::new().common_dir_key(&bg(), &linked).await.unwrap(),
        main
    );
}
