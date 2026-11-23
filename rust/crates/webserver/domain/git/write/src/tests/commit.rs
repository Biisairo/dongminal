//! Go `commit_msg_test.go`·`commit_ops_test.go`·`commit_test.go`.

use dm_webserver_domain_git_core::{self as core, Service};
use dm_webserver_domain_git_query as query;

use super::support::*;
use crate::*;

// ── commit_msg_test.go ──

#[test]
fn normalize_commit_message_cases() {
    let cases = [
        ("줄 끝 공백", "#", "fix  \nbody\t", "fix\nbody", true),
        ("앞뒤 빈 줄", "#", "\n\nfix\n\n", "fix", true),
        ("연속 빈 줄", "#", "fix\n\n\n\nbody", "fix\n\nbody", true),
        ("주석 줄 제거", "#", "fix\n# 주석", "fix", true),
        (
            "다른 접두",
            ";",
            "fix\n; 주석\n# 남는다",
            "fix\n# 남는다",
            true,
        ),
        ("auto 는 지우지 않음", "", "fix\n#12", "fix\n#13", false),
        ("내용이 다름", "#", "fix a", "fix b", false),
    ];
    for (name, prefix, a, b, same) in cases {
        let (na, nb) = (
            normalize_commit_message(a, prefix),
            normalize_commit_message(b, prefix),
        );
        assert_eq!(na == nb, same, "{name}: {na:?} / {nb:?}");
    }
}

// ── commit_ops_test.go ──

fn pick(oid: &str, merge: bool, mainline: i64, no_commit: bool) -> PickOpts {
    PickOpts {
        oid: oid.into(),
        merge,
        mainline,
        no_commit,
    }
}

#[test]
fn pick_args_merge_needs_mainline() {
    for verb in [PICK_CHERRY, PICK_REVERT] {
        let e = pick_args(verb, &pick("abc123", true, 0, false)).unwrap_err();
        assert!(e.is(WriteKind::MergeParent), "{verb}: {e}");
    }
}

#[test]
fn pick_args_mainline_only_for_merge() {
    for verb in [PICK_CHERRY, PICK_REVERT] {
        assert!(
            pick_args(verb, &pick("abc123", false, 1, false)).is_err(),
            "{verb}: 머지가 아닌데 -m 이 붙었다"
        );
    }
}

#[test]
fn pick_args_shapes() {
    let cases = [
        (
            PICK_CHERRY,
            pick("abc123", false, 0, false),
            "cherry-pick abc123",
        ),
        (
            PICK_CHERRY,
            pick("abc123", true, 2, false),
            "cherry-pick -m 2 abc123",
        ),
        (
            PICK_REVERT,
            pick("abc123", false, 0, false),
            "revert abc123",
        ),
        (
            PICK_REVERT,
            pick("abc123", true, 1, false),
            "revert -m 1 abc123",
        ),
        (
            PICK_REVERT,
            pick("abc123", false, 0, true),
            "revert --no-commit abc123",
        ),
    ];
    for (verb, o, want) in cases {
        assert_eq!(pick_args(verb, &o).unwrap().join(" "), want);
    }
}

#[test]
fn pick_args_rejects() {
    let cases = [
        ("모르는 동사", "rebase", pick("abc123", false, 0, false)),
        ("빈 oid", PICK_CHERRY, PickOpts::default()),
        (
            "- 로 시작하는 oid",
            PICK_CHERRY,
            pick("--hard", false, 0, false),
        ),
        ("범위 표현", PICK_REVERT, pick("a..b", false, 0, false)),
        (
            "부모 번호가 0 이하",
            PICK_CHERRY,
            pick("abc123", true, 0, false),
        ),
        (
            "부모 번호가 음수",
            PICK_CHERRY,
            pick("abc123", true, -1, false),
        ),
        (
            "cherry-pick 의 --no-commit",
            PICK_CHERRY,
            pick("abc123", false, 0, true),
        ),
    ];
    for (name, verb, o) in cases {
        assert!(pick_args(verb, &o).is_err(), "{name} 가 거부되지 않았다");
    }
}

fn ro(oid: &str, mode: &str) -> ResetOpts {
    ResetOpts {
        oid: oid.into(),
        mode: mode.into(),
    }
}

#[test]
fn reset_args_modes() {
    assert_eq!(RESET_MODES[0], RESET_MIXED);
    let cases = [
        (RESET_SOFT, "reset --soft abc123"),
        (RESET_MIXED, "reset --mixed abc123"),
        (RESET_HARD, "reset --hard abc123"),
        ("", "reset --mixed abc123"),
    ];
    for (mode, want) in cases {
        assert_eq!(reset_args(&ro("abc123", mode)).unwrap().join(" "), want);
    }
    let e = reset_args(&ro("abc123", "keep")).unwrap_err();
    assert!(e.is(WriteKind::ResetMode), "{e}");
    assert!(reset_args(&ro("--hard", "")).is_err());
}

#[tokio::test]
async fn reset_destructive_only_hard() {
    for (mode, want) in [
        (RESET_SOFT, false),
        (RESET_MIXED, false),
        (RESET_HARD, true),
    ] {
        let f = WriteFake::default();
        let s = svc_w(&f);
        reset(&s, &bg(), &abs_tmp_repo(), &ro("abc123", mode), "head0")
            .await
            .unwrap();
        assert_eq!(s.records(0).last().unwrap().destructive, want, "{mode}");
    }
}

#[tokio::test]
async fn reset_hint_carries_original_head() {
    let f = WriteFake::default();
    let s = svc_w(&f);
    reset(
        &s,
        &bg(),
        &abs_tmp_repo(),
        &ro("abc123", RESET_HARD),
        "deadbeef",
    )
    .await
    .unwrap();
    let hints = s.hints(0);
    assert_eq!(hints.len(), 1);
    assert_eq!(hints[0].action, core::ACTION_RESET_HARD);
    assert_eq!(hints[0].command, "git reset --hard deadbeef");

    let f2 = WriteFake::default();
    let s2 = svc_w(&f2);
    reset(
        &s2,
        &bg(),
        &abs_tmp_repo(),
        &ro("abc123", RESET_MIXED),
        "deadbeef",
    )
    .await
    .unwrap();
    assert!(s2.hints(0).is_empty());
}

#[test]
fn drop_args_cases() {
    assert_eq!(
        drop_args("abc123").unwrap(),
        sv(&["rebase", "--onto", "abc123^", "abc123"])
    );
    for bad in ["", "--onto", "a..b"] {
        assert!(drop_args(bad).is_err(), "{bad:?} 가 거부되지 않았다");
    }
}

#[test]
fn drop_spec_destructive_with_hint() {
    let (spec, hint) = drop_spec(&abs_tmp_repo(), "abc123", "deadbeef").unwrap();
    assert!(spec.destructive);
    assert_eq!(hint.action, core::ACTION_COMMIT_DROP);
    assert_eq!(hint.command, "git reset --hard deadbeef");
}

// ── commit_test.go ──

const COMMIT_FIXTURE_MESSAGE: &str = "제목 줄\n\n본문 첫 줄\n본문 둘째 줄";

fn msg(m: &str) -> CommitOpts {
    CommitOpts {
        message: m.into(),
        ..CommitOpts::default()
    }
}

#[test]
fn commit_spec_message_via_stdin_only() {
    let spec = commit_spec(&msg(COMMIT_FIXTURE_MESSAGE));
    assert_eq!(spec.argv, sv(&["commit", "--file=-", "--cleanup=strip"]));
    for a in &spec.argv {
        assert!(
            !a.contains("제목 줄") && !a.contains("본문"),
            "{:?}",
            spec.argv
        );
    }
    assert_eq!(spec.stdin, COMMIT_FIXTURE_MESSAGE);
}

#[tokio::test]
async fn commit_record_keeps_only_stdin_bytes() {
    let f = WriteFake::default();
    let s = svc_w(&f);
    s.exec_write(
        &bg(),
        &abs_tmp_repo(),
        &commit_spec(&msg(COMMIT_FIXTURE_MESSAGE)),
    )
    .await
    .unwrap();
    let recs = s.records(0);
    assert_eq!(recs.len(), 1);
    let rec = &recs[0];
    assert_eq!(rec.stdin_bytes, COMMIT_FIXTURE_MESSAGE.len());
    assert!(!format!("{rec:?}").contains("제목 줄"), "{rec:?}");
    assert!(!rec.destructive);
}

#[test]
fn commit_opts_flags() {
    let base = ["commit", "--file=-", "--cleanup=strip"];
    let with = |extra: &[&str]| {
        let mut v = sv(&base);
        v.extend(sv(extra));
        v
    };
    let o = |amend, sign_off, no_verify, all| CommitOpts {
        message: "m".into(),
        amend,
        sign_off,
        no_verify,
        all,
    };
    let cases = [
        (o(false, false, false, false), with(&[])),
        (o(true, false, false, false), with(&["--amend"])),
        (o(false, true, false, false), with(&["--signoff"])),
        (o(false, false, true, false), with(&["--no-verify"])),
        (o(false, false, false, true), with(&["-a"])),
        (
            o(true, true, true, true),
            with(&["--amend", "--signoff", "--no-verify", "-a"]),
        ),
    ];
    for (opts, want) in cases {
        let argv = commit_spec(&opts).argv;
        assert_eq!(argv, want);
        assert!(!argv.iter().any(|a| a == "--no-edit"), "{argv:?}");
    }
}

#[tokio::test]
async fn undo_last_soft_reset_only() {
    let f = WriteFake::default();
    let s = svc_w(&f);
    undo_last(&s, &bg(), &abs_tmp_repo()).await.unwrap();
    let argvs = f.argvs();
    assert_eq!(argvs[0], sv(&["reset", "--soft", "HEAD@{1}"]));
    assert!(!argvs[0].iter().any(|a| a == "--hard" || a == "--mixed"));
    let recs = s.records(0);
    assert!(recs.len() == 1 && !recs[0].destructive, "{recs:?}");
}

#[tokio::test]
async fn undo_last_real_git_keeps_index() {
    let Some(repo) = temp_repo() else { return };
    let s = Service::new();
    let ctx = bg();
    git_run(repo.dir(), &["commit", "--allow-empty", "-m", "second"]);
    let before = query::status_of(&s, &ctx, repo.p()).await.unwrap();
    undo_last(&s, &ctx, repo.p()).await.unwrap();
    let after = query::status_of(&s, &ctx, repo.p()).await.unwrap();
    assert_ne!(after.oid, before.oid, "HEAD 가 그대로다");
    assert!(
        after.staged.is_empty() && after.changes.is_empty(),
        "{after:?}"
    );
}

#[tokio::test]
async fn commit_real_git_round_trip() {
    let Some(repo) = temp_repo_no_commit() else {
        return;
    };
    let s = Service::new();
    let ctx = bg();
    s.exec_write(&ctx, repo.p(), &commit_spec(&msg(COMMIT_FIXTURE_MESSAGE)))
        .await
        .unwrap();
    let got = query::last_commit_message(&s, &ctx, repo.p())
        .await
        .unwrap();
    assert_eq!(got, COMMIT_FIXTURE_MESSAGE);
    let st = query::status_of(&s, &ctx, repo.p()).await.unwrap();
    assert!(!st.initial && st.staged.is_empty(), "{st:?}");
}
