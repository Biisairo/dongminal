//! Go `tag_test.go`.

use dm_webserver_domain_git_core::{self as core, Kind, Service};
use dm_webserver_domain_git_query as query;

use super::support::*;
use crate::*;

fn tc(name: &str, r: &str, kind: &str, message: &str) -> TagCreateOpts {
    TagCreateOpts {
        name: name.into(),
        r#ref: r.into(),
        kind: kind.into(),
        message: message.into(),
    }
}

fn tr(remote: &str, name: &str, all: bool) -> TagRemoteOpts {
    TagRemoteOpts {
        remote: remote.into(),
        name: name.into(),
        all,
    }
}

#[test]
fn tag_create_args_kind_and_message() {
    let cases = [
        (tc("v1.0", "", "", ""), sv(&["tag", "v1.0"])),
        (tc("v1.0", "", "", "뜻이 없다"), sv(&["tag", "v1.0"])),
        (tc("v1.0", "abc123", "", ""), sv(&["tag", "v1.0", "abc123"])),
        (
            tc("v1.0", "", TAG_ANNOTATED, "릴리스"),
            sv(&["tag", "-a", "-m", "릴리스", "v1.0"]),
        ),
        (
            tc("v1.0", "abc123", TAG_ANNOTATED, "릴리스"),
            sv(&["tag", "-a", "-m", "릴리스", "v1.0", "abc123"]),
        ),
        (
            tc("v1.0", "", TAG_SIGNED, "서명"),
            sv(&["tag", "-s", "-m", "서명", "v1.0"]),
        ),
    ];
    for (o, want) in cases {
        assert_eq!(tag_create_args(&o).unwrap(), want, "{o:?}");
    }
}

#[test]
fn tag_create_args_rejects() {
    let r: fn(&Error) -> bool = |e| e.is_core(Kind::RefName);
    let cases: [(TagCreateOpts, fn(&Error) -> bool); 8] = [
        (tc("", "", "", ""), r),
        (tc("-x", "", "", ""), r),
        (tc("a..b", "", "", ""), r),
        (tc("a\0b", "", "", ""), r),
        (tc("v1", "-x", "", ""), r),
        (tc("v1", "", "gpg", ""), |e| e.is(WriteKind::TagKind)),
        (tc("v1", "", TAG_ANNOTATED, ""), |e| {
            e.is(WriteKind::TagMessage)
        }),
        (tc("v1", "", TAG_SIGNED, ""), |e| {
            e.is(WriteKind::TagMessage)
        }),
    ];
    for (o, ok) in cases {
        let e = tag_create_args(&o).unwrap_err();
        assert!(ok(&e), "{o:?}: {e}");
    }
}

type RemoteArgs = fn(&TagRemoteOpts) -> Result<Vec<String>, Error>;

#[test]
fn tag_remote_and_delete_args() {
    assert_eq!(tag_delete_args("v1.0").unwrap(), sv(&["tag", "-d", "v1.0"]));
    let cases: [(RemoteArgs, TagRemoteOpts, Vec<String>); 3] = [
        (
            tag_push_args,
            tr("origin", "v1.0", false),
            sv(&["push", "--progress", "origin", "refs/tags/v1.0"]),
        ),
        (
            tag_push_args,
            tr("origin", "", true),
            sv(&["push", "--progress", "origin", "--tags"]),
        ),
        (
            tag_delete_remote_args,
            tr("origin", "v1.0", false),
            sv(&["push", "--progress", "origin", "--delete", "refs/tags/v1.0"]),
        ),
    ];
    for (f, o, want) in cases {
        assert_eq!(f(&o).unwrap(), want, "{o:?}");
    }
}

#[test]
fn tag_remote_args_rejects() {
    let target: fn(&Error) -> bool = |e| e.is(WriteKind::TagPushTarget);
    let refname: fn(&Error) -> bool = |e| e.is_core(Kind::RefName);
    let cases: [(RemoteArgs, TagRemoteOpts, fn(&Error) -> bool); 6] = [
        (tag_push_args, tr("origin", "", false), target),
        (tag_push_args, tr("origin", "v1", true), target),
        (tag_delete_remote_args, tr("origin", "", true), target),
        (tag_push_args, tr("", "v1", false), refname),
        (tag_push_args, tr("-x", "v1", false), refname),
        (tag_push_args, tr("a/b", "v1", false), |e| {
            e.is(WriteKind::RemoteName)
        }),
    ];
    for (f, o, ok) in cases {
        let e = f(&o).unwrap_err();
        assert!(ok(&e), "{o:?}: {e}");
    }
}

/// Go `tempRepoWithTag`: 커밋 하나 + annotated 태그 하나.
fn temp_repo_with_tag(name: &str) -> Option<Fx> {
    let repo = temp_repo()?;
    git_run(repo.dir(), &["tag", "-a", "-m", "픽스처 태그", name]);
    Some(repo)
}

#[tokio::test]
async fn tag_create_rejects_before_executing() {
    let Some(repo) = temp_repo_with_tag("v1.0") else {
        return;
    };
    let r: fn(&Error) -> bool = |e| e.is_core(Kind::RefName);
    let cases: [(TagCreateOpts, fn(&Error) -> bool); 4] = [
        (tc("bad name", "", "", ""), r),
        (tc("v2.lock", "", "", ""), r),
        (tc("a//b", "", "", ""), r),
        (tc("v1.0", "", "", ""), |e| e.is(WriteKind::TagExists)),
    ];
    for (o, ok) in cases {
        let f = WriteFake::default();
        let s = svc_rw(real_reader(), &f);
        let e = tag_create(&s, &bg(), repo.p(), &o).await.unwrap_err();
        assert!(ok(&e), "{o:?}: {e}");
        assert!(f.argvs().is_empty(), "{:?}", f.argvs());
    }
}

#[tokio::test]
async fn tag_create_real_git() {
    let Some(repo) = temp_repo() else { return };
    let s = Service::new();
    let ctx = bg();
    tag_create(&s, &ctx, repo.p(), &tc("v1.0", "", "", ""))
        .await
        .unwrap();
    tag_create(
        &s,
        &ctx,
        repo.p(),
        &tc("v2.0", "", TAG_ANNOTATED, "두 번째"),
    )
    .await
    .unwrap();
    for (name, want) in [("v1.0", "commit"), ("v2.0", "tag")] {
        let r = format!("{}{name}", query::TAG_REF_PREFIX);
        let o = s
            .exec(&ctx, repo.p(), &["cat-file", "-t", r.as_str()])
            .await
            .unwrap();
        assert_eq!(o.stdout_str().trim(), want, "{name}");
    }
    let e = tag_create(&s, &ctx, repo.p(), &tc("v1.0", "", "", ""))
        .await
        .unwrap_err();
    assert!(e.is(WriteKind::TagExists), "{e}");
}

#[tokio::test]
async fn tag_delete_destructive_with_recoverable_hint() {
    let Some(repo) = temp_repo_with_tag("v1.0") else {
        return;
    };
    let s = Service::new();
    let ctx = bg();
    let oid = query::tag_oid(&s, &ctx, repo.p(), "v1.0").await.unwrap();
    tag_delete(&s, &ctx, repo.p(), "v1.0").await.unwrap();

    let recs = s.records(0);
    let last = recs.last().unwrap();
    assert!(last.destructive, "{:?}", last.argv());
    let hints = s.hints(0);
    assert_eq!(hints.len(), 1);
    let h = &hints[0];
    assert_eq!(h.action, core::ACTION_TAG_DELETE);
    assert_eq!(h.values, Some(vec![oid.clone()]));
    assert!(h.command.contains(&oid), "{:?}", h.command);

    git_run(repo.dir(), &["tag", "v1.0", &oid]);
    assert_eq!(
        query::tag_oid(&s, &ctx, repo.p(), "v1.0").await.unwrap(),
        oid
    );
}

#[tokio::test]
async fn tag_delete_missing_tag_not_executed() {
    let Some(repo) = temp_repo() else { return };
    let f = WriteFake::default();
    let s = svc_rw(real_reader(), &f);
    let e = tag_delete(&s, &bg(), repo.p(), "nope").await.unwrap_err();
    assert!(e.is(WriteKind::TagNotFound), "{e}");
    assert!(f.argvs().is_empty());
    assert!(s.hints(0).is_empty());
}

#[tokio::test]
async fn tag_delete_remote_spec_hint_and_destructive() {
    let Some(repo) = temp_repo_with_tag("v1.0") else {
        return;
    };
    let s = Service::new();
    let ctx = bg();
    let oid = query::tag_oid(&s, &ctx, repo.p(), "v1.0").await.unwrap();
    let (spec, h) = tag_delete_remote_spec(&s, &ctx, repo.p(), &tr("origin", "v1.0", false))
        .await
        .unwrap();
    assert!(spec.destructive, "{:?}", spec.argv);
    assert!(s.hints(0).is_empty(), "사전 단계가 hint 를 남겼다");
    assert_eq!(h.action, core::ACTION_REMOTE_REF_DELETE);
    assert_eq!(h.command, format!("git push origin {oid}:refs/tags/v1.0"));

    let (_, g) = tag_delete_remote_spec(&s, &ctx, repo.p(), &tr("origin", "ghost", false))
        .await
        .unwrap();
    assert!(
        g.command.is_empty() && g.values.as_ref().is_none_or(Vec::is_empty),
        "{g:?}"
    );
}

#[test]
fn tag_push_spec_not_destructive() {
    let spec = tag_push_spec(&tr("origin", "v1.0", false)).unwrap();
    assert!(!spec.destructive, "{:?}", spec.argv);
    core::guard_write_args(&spec.argv).unwrap();
}

#[test]
fn tag_kinds_enumerated() {
    assert_eq!(TAG_KINDS, [TAG_LIGHTWEIGHT, TAG_ANNOTATED, TAG_SIGNED]);
}

#[tokio::test]
async fn tag_delete_remote_does_not_delete_same_named_branch() {
    let Some(repo) = temp_repo_with_remote() else {
        return;
    };
    let s = Service::new();
    let ctx = bg();
    let (spec, _) = tag_delete_remote_spec(&s, &ctx, repo.p(), &tr("origin", "feat", false))
        .await
        .unwrap();
    assert_eq!(spec.argv.last().unwrap(), "refs/tags/feat");
    let _ = s.exec_write(&ctx, repo.p(), &spec).await;
    let o = git_run(repo.dir(), &["ls-remote", "origin", "refs/heads/feat"]);
    assert!(
        o.contains("refs/heads/feat"),
        "원격 태그 삭제가 같은 이름의 원격 브랜치를 지웠다"
    );
}
