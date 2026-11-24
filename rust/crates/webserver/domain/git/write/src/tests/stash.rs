//! Go `stash_test.go`.

use std::path::Path;

use otter_webserver_domain_git_core::{self as core, Kind, Output, Runner, Service};
use otter_webserver_domain_git_query as query;

use super::support::*;
use crate::*;

fn stash_rec(gd: &str, oid: &str, gs: &str, ct: &str) -> String {
    format!("{}\0\n", [gd, oid, gs, ct].join("\0"))
}

fn rep(c: char, n: usize) -> String {
    c.to_string().repeat(n)
}

#[test]
fn parse_stash_list_forms() {
    let out = stash_rec(
        "stash@{0}",
        &rep('a', 40),
        "WIP on main: abc123 subject",
        "1700000000",
    ) + &stash_rec(
        "stash@{1}",
        &rep('b', 40),
        "On feat/a: has: colon in msg",
        "1700000060",
    ) + &stash_rec(
        "stash@{2}",
        &rep('c', 40),
        "WIP on (no branch): abc123 subject",
        "1700000120",
    );
    let got = parse_stash_list(&out).unwrap();
    let st = |index, oid: String, message: &str, base: &str, at_unix_ms| Stash {
        index,
        oid,
        message: message.into(),
        base: base.into(),
        at_unix_ms,
    };
    assert_eq!(
        got,
        vec![
            st(0, rep('a', 40), "abc123 subject", "main", 1_700_000_000_000),
            st(
                1,
                rep('b', 40),
                "has: colon in msg",
                "feat/a",
                1_700_000_060_000
            ),
            st(
                2,
                rep('c', 40),
                "abc123 subject",
                "(no branch)",
                1_700_000_120_000
            ),
        ]
    );
}

#[test]
fn parse_stash_list_short_record_is_error() {
    let cases = [
        format!("stash@{{0}}\0{}\0WIP on main: x\0\n", rep('a', 40)),
        stash_rec("refs/stash", &rep('a', 40), "WIP on main: x", "1700000000"),
        stash_rec("stash@{x}", &rep('a', 40), "WIP on main: x", "1700000000"),
    ];
    for out in cases {
        assert!(parse_stash_list(&out).is_err(), "{out:?}");
    }
}

#[test]
fn parse_stash_list_unknown_subject_keeps_entry() {
    let out = stash_rec(
        "stash@{0}",
        &rep('a', 40),
        "made by another tool",
        "1700000000",
    );
    let got = parse_stash_list(&out).unwrap();
    assert!(
        got.len() == 1 && got[0].base.is_empty() && got[0].message == "made by another tool",
        "{got:?}"
    );
}

/// Go `stashStatusReader`: status 만 답하는 읽기 실행기.
fn stash_status_reader(recs: &[&str]) -> Runner {
    let mut toks = vec![
        format!("# branch.oid {}", rep('a', 40)),
        "# branch.head main".to_owned(),
    ];
    toks.extend(recs.iter().map(|s| (*s).to_owned()));
    let body = toks.join("\0") + "\0";
    runner(move |args| {
        if args[0] == "status" {
            return out(&body, "", 0);
        }
        Output::default()
    })
}

fn stash_clean_reader() -> Runner {
    stash_status_reader(&[])
}
fn stash_untracked_reader() -> Runner {
    stash_status_reader(&["? n.txt"])
}
fn stash_dirty_reader() -> Runner {
    stash_status_reader(&[&format!(
        "1 .M N... 100644 100644 100644 {} {} a.txt",
        rep('1', 40),
        rep('2', 40)
    )])
}

fn push_opts(message: &str, include_untracked: bool, keep_index: bool) -> StashPushOpts {
    StashPushOpts {
        message: message.into(),
        include_untracked,
        keep_index,
    }
}

#[tokio::test]
async fn stash_push_args() {
    let cases = [
        (push_opts("", false, false), sv(&["stash", "push"])),
        (
            push_opts("-dash leading", true, true),
            sv(&[
                "stash",
                "push",
                "--include-untracked",
                "--keep-index",
                "--message=-dash leading",
            ]),
        ),
    ];
    for (o, want) in cases {
        let f = WriteFake::default();
        let s = svc_rw(stash_dirty_reader(), &f);
        stash_push(&s, &bg(), &abs_tmp_repo(), &o).await.unwrap();
        assert_eq!(f.argvs(), vec![want]);
    }
}

#[tokio::test]
async fn stash_push_refuses_when_nothing_to_save() {
    let cases = [
        (
            "변경 없음",
            stash_clean_reader(),
            push_opts("", false, false),
            true,
        ),
        (
            "untracked 만 + -u 없음",
            stash_untracked_reader(),
            push_opts("", false, false),
            true,
        ),
        (
            "untracked 만 + -u",
            stash_untracked_reader(),
            push_opts("", true, false),
            false,
        ),
        (
            "tracked 변경",
            stash_dirty_reader(),
            push_opts("", false, false),
            false,
        ),
    ];
    for (name, read, o, refuse) in cases {
        let f = WriteFake::default();
        let s = svc_rw(read, &f);
        let res = stash_push(&s, &bg(), &abs_tmp_repo(), &o).await;
        if refuse {
            assert!(res.unwrap_err().is(WriteKind::StashEmpty), "{name}");
            assert!(f.argvs().is_empty(), "{name}: 거부됐는데 실행됐다");
            continue;
        }
        res.unwrap();
        assert_eq!(f.argvs().len(), 1, "{name}");
    }
}

fn stash_svc() -> (Service, std::sync::Arc<std::sync::Mutex<Vec<Vec<String>>>>) {
    let (w, seen) = stash_write_fake();
    (Service::builder().write_runner(w).build(), seen)
}

#[tokio::test]
async fn stash_apply_pop_args() {
    let Some(repo) = temp_repo_with_stashes() else {
        return;
    };
    let ctx = bg();
    let list = stash_list(&Service::new(), &ctx, repo.p()).await.unwrap();
    assert_eq!(list.len(), 2, "{list:?}");

    let (s, seen) = stash_svc();
    stash_apply(&s, &ctx, repo.p(), &list[1].oid, false)
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![sv(&["stash", "apply", &list[1].oid])]
    );

    let (s, seen) = stash_svc();
    stash_apply(&s, &ctx, repo.p(), &list[0].oid, true)
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![sv(&["stash", "apply", "--index", &list[0].oid])]
    );

    let (s, seen) = stash_svc();
    stash_pop(&s, &ctx, repo.p(), &list[1].oid, false)
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![sv(&["stash", "pop", "stash@{1}"])]
    );
}

#[tokio::test]
async fn stash_pop_shifted_position_still_pops_chosen_oid() {
    let Some(repo) = temp_repo_with_stashes() else {
        return;
    };
    let ctx = bg();
    let s = Service::new();
    let list = stash_list(&s, &ctx, repo.p()).await.unwrap();
    let chosen = list[0].oid.clone();
    write_file(repo.dir(), "third.txt", "t\n");
    git_run(repo.dir(), &["add", "third.txt"]);
    git_run(repo.dir(), &["stash", "push", "-q", "--message=third msg"]);
    let (res, _) = stash_pop_checked(&s, &ctx, repo.p(), &chosen, false).await;
    res.unwrap();
    let after = stash_list(&s, &ctx, repo.p()).await.unwrap();
    assert!(
        !after.iter().any(|st| st.oid == chosen),
        "고른 stash 가 남았다"
    );
    assert_eq!(after.len(), 2);
}

#[test]
fn check_stash_oid_cases() {
    for bad in ["", "stash@{0}", "HEAD", "abc", &rep('g', 40)] {
        let e = check_stash_oid(bad).unwrap_err();
        assert!(e.is_core(Kind::UnsafeArgument), "{bad:?}: {e}");
    }
    check_stash_oid(&rep('a', 40)).unwrap();
    check_stash_oid(&rep('b', 64)).unwrap();
}

#[test]
fn stash_ref_rejects_negative() {
    assert!(stash_ref_of(-1).unwrap_err().is_core(Kind::UnsafeArgument));
    assert_eq!(stash_ref_of(3).unwrap(), "stash@{3}");
}

#[tokio::test]
async fn stash_pop_checked_keeps_stash_on_conflict() {
    let Some(repo) = temp_repo_conflicting_stash() else {
        return;
    };
    let s = Service::new();
    let ctx = bg();
    let before = stash_list(&s, &ctx, repo.p()).await.unwrap();
    assert_eq!(before.len(), 1);

    let (res, kept) = stash_pop_checked(&s, &ctx, repo.p(), &before[0].oid, false).await;
    assert!(res.is_err(), "pop 이 성공했다 — 충돌 상태를 만들지 못했다");
    assert!(kept.kept, "{kept:?}");
    assert_eq!(kept.oid, before[0].oid);
    assert!(!kept.reason.is_empty());

    let after = stash_list(&s, &ctx, repo.p()).await.unwrap();
    assert!(
        after.len() == 1 && after[0].oid == before[0].oid,
        "{after:?}"
    );
    let st = query::status_of(&s, &ctx, repo.p()).await.unwrap();
    assert!(!st.conflicts.is_empty(), "{st:?}");
}

#[tokio::test]
async fn stash_pop_checked_drops_stash_on_success() {
    let Some(repo) = temp_repo_with_stashes() else {
        return;
    };
    let s = Service::new();
    let ctx = bg();
    let list0 = stash_list(&s, &ctx, repo.p()).await.unwrap();
    let (res, kept) = stash_pop_checked(&s, &ctx, repo.p(), &list0[0].oid, false).await;
    res.unwrap();
    assert!(!kept.kept, "{kept:?}");
    assert_eq!(stash_list(&s, &ctx, repo.p()).await.unwrap().len(), 1);
}

#[tokio::test]
async fn stash_drop_hint_before_executing() {
    let Some(repo) = temp_repo_with_stashes() else {
        return;
    };
    let ctx = bg();
    let (s, seen) = stash_svc();
    let list = stash_list(&s, &ctx, repo.p()).await.unwrap();
    stash_drop(&s, &ctx, repo.p(), &list[0].oid).await.unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![sv(&["stash", "drop", "stash@{0}"])]
    );
    assert!(s.records(0).last().unwrap().destructive);

    let hints = s.hints(0);
    assert_eq!(hints.len(), 1);
    let h = &hints[0];
    assert!(
        h.action == core::ACTION_STASH_DROP && h.repo == repo.p(),
        "{h:?}"
    );
    assert_eq!(h.targets, Some(sv(&["stash@{0}"])));
    assert_eq!(h.values, Some(vec![list[0].oid.clone()]));
    assert!(
        h.command.starts_with("git stash store ") && h.command.contains(&list[0].oid),
        "{:?}",
        h.command
    );
    assert!(h.command.contains(&list[0].message), "{:?}", h.command);
}

#[tokio::test]
async fn stash_drop_missing_index() {
    let Some(repo) = temp_repo_with_stashes() else {
        return;
    };
    let (s, seen) = stash_svc();
    let e = stash_drop(&s, &bg(), repo.p(), &rep('d', 40))
        .await
        .unwrap_err();
    assert!(e.is(WriteKind::StashMoved), "{e}");
    assert!(seen.lock().unwrap().is_empty());
    assert!(s.hints(0).is_empty());
}

#[tokio::test]
async fn stash_preview_reuses_name_status_parser() {
    let Some(repo) = temp_repo_rename_stash() else {
        return;
    };
    let s = Service::new();
    let list = stash_list(&s, &bg(), repo.p()).await.unwrap();
    let files = stash_preview(&s, &bg(), repo.p(), &list[0].oid)
        .await
        .unwrap();
    assert_eq!(files.len(), 1, "{files:?}");
    let f = &files[0];
    assert!(
        f.status == "R" && f.orig_path == "old.txt" && f.path == "new.txt" && f.score != 0,
        "{f:?}"
    );
}

/// Go `tempRepoWithStashes`: 서로 충돌하지 않는 stash 2개.
pub(super) fn temp_repo_with_stashes() -> Option<Fx> {
    let repo = temp_repo()?;
    for name in ["first", "second"] {
        let file = format!("{name}.txt");
        write_file(repo.dir(), &file, &format!("stashed {name}\n"));
        git_run(repo.dir(), &["add", &file]);
        git_run(
            repo.dir(),
            &["stash", "push", "-q", &format!("--message={name} msg")],
        );
    }
    Some(repo)
}

/// Go `tempRepoConflictingStash`: pop 이 반드시 충돌한다.
fn temp_repo_conflicting_stash() -> Option<Fx> {
    let repo = temp_repo()?;
    let d: &Path = repo.dir();
    write_file(d, "c.txt", "line1\nline2\nline3\n");
    git_run(d, &["add", "c.txt"]);
    git_run(d, &["commit", "-qm", "base"]);
    write_file(d, "c.txt", "line1\nSTASHED\nline3\n");
    git_run(d, &["stash", "push", "-q", "--message=conflicting"]);
    write_file(d, "c.txt", "line1\nOTHER\nline3\n");
    git_run(d, &["add", "c.txt"]);
    git_run(d, &["commit", "-qm", "other"]);
    Some(repo)
}

/// Go `tempRepoRenameStash`: rename 하나를 담은 stash.
fn temp_repo_rename_stash() -> Option<Fx> {
    let repo = temp_repo()?;
    let d: &Path = repo.dir();
    write_file(d, "old.txt", "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n");
    git_run(d, &["add", "old.txt"]);
    git_run(d, &["commit", "-qm", "base"]);
    git_run(d, &["mv", "old.txt", "new.txt"]);
    write_file(d, "new.txt", "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\nx\n");
    git_run(d, &["stash", "push", "-q", "--message=rename"]);
    Some(repo)
}

#[test]
fn stash_branch_args_cases() {
    assert_eq!(
        stash_branch_args("feat/a", 2).unwrap(),
        sv(&["stash", "branch", "feat/a", "stash@{2}"])
    );
}

#[test]
fn stash_branch_args_rejects() {
    for (name, index) in [("", 0), ("   ", 0), ("--force", 0), ("a..b", 0), ("ok", -1)] {
        assert!(
            stash_branch_args(name, index).is_err(),
            "StashBranchArgs({name:?},{index})"
        );
    }
}

#[tokio::test]
async fn stash_branch_executes_once() {
    let Some(repo) = temp_repo_with_stashes() else {
        return;
    };
    let (s, seen) = stash_svc();
    let list = stash_list(&s, &bg(), repo.p()).await.unwrap();
    let (res, _) = stash_branch(&s, &bg(), repo.p(), "feat/a", &list[0].oid).await;
    res.unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![sv(&["stash", "branch", "feat/a", "stash@{0}"])]
    );
    assert!(!s.records(0).last().unwrap().destructive);
}

#[tokio::test]
async fn stash_branch_missing_index() {
    let Some(repo) = temp_repo_with_stashes() else {
        return;
    };
    let (s, seen) = stash_svc();
    let (res, _) = stash_branch(&s, &bg(), repo.p(), "feat/a", &rep('d', 40)).await;
    assert!(res.unwrap_err().is(WriteKind::StashMoved));
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn stash_branch_real() {
    let Some(repo) = temp_repo_with_stashes() else {
        return;
    };
    let ctx = bg();
    let s = Service::new();
    let before = stash_list(&s, &ctx, repo.p()).await.unwrap();
    let (res, _) = stash_branch(&s, &ctx, repo.p(), "from-stash", &before[0].oid).await;
    res.unwrap();
    let after = stash_list(&s, &ctx, repo.p()).await.unwrap();
    assert_eq!(after.len(), before.len() - 1);
    let st = query::status_of(&s, &ctx, repo.p()).await.unwrap();
    assert_eq!(st.branch, "from-stash");
}
