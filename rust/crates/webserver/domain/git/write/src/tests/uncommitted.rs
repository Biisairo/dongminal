//! Go `uncommitted_test.go`.

use dm_webserver_domain_git_core::{self as core, Kind, Service};
use dm_webserver_domain_git_query as query;

use super::support::*;
use crate::uncommitted::remove_empty_parents;
use crate::*;

#[test]
fn uncommitted_reset_args_is_mixed() {
    let got = uncommitted_reset_args();
    assert_eq!(got, sv(&["reset", "-q", "--mixed", "HEAD"]));
    assert!(!got.iter().any(|a| a == "--hard" || a == "--soft"));
}

#[test]
fn clean_untracked_args_cases() {
    assert_eq!(clean_untracked_args(), sv(&["clean", "-q", "-f", "-d"]));
}

#[tokio::test]
async fn uncommitted_reset_not_destructive() {
    let Some(repo) = temp_repo() else { return };
    write_file(repo.dir(), "a.txt", "a\n");
    git_run(repo.dir(), &["add", "a.txt"]);
    let f = WriteFake::default();
    let s = svc_w(&f);
    uncommitted_reset(&s, &bg(), repo.p()).await.unwrap();
    assert_eq!(f.argvs(), vec![uncommitted_reset_args()]);
    assert!(!s.records(0).last().unwrap().destructive);
    assert!(s.hints(0).is_empty());
}

#[tokio::test]
async fn uncommitted_reset_no_head() {
    let Some(repo) = temp_empty_repo() else {
        return;
    };
    let f = WriteFake::default();
    let s = svc_w(&f);
    let e = uncommitted_reset(&s, &bg(), repo.p()).await.unwrap_err();
    assert!(e.is(WriteKind::UncommittedNoHead), "{e}");
    assert!(f.argvs().is_empty());
}

#[tokio::test]
async fn uncommitted_reset_keeps_worktree() {
    let Some(repo) = temp_repo() else { return };
    let ctx = bg();
    write_file(repo.dir(), "a.txt", "a\n");
    git_run(repo.dir(), &["add", "a.txt"]);
    let s = Service::new();
    uncommitted_reset(&s, &ctx, repo.p()).await.unwrap();
    let st = query::status_of(&s, &ctx, repo.p()).await.unwrap();
    assert!(st.staged.is_empty(), "{:?}", st.staged);
    assert!(
        st.untracked.len() == 1 && st.untracked[0].path == "a.txt",
        "{:?}",
        st.untracked
    );
    assert!(repo.join("a.txt").exists());
}

fn with_paths(paths: &[&str]) -> Vec<String> {
    let mut v = clean_untracked_args();
    v.push("--".to_owned());
    v.extend(paths.iter().map(|p| format!(":(literal){p}")));
    v
}

#[tokio::test]
async fn clean_untracked_destructive_with_hint() {
    let Some(repo) = temp_repo() else { return };
    write_file(repo.dir(), "u1.txt", "u\n");
    write_file(repo.dir(), "u2.txt", "u\n");
    let f = WriteFake::default();
    let s = svc_w(&f);
    clean_untracked(&s, &bg(), repo.p(), &sv(&["u2.txt", "u1.txt"]))
        .await
        .unwrap();
    assert_eq!(f.argvs(), vec![with_paths(&["u1.txt", "u2.txt"])]);
    assert!(s.records(0).last().unwrap().destructive);
    let hints = s.hints(0);
    assert_eq!(hints.len(), 1);
    let h = &hints[0];
    assert!(
        h.action == core::ACTION_CLEAN_UNTRACKED && h.repo == repo.p(),
        "{h:?}"
    );
    assert_eq!(h.command, "git stash push -u");
    assert_eq!(h.targets, Some(sv(&["u1.txt", "u2.txt"])));
}

#[tokio::test]
async fn clean_untracked_nothing_to_clean() {
    let Some(repo) = temp_repo() else { return };
    let f = WriteFake::default();
    let s = svc_w(&f);
    let e = clean_untracked(&s, &bg(), repo.p(), &sv(&["u.txt"]))
        .await
        .unwrap_err();
    assert!(e.is(WriteKind::NothingToClean), "{e}");
    assert!(f.argvs().is_empty());
    assert!(s.hints(0).is_empty());
}

#[tokio::test]
async fn clean_untracked_real() {
    let Some(repo) = temp_repo() else { return };
    let ctx = bg();
    write_file(repo.dir(), "README.md", "x\nchanged\n");
    write_file(repo.dir(), "u.txt", "u\n");
    std::fs::create_dir_all(repo.join("d")).unwrap();
    write_file(repo.dir(), "d/inner.txt", "i\n");
    let s = Service::new();
    clean_untracked(&s, &ctx, repo.p(), &sv(&["u.txt", "d/inner.txt"]))
        .await
        .unwrap();
    for p in ["u.txt", "d/inner.txt", "d"] {
        assert!(!repo.join(p).exists(), "{p} 가 남았다");
    }
    let st = query::status_of(&s, &ctx, repo.p()).await.unwrap();
    assert!(
        st.changes.len() == 1 && st.changes[0].path == "README.md",
        "{:?}",
        st.changes
    );
}

#[tokio::test]
async fn clean_untracked_requires_paths() {
    let Some(repo) = temp_repo() else { return };
    write_file(repo.dir(), "u.txt", "u\n");
    let f = WriteFake::default();
    let s = svc_w(&f);
    let e = clean_untracked(&s, &bg(), repo.p(), &[]).await.unwrap_err();
    assert!(e.is_core(Kind::UnsafeArgument), "{e}");
    assert!(f.argvs().is_empty() && s.hints(0).is_empty());
}

#[tokio::test]
async fn clean_untracked_changed_set() {
    let cases: [(&str, &[&str]); 3] = [
        ("새로 생김", &["u1.txt"]),
        ("사라짐", &["u1.txt", "u2.txt", "gone.txt"]),
        ("다른 이름", &["u1.txt", "other.txt"]),
    ];
    for (name, paths) in cases {
        let Some(repo) = temp_repo() else { return };
        write_file(repo.dir(), "u1.txt", "u\n");
        write_file(repo.dir(), "u2.txt", "u\n");
        let f = WriteFake::default();
        let s = svc_w(&f);
        let e = clean_untracked(&s, &bg(), repo.p(), &sv(paths))
            .await
            .unwrap_err();
        assert!(e.is(WriteKind::CleanChanged), "{name}: {e}");
        assert!(f.argvs().is_empty() && s.hints(0).is_empty(), "{name}");
    }
}

#[tokio::test]
async fn clean_untracked_duplicate_paths() {
    let Some(repo) = temp_repo() else { return };
    write_file(repo.dir(), "u.txt", "u\n");
    let f = WriteFake::default();
    let s = svc_w(&f);
    clean_untracked(&s, &bg(), repo.p(), &sv(&["u.txt", "u.txt"]))
        .await
        .unwrap();
    assert_eq!(f.argvs(), vec![with_paths(&["u.txt"])]);
}

#[tokio::test]
async fn clean_untracked_real_literal_and_keeps_non_empty_parent() {
    let Some(repo) = temp_repo() else { return };
    let ctx = bg();
    write_file(repo.dir(), "a[b]", "u\n");
    let s = Service::new();
    clean_untracked(&s, &ctx, repo.p(), &sv(&["a[b]"]))
        .await
        .unwrap();
    assert!(!repo.join("a[b]").exists(), "a[b] 가 남았다");

    std::fs::create_dir_all(repo.join("d").join("e")).unwrap();
    write_file(repo.dir(), "d/new.txt", "keep\n");
    remove_empty_parents(repo.p(), &sv(&["d/e/gone.txt"]));
    assert!(!repo.join("d").join("e").exists(), "빈 d/e 가 남았다");
    assert!(
        repo.join("d").join("new.txt").exists(),
        "d/new.txt 가 지워졌다"
    );
}
