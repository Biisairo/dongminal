//! Go `remote_test.go`·`remote_actions_test.go`.

use std::sync::{Arc, Mutex};

use otter_webserver_domain_git_core::{self as core, Kind, Output, Service, WriteSpec};
use otter_webserver_domain_git_query::QueryKind;

use super::support::*;
use crate::*;

fn remote_repo() -> String {
    abs_work_repo()
}

/// Go `remoteFake`: status 와 config 만 답한다.
#[derive(Clone, Default)]
struct RemoteFake {
    branch: &'static str,
    upstream: &'static str,
    detached: bool,
    config: &'static str,
}

impl RemoteFake {
    fn status_out(&self) -> String {
        let head = if self.detached {
            "# branch.head (detached)".to_owned()
        } else {
            format!("# branch.head {}", self.branch)
        };
        let mut toks = vec![format!("# branch.oid {}", "a".repeat(40)), head];
        if !self.upstream.is_empty() {
            toks.push(format!("# branch.upstream {}", self.upstream));
            toks.push("# branch.ab +1 -0".to_owned());
        }
        toks.join("\0") + "\0"
    }
}

fn remote_svc(f: RemoteFake) -> Service {
    Service::builder()
        .runner(runner(move |args| match args[0].as_str() {
            "status" => out(&f.status_out(), "", 0),
            "config" => out(f.config, "", 0),
            _ => Output::default(),
        }))
        .write_runner(write_runner(|_, _| Output::default()))
        .build()
}

fn push(force: &str, confirm: bool, publish: bool, remote: &str, branch: &str) -> PushOpts {
    PushOpts {
        force: force.into(),
        confirm,
        publish,
        remote: remote.into(),
        branch: branch.into(),
    }
}

fn publish() -> PushOpts {
    push("", false, true, "", "")
}

#[tokio::test]
async fn push_spec_publish_sets_upstream() {
    let svc = remote_svc(RemoteFake {
        branch: "no-upstream",
        config: "remote.origin.url=/tmp/remote.git\ncore.bare=false\n",
        ..RemoteFake::default()
    });
    let (res, plan) = push_spec(&svc, &bg(), &remote_repo(), &publish()).await;
    let spec = res.unwrap();
    assert_eq!(
        spec.argv,
        sv(&["push", "--progress", "-u", "origin", "no-upstream"])
    );
    assert!(
        plan.publish && plan.remote == "origin" && plan.branch == "no-upstream",
        "{plan:?}"
    );
}

#[tokio::test]
async fn push_spec_publish_needs_acknowledgement() {
    let svc = remote_svc(RemoteFake {
        branch: "no-upstream",
        config: "remote.origin.url=/tmp/remote.git\n",
        ..RemoteFake::default()
    });
    let (res, plan) = push_spec(&svc, &bg(), &remote_repo(), &PushOpts::default()).await;
    assert!(res.unwrap_err().is(WriteKind::PublishRequired));
    assert!(
        plan.publish && plan.remote == "origin" && plan.branch == "no-upstream",
        "{plan:?}"
    );
}

#[tokio::test]
async fn push_spec_with_upstream_is_plain() {
    let svc = remote_svc(RemoteFake {
        branch: "main",
        upstream: "origin/main",
        ..RemoteFake::default()
    });
    let (res, plan) = push_spec(&svc, &bg(), &remote_repo(), &PushOpts::default()).await;
    let spec = res.unwrap();
    assert_eq!(spec.argv, sv(&["push", "--progress"]));
    assert!(!plan.publish && !spec.destructive, "{plan:?}");
}

#[tokio::test]
async fn push_spec_remote_selection() {
    let cases: [(&str, &'static str, Option<&str>); 6] = [
        ("하나", "remote.up.url=/tmp/a.git\n", Some("up")),
        (
            "여럿 + origin",
            "remote.fork.url=/a\nremote.origin.url=/b\n",
            Some("origin"),
        ),
        (
            "여럿 + origin 없음",
            "remote.a.url=/a\nremote.b.url=/b\n",
            None,
        ),
        ("없음", "core.bare=false\n", None),
        ("url 아닌 키만", "remote.origin.prune=true\n", None),
        ("점이 든 이름", "remote.my.fork.url=/a\n", Some("my.fork")),
    ];
    for (name, config, want) in cases {
        let svc = remote_svc(RemoteFake {
            branch: "b",
            config,
            ..RemoteFake::default()
        });
        let (res, plan) = push_spec(&svc, &bg(), &remote_repo(), &publish()).await;
        match want {
            None => {
                let e = res.unwrap_err();
                assert!(e.is_query(QueryKind::NoRemote), "{name}: {e}");
            }
            Some(w) => {
                res.unwrap();
                assert_eq!(plan.remote, w, "{name}");
            }
        }
    }
}

#[tokio::test]
async fn push_spec_detached_is_rejected() {
    let svc = remote_svc(RemoteFake {
        detached: true,
        config: "remote.origin.url=/a\n",
        ..RemoteFake::default()
    });
    let (res, _) = push_spec(&svc, &bg(), &remote_repo(), &publish()).await;
    assert!(res.unwrap_err().is(WriteKind::DetachedPush));
}

#[tokio::test]
async fn push_spec_force_defaults() {
    let svc = remote_svc(RemoteFake {
        branch: "main",
        upstream: "origin/main",
        ..RemoteFake::default()
    });
    let (ctx, r) = (bg(), remote_repo());

    let base = push_spec(&svc, &ctx, &r, &PushOpts::default())
        .await
        .0
        .unwrap();
    assert!(
        !format!("{:?}", base.argv).contains("force"),
        "{:?}",
        base.argv
    );

    let (res, plan) = push_spec(&svc, &ctx, &r, &push(PUSH_LEASE, false, false, "", "")).await;
    let lease = res.unwrap();
    assert_eq!(
        lease.argv,
        sv(&["push", "--progress", "--force-with-lease"])
    );
    assert!(lease.destructive && plan.force == PUSH_LEASE, "{plan:?}");

    let (res, _) = push_spec(&svc, &ctx, &r, &push(PUSH_FORCE, false, false, "", "")).await;
    assert!(res.unwrap_err().is(WriteKind::ForceConfirm));

    let (res, _) = push_spec(&svc, &ctx, &r, &push(PUSH_FORCE, true, false, "", "")).await;
    let forced = res.unwrap();
    assert_eq!(forced.argv, sv(&["push", "--progress", "--force"]));
    assert!(forced.destructive);

    let (res, _) = push_spec(&svc, &ctx, &r, &push("hard", false, false, "", "")).await;
    assert!(res.unwrap_err().is(WriteKind::PushForce));
}

#[test]
fn fetch_spec_cases() {
    let o = |prune, tags| FetchOpts { prune, tags };
    let cases = [
        (o(false, None), sv(&["fetch", "--progress"])),
        (o(true, None), sv(&["fetch", "--progress", "--prune"])),
        (o(false, Some(true)), sv(&["fetch", "--progress", "--tags"])),
        (
            o(false, Some(false)),
            sv(&["fetch", "--progress", "--no-tags"]),
        ),
        (
            o(true, Some(false)),
            sv(&["fetch", "--progress", "--prune", "--no-tags"]),
        ),
    ];
    for (opts, want) in cases {
        let got = fetch_spec(&opts);
        assert_eq!(got.argv, want);
        assert!(!got.destructive);
    }
}

#[test]
fn pull_spec_cases() {
    let cases = [
        (PULL_DEFAULT, Some(sv(&["pull", "--progress"]))),
        (PULL_REBASE, Some(sv(&["pull", "--progress", "--rebase"]))),
        (PULL_FF_ONLY, Some(sv(&["pull", "--progress", "--ff-only"]))),
        (PULL_NO_FF, Some(sv(&["pull", "--progress", "--no-ff"]))),
        ("--exec-path=/x", None),
        ("squash", None),
    ];
    for (mode, want) in cases {
        let got = pull_spec(&PullOpts { mode: mode.into() });
        match want {
            None => assert!(got.unwrap_err().is(WriteKind::PullMode), "{mode}"),
            Some(w) => assert_eq!(got.unwrap().argv, w, "{mode}"),
        }
    }
}

#[tokio::test]
async fn remote_specs_pass_write_guard() {
    let svc = remote_svc(RemoteFake {
        branch: "no-upstream",
        config: "remote.origin.url=/a\n",
        ..RemoteFake::default()
    });
    let (res, _) = push_spec(
        &svc,
        &bg(),
        &remote_repo(),
        &push(PUSH_LEASE, false, true, "", ""),
    )
    .await;
    let push = res.unwrap();
    let pull = pull_spec(&PullOpts {
        mode: PULL_REBASE.into(),
    })
    .unwrap();
    let fetch = fetch_spec(&FetchOpts {
        prune: true,
        tags: Some(true),
    });
    for spec in [fetch, pull, push] {
        core::guard_write_args(&spec.argv).unwrap_or_else(|e| panic!("{:?}: {e}", spec.argv));
    }
}

// ── remote_actions_test.go ──

#[test]
fn remote_add_args_ok() {
    let got = remote_add_args("upstream", "https://example.test/a.git").unwrap();
    assert_eq!(
        got,
        sv(&["remote", "add", "upstream", "https://example.test/a.git"])
    );
    core::guard_write_args(&got).unwrap();
}

#[test]
fn remote_remove_args_ok() {
    let got = remote_remove_args("origin").unwrap();
    assert_eq!(got, sv(&["remote", "remove", "origin"]));
    core::guard_write_args(&got).unwrap();
}

#[test]
fn remote_add_args_rejects() {
    let cases = [
        ("빈 이름", "", "/tmp/a.git", WriteKind::RemoteName),
        (
            "옵션처럼 생긴 이름",
            "-x",
            "/tmp/a.git",
            WriteKind::RemoteName,
        ),
        (
            "슬래시가 든 이름",
            "a/b",
            "/tmp/a.git",
            WriteKind::RemoteName,
        ),
        ("공백이 든 이름", "a b", "/tmp/a.git", WriteKind::RemoteName),
        (
            "NUL 이 든 이름",
            "a\0b",
            "/tmp/a.git",
            WriteKind::RemoteName,
        ),
        ("범위 표현", "a..b", "/tmp/a.git", WriteKind::RemoteName),
        ("빈 URL", "origin", "", WriteKind::RemoteUrl),
        (
            "옵션처럼 생긴 URL",
            "origin",
            "--upload-pack=evil",
            WriteKind::RemoteUrl,
        ),
        (
            "공백이 든 URL",
            "origin",
            "http://a b",
            WriteKind::RemoteUrl,
        ),
        (
            "NUL 이 든 URL",
            "origin",
            "http://a\0",
            WriteKind::RemoteUrl,
        ),
    ];
    for (name, remote, url, want) in cases {
        let e = remote_add_args(remote, url).unwrap_err();
        assert!(e.is(want), "{name}: {e}");
    }
}

#[test]
fn remote_remove_args_rejects() {
    for name in ["", "-x", "a/b", "a b"] {
        let e = remote_remove_args(name).unwrap_err();
        assert!(e.is(WriteKind::RemoteName), "{name:?}: {e}");
    }
}

/// Go `remoteHintSvc`: remote.<n>.url 을 답하는 서비스와 실행된 argv.
fn remote_hint_svc(config: &'static str) -> (Service, Arc<Mutex<Vec<Vec<String>>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let svc = Service::builder()
        .runner(runner(move |args| {
            if args[0] == "config" {
                return out(config, "", 0);
            }
            Output::default()
        }))
        .write_runner(write_runner(move |args, _| {
            s2.lock().unwrap().push(args.to_vec());
            Output::default()
        }))
        .build();
    (svc, seen)
}

#[tokio::test]
async fn remote_remove_leaves_recovery_hint() {
    let (svc, seen) = remote_hint_svc("remote.origin.url=/tmp/remote.git\n");
    remote_remove(&svc, &bg(), &abs_work_repo(), "origin")
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![sv(&["remote", "remove", "origin"])]
    );
    let hints = svc.hints(0);
    assert_eq!(hints.len(), 1, "{hints:?}");
    let h = &hints[0];
    assert!(
        h.command.contains("remote add origin") && h.command.contains("/tmp/remote.git"),
        "{:?}",
        h.command
    );
    assert_eq!(
        h.values
            .as_ref()
            .and_then(|v| v.first())
            .map(String::as_str),
        Some("/tmp/remote.git"),
        "{h:?}"
    );
    let recs = svc.records(0);
    assert!(recs.last().is_some_and(|r| !r.destructive), "{recs:?}");
}

#[tokio::test]
async fn remote_remove_hint_redacts_url() {
    let (svc, _) = remote_hint_svc("remote.origin.url=https://user:abc123@example.test/a.git\n");
    remote_remove(&svc, &bg(), &abs_work_repo(), "origin")
        .await
        .unwrap();
    let h = svc.hints(0);
    assert_eq!(h.len(), 1);
    assert!(
        !h[0].command.contains("abc123") && !format!("{:?}", h[0].values).contains("abc123"),
        "{:?}",
        h[0]
    );
}

#[tokio::test]
async fn remote_remove_missing_is_rejected() {
    let (svc, seen) = remote_hint_svc("remote.origin.url=/tmp/a.git\n");
    let e = remote_remove(&svc, &bg(), &abs_work_repo(), "nope")
        .await
        .unwrap_err();
    assert!(e.is(WriteKind::RemoteMissing), "{e}");
    assert!(seen.lock().unwrap().is_empty());
    assert!(svc.hints(0).is_empty());
}

#[tokio::test]
async fn remote_add_existing_is_rejected() {
    let (svc, seen) = remote_hint_svc("remote.origin.url=/tmp/a.git\n");
    let e = remote_add(&svc, &bg(), &abs_work_repo(), "origin", "/tmp/b.git")
        .await
        .unwrap_err();
    assert!(e.is(WriteKind::RemoteExists), "{e}");
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn push_spec_explicit_target() {
    let svc = remote_svc(RemoteFake {
        branch: "main",
        upstream: "origin/main",
        config: "remote.origin.url=/a\n",
        ..RemoteFake::default()
    });
    let cases = [
        (
            push("", false, false, "upstream", "feat"),
            sv(&["push", "--progress", "upstream", "feat"]),
        ),
        (
            push(PUSH_LEASE, false, false, "upstream", "feat"),
            sv(&[
                "push",
                "--progress",
                "--force-with-lease",
                "upstream",
                "feat",
            ]),
        ),
        (
            push("", false, true, "upstream", "feat"),
            sv(&["push", "--progress", "-u", "upstream", "feat"]),
        ),
    ];
    for (o, want) in cases {
        let (res, plan) = push_spec(&svc, &bg(), &remote_repo(), &o).await;
        let spec: WriteSpec = res.unwrap();
        assert_eq!(spec.argv, want);
        assert!(
            plan.remote == o.remote && plan.branch == o.branch,
            "{plan:?}"
        );
        core::guard_write_args(&spec.argv).unwrap();
    }
}

#[tokio::test]
async fn push_spec_explicit_target_rejects() {
    let svc = remote_svc(RemoteFake {
        branch: "main",
        upstream: "origin/main",
        config: "remote.origin.url=/a\n",
        ..RemoteFake::default()
    });
    for o in [
        push("", false, false, "-x", "feat"),
        push("", false, false, "origin", "-x"),
        push("", false, false, "origin", "a..b"),
        push("", false, false, "origin", ""),
        push("", false, false, "", "feat"),
    ] {
        let (res, _) = push_spec(&svc, &bg(), &remote_repo(), &o).await;
        assert!(res.is_err(), "{o:?}");
    }
}

#[test]
fn push_range_cases() {
    assert_eq!(push_range("origin/main", "main"), "origin/main..main");
    assert_eq!(push_range("", "main"), "main");
}

#[test]
fn remote_name_checked_on_every_path() {
    let bad = "a/b";
    let cases: [(&str, Box<dyn Fn() -> Error>); 5] = [
        (
            "remote add",
            Box::new(|| remote_add_args(bad, "/tmp/a.git").unwrap_err()),
        ),
        (
            "remote remove",
            Box::new(|| remote_remove_args(bad).unwrap_err()),
        ),
        (
            "fetch",
            Box::new(|| {
                remote_fetch_spec(&RemoteBranchOpts {
                    remote: bad.into(),
                    branch: "feat".into(),
                })
                .unwrap_err()
            }),
        ),
        (
            "tag push",
            Box::new(|| {
                tag_push_args(&TagRemoteOpts {
                    remote: bad.into(),
                    name: "v1".into(),
                    all: false,
                })
                .unwrap_err()
            }),
        ),
        (
            "tag delete remote",
            Box::new(|| {
                tag_delete_remote_args(&TagRemoteOpts {
                    remote: bad.into(),
                    name: "v1".into(),
                    all: false,
                })
                .unwrap_err()
            }),
        ),
    ];
    for (name, call) in cases {
        let e = call();
        assert!(e.is(WriteKind::RemoteName), "{name}: {e}");
        assert!(
            e.is_core(Kind::RefName),
            "{name}: core RefName 도 함께: {e}"
        );
    }
}

// DIFF-13: refspec 자리의 `+`·`:`·`-` 는 실행 전에 거절한다.
#[tokio::test]
async fn push_target_rejects_refspec_syntax() {
    let svc = Service::builder().build();
    let ctx = core::Ctx::background();
    for (remote, branch, want) in [
        (
            "origin",
            "+main",
            "push_target_invalid: ref_name_invalid: branch 는 + 로 시작할 수 없다: \"+main\"",
        ),
        (
            "origin",
            "main:other",
            "push_target_invalid: ref_name_invalid: branch 에 : 가 있다: \"main:other\"",
        ),
        (
            "origin",
            "-f",
            "push_target_invalid: ref_name_invalid: branch 는 - 로 시작할 수 없다: \"-f\"",
        ),
        (
            "+origin",
            "main",
            "push_target_invalid: ref_name_invalid: remote 는 + 로 시작할 수 없다: \"+origin\"",
        ),
    ] {
        let o = PushOpts {
            remote: remote.into(),
            branch: branch.into(),
            ..PushOpts::default()
        };
        let (res, _) = push_spec(&svc, &ctx, "/r", &o).await;
        let e = res.unwrap_err();
        assert!(e.is(WriteKind::PushTarget), "{e}");
        assert_eq!(e.to_string(), want);
    }
}

#[tokio::test]
async fn branch_push_and_remote_branch_reject_refspec_syntax() {
    let svc = Service::builder().build();
    let ctx = core::Ctx::background();
    let o = BranchPushOpts {
        branch: "+main".into(),
        ..BranchPushOpts::default()
    };
    let (res, _) = branch_push_spec(&svc, &ctx, "/r", &o).await;
    assert!(res.unwrap_err().is_core(Kind::RefName));
    for (remote, branch) in [("origin", "a:b"), ("origin", "+a")] {
        let o = RemoteBranchOpts {
            remote: remote.into(),
            branch: branch.into(),
        };
        assert!(remote_fetch_spec(&o).unwrap_err().is_core(Kind::RefName));
        let e = remote_branch_delete_spec(&svc, &ctx, "/r", &o)
            .await
            .unwrap_err();
        assert!(e.is_core(Kind::RefName), "{e}");
    }
}
