//! Go `exec_count_test.go`. Go 는 PATH 의 git 을 바꿔 프로세스를 셌다. 여기서는 Service 의
//! runner 경계에서 실제 git 호출을 센다 — 같은 수, 같은 argv 다.

use dm_webserver_domain_git_core::Service;

use super::resolve::merge_ignoring_conflict;
use super::stash::temp_repo_with_stashes;
use super::support::*;
use crate::remote::PROGRESS_FLAG;
use crate::*;

#[tokio::test]
async fn push_spec_status_skips_untracked() {
    let Some(repo) = temp_repo_with_remote() else {
        return;
    };
    git_run(repo.dir(), &["push", "-q", "-u", "origin", "main"]);
    write_file(repo.dir(), "u.txt", "untracked\n");
    let c = Count::default();

    let (res, _) = push_spec(&c.service(), &bg(), repo.p(), &PushOpts::default()).await;
    assert_eq!(res.unwrap().argv, sv(&["push", PROGRESS_FLAG]));
    let calls = c.calls();
    assert!(
        calls.len() == 1
            && has_arg(&calls[0], "status")
            && has_arg(&calls[0], "--untracked-files=no"),
        "calls = {calls:?}"
    );

    git_run(repo.dir(), &["checkout", "-q", "-b", "side"]);
    c.reset();
    let (res, plan) = push_spec(&c.service(), &bg(), repo.p(), &PushOpts::default()).await;
    assert!(
        res.unwrap_err().is(WriteKind::PublishRequired)
            && plan.branch == "side"
            && plan.remote == "origin",
        "{plan:?}"
    );
    assert!(
        c.n() == 2 && has_arg(&c.calls()[0], "--untracked-files=no"),
        "calls = {:?}",
        c.calls()
    );

    git_run(repo.dir(), &["checkout", "-q", "--detach"]);
    let (res, _) = push_spec(&c.service(), &bg(), repo.p(), &PushOpts::default()).await;
    assert!(res.unwrap_err().is(WriteKind::DetachedPush));
}

#[tokio::test]
async fn stash_push_status_skips_untracked() {
    let Some(repo) = temp_repo() else { return };
    write_file(repo.dir(), "README.md", "changed\n");
    write_file(repo.dir(), "u.txt", "untracked\n");
    let c = Count::default();

    stash_push(&c.service(), &bg(), repo.p(), &StashPushOpts::default())
        .await
        .unwrap();
    let calls = c.calls();
    assert!(
        calls.len() == 2
            && has_arg(&calls[0], "--untracked-files=no")
            && has_arg(&calls[1], "stash"),
        "calls = {calls:?}"
    );

    c.reset();
    let e = stash_push(&c.service(), &bg(), repo.p(), &StashPushOpts::default())
        .await
        .unwrap_err();
    assert!(
        e.is(WriteKind::StashEmpty) && e.to_string().contains("추적되지 않는 파일 1개뿐이다"),
        "거부 = {e}"
    );
    for call in c.calls() {
        assert!(
            !has_arg(&call, "stash"),
            "거부했는데 stash 를 실행했다: {:?}",
            c.calls()
        );
    }

    c.reset();
    stash_push(
        &c.service(),
        &bg(),
        repo.p(),
        &StashPushOpts {
            include_untracked: true,
            ..StashPushOpts::default()
        },
    )
    .await
    .unwrap();
    let calls = c.calls();
    assert!(
        calls.len() == 2 && has_arg(&calls[0], "--untracked-files=all"),
        "calls = {calls:?}"
    );
}

#[tokio::test]
async fn stash_pop_checked_three_processes() {
    let Some(repo) = temp_repo_with_stashes() else {
        return;
    };
    let c = Count::default();
    let s = c.service();
    let list = stash_list(&s, &bg(), repo.p()).await.unwrap();
    assert_eq!(list.len(), 2, "{list:?}");
    c.reset();
    let (res, kept) = stash_pop_checked(&s, &bg(), repo.p(), &list[0].oid, false).await;
    res.unwrap();
    assert!(!kept.kept, "{kept:?}");
    assert_eq!(c.n(), 3, "{:?}", c.calls());
}

/// Go `conflictRepoN`: n 개의 UU 충돌과 theirs 가 지운 f(UD).
fn conflict_repo_n(n: usize) -> Option<(Fx, Vec<String>)> {
    let repo = temp_repo()?;
    let d = repo.dir().to_path_buf();
    git_run(&d, &["config", "core.autocrlf", "false"]);
    let mut paths = sv(&["f"]);
    paths.extend((0..n).map(|i| format!("g{i}")));
    for p in &paths {
        write_file(&d, p, "base\n");
    }
    let mut add = vec!["add"];
    add.extend(paths.iter().map(String::as_str));
    git_run(&d, &add);
    git_run(&d, &["commit", "-q", "-m", "base"]);
    git_run(&d, &["checkout", "-q", "-b", "del"]);
    git_run(&d, &["rm", "-q", "f"]);
    for p in &paths[1..] {
        write_file(&d, p, "theirs\n");
    }
    git_run(&d, &["commit", "-q", "-am", "theirs"]);
    git_run(&d, &["checkout", "-q", "main"]);
    for p in &paths {
        write_file(&d, p, "ours\n");
    }
    git_run(&d, &["commit", "-q", "-am", "ours"]);
    merge_ignoring_conflict(&repo, "del");
    Some((repo, paths))
}

#[tokio::test]
async fn resolve_batches_paths() {
    let Some((repo, paths)) = conflict_repo_n(3) else {
        return;
    };
    let c = Count::default();
    let res = resolve(&c.service(), &bg(), repo.p(), RESOLVE_THEIRS, &paths)
        .await
        .unwrap();
    for (i, r) in res.iter().enumerate() {
        assert!(r.path == paths[i] && r.ok, "결과[{i}] = {r:?}");
    }
    assert_eq!(c.n(), 4, "{:?}", c.calls());
    assert!(!repo.join("f").exists(), "theirs 가 지운 f 가 남아 있다");
    for p in &paths[1..] {
        assert_eq!(
            std::fs::read_to_string(repo.join(p)).unwrap(),
            "theirs\n",
            "{p}"
        );
    }
    assert_eq!(git_run(repo.dir(), &["ls-files", "-u"]), "");
}

#[tokio::test]
async fn resolve_batch_failure_falls_back_per_path() {
    let Some((repo, paths)) = conflict_repo_n(2) else {
        return;
    };
    let req = vec![paths[1].clone(), "nope".to_owned(), paths[2].clone()];
    let res = resolve(&Service::new(), &bg(), repo.p(), RESOLVE_OURS, &req)
        .await
        .unwrap();
    assert!(
        res.len() == 3 && res[0].ok && !res[1].ok && !res[1].error.is_empty() && res[2].ok,
        "결과 = {res:?}"
    );
    for p in [&paths[1], &paths[2]] {
        assert_eq!(
            std::fs::read_to_string(repo.join(p)).unwrap(),
            "ours\n",
            "{p}"
        );
    }
    assert_eq!(
        git_run(repo.dir(), &["ls-files", "-u", "--", &paths[1], &paths[2]]),
        ""
    );
}
