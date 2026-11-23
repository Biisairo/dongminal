//! Go `branch_test.go`.

use dm_webserver_domain_git_core::{self as core, Kind, Service};
use dm_webserver_domain_git_query as query;

use super::support::*;
use crate::remote::PROGRESS_FLAG;
use crate::stage::PATHS_SEP;
use crate::tag::PUSH_DELETE_FLAG;
use crate::*;

fn co(r: &str, create: &str, track: &str, detach: bool, force: bool) -> CheckoutOpts {
    CheckoutOpts {
        r#ref: r.into(),
        create: create.into(),
        track: track.into(),
        detach,
        force,
    }
}

#[test]
fn checkout_args_order() {
    let cases = [
        (
            co("main", "", "", false, false),
            sv(&["checkout", "main", "--"]),
        ),
        (
            co("abc123", "", "", true, false),
            sv(&["checkout", "--detach", "abc123", "--"]),
        ),
        (
            co("main", "", "", false, true),
            sv(&["checkout", "--force", "main", "--"]),
        ),
        (
            co("", "feat", "", false, false),
            sv(&["checkout", "-b", "feat", "--"]),
        ),
        (
            co("abc123", "feat", "", false, false),
            sv(&["checkout", "-b", "feat", "abc123", "--"]),
        ),
        (
            co("", "feat", "origin/feat", false, false),
            sv(&["checkout", "-b", "feat", "--track", "origin/feat", "--"]),
        ),
    ];
    for (o, want) in cases {
        assert_eq!(checkout_args(&o).unwrap(), want, "{o:?}");
    }
}

#[tokio::test]
async fn checkout_file_named_ref_does_not_restore_file() {
    let Some(repo) = temp_repo() else { return };
    let f = repo.join("f.txt");
    std::fs::write(&f, "committed\n").unwrap();
    git_run(repo.dir(), &["add", "f.txt"]);
    git_run(repo.dir(), &["commit", "-q", "-m", "f"]);
    let dirty = "uncommitted\n";
    std::fs::write(&f, dirty).unwrap();

    let spec = checkout_spec(&co("f.txt", "", "", false, false)).unwrap();
    assert_eq!(spec.argv.last().unwrap(), PATHS_SEP, "argv={:?}", spec.argv);
    assert!(
        Service::new()
            .exec_write(&bg(), repo.p(), &spec)
            .await
            .is_err(),
        "없는 ref 의 checkout 이 성공했다"
    );
    assert_eq!(std::fs::read_to_string(&f).unwrap(), dirty);
}

#[test]
fn checkout_args_rejects() {
    let w = |k| move |e: &Error| e.is(k);
    let c = |k| move |e: &Error| e.is_core(k);
    let cases: Vec<(CheckoutOpts, Box<dyn Fn(&Error) -> bool>)> = vec![
        (
            CheckoutOpts::default(),
            Box::new(w(WriteKind::CheckoutTarget)),
        ),
        (
            co("", "", "origin/feat", false, false),
            Box::new(w(WriteKind::CheckoutTarget)),
        ),
        (
            co("main", "f", "origin/f", false, false),
            Box::new(w(WriteKind::CheckoutTarget)),
        ),
        (co("-x", "", "", false, false), Box::new(c(Kind::RefName))),
        (co("a..b", "", "", false, false), Box::new(c(Kind::RefName))),
        (co("a\0b", "", "", false, false), Box::new(c(Kind::RefName))),
        (co("", "  ", "", false, false), Box::new(c(Kind::RefName))),
    ];
    for (o, ok) in cases {
        let e = checkout_args(&o).unwrap_err();
        assert!(ok(&e), "{o:?}: err = {e}");
    }
}

#[test]
fn checkout_spec_force_declared_destructive() {
    for force in [false, true] {
        let spec = checkout_spec(&co("main", "", "", false, force)).unwrap();
        assert_eq!(spec.destructive, force);
    }
}

#[tokio::test]
async fn checkout_remote_branch_creates_tracking() {
    let Some(repo) = temp_repo_with_remote() else {
        return;
    };
    let s = Service::new();
    let ctx = bg();
    let spec = checkout_spec(&co("", "feat", "origin/feat", false, false)).unwrap();
    s.exec_write(&ctx, repo.p(), &spec).await.unwrap();
    let st = query::status_of(&s, &ctx, repo.p()).await.unwrap();
    assert_eq!(st.branch, "feat");
    assert!(
        st.has_upstream && st.upstream == "origin/feat",
        "upstream = {:?} (has={})",
        st.upstream,
        st.has_upstream
    );
}

fn bc(name: &str, start: &str, checkout: bool) -> BranchCreateOpts {
    BranchCreateOpts {
        name: name.into(),
        start_ref: start.into(),
        checkout,
    }
}

#[tokio::test]
async fn branch_create_args() {
    let Some(repo) = temp_repo() else { return };
    let cases = [
        (bc("feat", "", false), sv(&["branch", "feat"])),
        (bc("feat", "", true), sv(&["checkout", "-b", "feat"])),
        (
            bc("feat", "HEAD~0", false),
            sv(&["branch", "feat", "HEAD~0"]),
        ),
    ];
    for (o, want) in cases {
        let f = WriteFake::default();
        let s = svc_rw(real_reader(), &f);
        branch_create(&s, &bg(), repo.p(), &o).await.unwrap();
        assert_eq!(f.argvs(), vec![want]);
    }
}

#[tokio::test]
async fn branch_create_rejects_before_executing() {
    let Some(repo) = temp_repo_with_branch("feat") else {
        return;
    };
    let cases: [(BranchCreateOpts, fn(&Error) -> bool); 3] = [
        (bc("bad name", "", false), |e| e.is_core(Kind::RefName)),
        (bc("feat", "", false), |e| e.is(WriteKind::BranchExists)),
        (bc("new", "-x", false), |e| e.is_core(Kind::RefName)),
    ];
    for (o, ok) in cases {
        let f = WriteFake::default();
        let s = svc_rw(real_reader(), &f);
        let e = branch_create(&s, &bg(), repo.p(), &o).await.unwrap_err();
        assert!(ok(&e), "{o:?}: err = {e}");
        assert!(f.argvs().is_empty(), "거부됐는데 실행됐다: {:?}", f.argvs());
    }
}

#[test]
fn branch_conflict_options_enumerated() {
    assert_eq!(
        BRANCH_CONFLICT_OPTIONS,
        [
            BRANCH_CONFLICT_CHECKOUT,
            BRANCH_CONFLICT_RENAME,
            BRANCH_CONFLICT_CANCEL
        ]
    );
}

fn br(from: &str, to: &str) -> BranchRenameOpts {
    BranchRenameOpts {
        from: from.into(),
        to: to.into(),
    }
}

#[test]
fn branch_rename_args_cases() {
    assert_eq!(
        branch_rename_args(&br("old", "new")).unwrap(),
        sv(&["branch", "-m", "old", "new"])
    );
    for o in [
        br("", "new"),
        br("old", ""),
        br("-x", "new"),
        br("old", "a..b"),
        br("same", "same"),
    ] {
        assert!(branch_rename_args(&o).is_err(), "{o:?} 가 거부되지 않았다");
    }
}

fn bd(names: Option<&[&str]>, force: bool) -> BranchDeleteOpts {
    BranchDeleteOpts {
        names: names.map(sv),
        force,
    }
}

#[test]
fn branch_delete_args_cases() {
    let cases = [
        (bd(Some(&["feat"]), false), sv(&["branch", "-d", "feat"])),
        (bd(Some(&["feat"]), true), sv(&["branch", "-D", "feat"])),
        (
            bd(Some(&["a", "b"]), false),
            sv(&["branch", "-d", "a", "b"]),
        ),
    ];
    for (o, want) in cases {
        assert_eq!(branch_delete_args(&o).unwrap(), want);
    }
    for o in [
        bd(None, false),
        bd(Some(&[]), false),
        bd(Some(&["-x"]), false),
        bd(Some(&["a", "b"]), true),
    ] {
        let e = branch_delete_args(&o).unwrap_err();
        assert!(
            e.is(WriteKind::BranchDelete) || e.is_core(Kind::RefName),
            "{o:?} 의 오류가 분류되지 않았다: {e}"
        );
    }
}

#[tokio::test]
async fn branch_delete_folds_duplicate_names() {
    assert_eq!(
        branch_delete_args(&bd(Some(&["a", "b", "a"]), false)).unwrap(),
        sv(&["branch", "-d", "a", "b"])
    );
    assert_eq!(
        branch_delete_args(&bd(Some(&["a", "a"]), true)).unwrap(),
        sv(&["branch", "-D", "a"])
    );

    let Some(repo) = temp_repo_with_branch("feat") else {
        return;
    };
    let s = Service::new();
    let (res, plan) = branch_delete(&s, &bg(), repo.p(), &bd(Some(&["feat", "feat"]), false)).await;
    res.unwrap();
    assert!(
        plan.names.as_ref().map(Vec::len) == Some(1)
            && plan.oids.as_ref().map(Vec::len) == Some(1)
            && s.hints(0).len() == 1,
        "plan = {plan:?}, hints = {}",
        s.hints(0).len()
    );
}

#[tokio::test]
async fn branch_delete_hint_carries_pre_delete_oid() {
    let Some(repo) = temp_repo_with_branch("feat") else {
        return;
    };
    let f = WriteFake::default();
    let s = svc_rw(real_reader(), &f);
    let ctx = bg();
    let oid = query::branch_oid(&s, &ctx, repo.p(), "feat").await.unwrap();
    let (res, plan) = branch_delete(&s, &ctx, repo.p(), &bd(Some(&["feat"]), false)).await;
    res.unwrap();
    assert_eq!(plan.oids, Some(vec![oid.clone()]));
    let hints = s.hints(0);
    assert_eq!(hints.len(), 1, "{hints:?}");
    let h = &hints[0];
    assert_eq!(h.action, core::ACTION_BRANCH_DELETE);
    assert_eq!(h.values, Some(vec![oid.clone()]));
    assert_eq!(h.command, format!("git branch feat {oid}"));
}

#[tokio::test]
async fn branch_delete_missing_name_leaves_no_hint() {
    let Some(repo) = temp_repo_with_branch("feat") else {
        return;
    };
    let f = WriteFake::default();
    let s = svc_rw(real_reader(), &f);
    let (res, _) = branch_delete(&s, &bg(), repo.p(), &bd(Some(&["feat", "ghost"]), false)).await;
    assert!(res.is_err(), "없는 브랜치가 섞였는데 오류가 없다");
    assert!(s.hints(0).is_empty(), "{:?}", s.hints(0));
    assert!(f.argvs().is_empty(), "{:?}", f.argvs());
}

#[tokio::test]
async fn branch_delete_destructive_in_record() {
    for force in [false, true] {
        let Some(repo) = temp_repo_with_branch("feat") else {
            return;
        };
        let f = WriteFake::default();
        let s = svc_rw(real_reader(), &f);
        let (res, _) = branch_delete(&s, &bg(), repo.p(), &bd(Some(&["feat"]), force)).await;
        res.unwrap();
        let recs = s.records(0);
        assert!(
            recs.last().is_some_and(|r| r.destructive),
            "force={force}: 파괴적으로 선언되지 않았다"
        );
    }
}

#[test]
fn merge_args_cases() {
    let cases = [
        (MERGE_DEFAULT, sv(&["merge", "side"])),
        (MERGE_FF_ONLY, sv(&["merge", "--ff-only", "side"])),
        (MERGE_NO_FF, sv(&["merge", "--no-ff", "side"])),
        (MERGE_SQUASH, sv(&["merge", "--squash", "side"])),
    ];
    for (mode, want) in cases {
        let o = MergeOpts {
            r#ref: "side".into(),
            mode: mode.into(),
        };
        assert_eq!(merge_args(&o).unwrap(), want, "{mode:?}");
    }
    let e = merge_args(&MergeOpts {
        r#ref: "side".into(),
        mode: "octopus".into(),
    })
    .unwrap_err();
    assert!(e.is(WriteKind::MergeMode), "{e}");
    let e = merge_args(&MergeOpts::default()).unwrap_err();
    assert!(e.is_core(Kind::RefName), "{e}");
}

#[test]
fn rebase_spec_destructive_and_hint() {
    let head = "deadbeef";
    let o = RebaseOpts {
        r#ref: "feat".into(),
        onto: String::new(),
    };
    let (spec, hint) = rebase_spec(&abs_tmp_repo(), &o, head).unwrap();
    assert!(spec.destructive);
    assert_eq!(hint.action, core::ACTION_REBASE);
    assert_eq!(hint.command, format!("git reset --hard {head}"));
}

#[test]
fn rebase_args_cases() {
    let o = |r: &str, onto: &str| RebaseOpts {
        r#ref: r.into(),
        onto: onto.into(),
    };
    assert_eq!(
        rebase_args(&o("main", "")).unwrap(),
        sv(&["rebase", "main"])
    );
    assert_eq!(
        rebase_args(&o("main", "v1")).unwrap(),
        sv(&["rebase", "--onto", "v1", "main"])
    );
    assert!(rebase_args(&o("", "")).unwrap_err().is_core(Kind::RefName));
}

#[tokio::test]
async fn upstream_args_cases() {
    let o = |b: &str, u: &str, unset: bool| UpstreamOpts {
        branch: b.into(),
        upstream: u.into(),
        unset,
    };
    assert_eq!(
        upstream_args(&o("feat", "origin/feat", false)).unwrap(),
        sv(&["branch", "--set-upstream-to=origin/feat", "feat"])
    );
    assert_eq!(
        upstream_args(&o("feat", "", true)).unwrap(),
        sv(&["branch", "--unset-upstream", "feat"])
    );
    for x in [
        o("feat", "", false),
        o("", "origin/feat", false),
        o("feat", "-x", false),
        o("feat", "o/f", true),
    ] {
        assert!(upstream_args(&x).is_err(), "{x:?} 가 거부되지 않았다");
    }
    let f = WriteFake::default();
    let s = svc_w(&f);
    set_upstream(&s, &bg(), &abs_tmp_repo(), &o("feat", "", true))
        .await
        .unwrap();
    let recs = s.records(0);
    assert!(
        recs.last().is_some_and(|r| !r.destructive),
        "upstream 조작이 파괴적으로 선언됐다"
    );
}

fn rb(remote: &str, branch: &str) -> RemoteBranchOpts {
    RemoteBranchOpts {
        remote: remote.into(),
        branch: branch.into(),
    }
}

#[tokio::test]
async fn remote_branch_specs() {
    let spec = remote_fetch_spec(&rb("origin", "feat")).unwrap();
    assert_eq!(
        spec.argv,
        sv(&["fetch", PROGRESS_FLAG, "origin", "feat:feat"])
    );
    assert!(!spec.destructive);

    let Some(repo) = temp_repo_with_remote() else {
        return;
    };
    let s = Service::new();
    let ctx = bg();
    let (dspec, hint) = remote_branch_delete_spec(&s, &ctx, repo.p(), &rb("origin", "feat"))
        .await
        .unwrap();
    assert_eq!(
        dspec.argv,
        sv(&[
            "push",
            PROGRESS_FLAG,
            "origin",
            "--delete",
            "refs/heads/feat"
        ])
    );
    assert!(dspec.destructive);
    assert!(s.hints(0).is_empty(), "사전 단계가 hint 를 남겼다");
    assert_eq!(hint.action, core::ACTION_REMOTE_REF_DELETE);
    let oid = query::remote_branch_oid(&s, &ctx, repo.p(), "origin/feat")
        .await
        .unwrap();
    assert_eq!(hint.values, Some(vec![oid.clone()]));
    assert_eq!(
        hint.command,
        format!("git push origin {oid}:refs/heads/feat")
    );
}

fn bp(branch: &str, force: &str, publish: bool) -> BranchPushOpts {
    BranchPushOpts {
        branch: branch.into(),
        force: force.into(),
        confirm: false,
        publish,
    }
}

#[tokio::test]
async fn branch_push_spec_publish_for_non_current_branch() {
    let Some(mut repo) = temp_repo_with_branch("feat") else {
        return;
    };
    let (t, base) = temp_dir();
    git_run(
        repo.dir(),
        &[
            "remote",
            "add",
            "origin",
            base.join("r.git").to_str().unwrap(),
        ],
    );
    repo.keep(t);
    let s = Service::new();
    let ctx = bg();

    let (res, plan) = branch_push_spec(&s, &ctx, repo.p(), &bp("feat", "", false)).await;
    assert!(res.unwrap_err().is(WriteKind::PublishRequired));
    assert!(
        plan.publish && plan.remote == "origin" && plan.branch == "feat",
        "{plan:?}"
    );
    let (res, plan) = branch_push_spec(&s, &ctx, repo.p(), &bp("feat", "", true)).await;
    let spec = res.unwrap();
    assert_eq!(
        spec.argv,
        sv(&["push", PROGRESS_FLAG, "-u", "origin", "feat"])
    );
    assert!(!spec.destructive);
    assert!(plan.publish, "{plan:?}");
}

#[tokio::test]
async fn branch_push_spec_force() {
    let Some(repo) = temp_repo_with_remote() else {
        return;
    };
    git_run(
        repo.dir(),
        &["checkout", "-q", "-b", "feat", "--track", "origin/feat"],
    );
    git_run(repo.dir(), &["checkout", "-q", "main"]);
    let s = Service::new();
    let ctx = bg();

    let (res, _) = branch_push_spec(&s, &ctx, repo.p(), &bp("feat", PUSH_FORCE, false)).await;
    assert!(res.unwrap_err().is(WriteKind::ForceConfirm));
    let (res, _) = branch_push_spec(&s, &ctx, repo.p(), &bp("feat", PUSH_LEASE, false)).await;
    let spec = res.unwrap();
    assert!(spec.destructive);
    assert_eq!(
        spec.argv,
        sv(&[
            "push",
            PROGRESS_FLAG,
            "--force-with-lease",
            "origin",
            "feat:refs/heads/feat"
        ])
    );
    let (res, _) = branch_push_spec(&s, &ctx, repo.p(), &bp("feat", "yolo", false)).await;
    assert!(res.unwrap_err().is(WriteKind::PushForce));
}

#[tokio::test]
async fn branch_rename_rejects_taken_name() {
    let Some(repo) = temp_repo_with_branch("feat") else {
        return;
    };
    let f = WriteFake::default();
    let s = svc_rw(real_reader(), &f);
    let e = branch_rename(&s, &bg(), repo.p(), &br("feat", "main"))
        .await
        .unwrap_err();
    assert!(e.is(WriteKind::BranchExists), "{e}");
    assert!(f.argvs().is_empty());
}

#[tokio::test]
async fn branch_push_spec_pushes_to_upstream_branch_name() {
    let Some(repo) = temp_repo_with_remote() else {
        return;
    };
    git_run(
        repo.dir(),
        &[
            "checkout",
            "-q",
            "-b",
            "local-name",
            "--track",
            "origin/feat",
        ],
    );
    git_run(repo.dir(), &["checkout", "-q", "main"]);
    let (res, plan) = branch_push_spec(
        &Service::new(),
        &bg(),
        repo.p(),
        &bp("local-name", "", false),
    )
    .await;
    let spec = res.unwrap();
    assert_eq!(
        spec.argv,
        sv(&[
            "push",
            PROGRESS_FLAG,
            "origin",
            "local-name:refs/heads/feat"
        ])
    );
    assert!(!plan.publish && plan.remote == "origin", "{plan:?}");
}

#[tokio::test]
async fn branch_push_spec_local_upstream_rejected() {
    let Some(repo) = temp_repo_with_remote() else {
        return;
    };
    git_run(
        repo.dir(),
        &["checkout", "-q", "-b", "topic", "--track", "main"],
    );
    git_run(repo.dir(), &["checkout", "-q", "main"]);
    let (res, _) =
        branch_push_spec(&Service::new(), &bg(), repo.p(), &bp("topic", "", false)).await;
    assert!(res.unwrap_err().is(WriteKind::UpstreamLocal));
}

#[tokio::test]
async fn remote_branch_delete_spec_full_ref() {
    let Some(repo) = temp_repo_with_remote() else {
        return;
    };
    let (spec, _) =
        remote_branch_delete_spec(&Service::new(), &bg(), repo.p(), &rb("origin", "feat"))
            .await
            .unwrap();
    assert_eq!(
        spec.argv,
        sv(&[
            "push",
            PROGRESS_FLAG,
            "origin",
            PUSH_DELETE_FLAG,
            "refs/heads/feat"
        ])
    );
}
