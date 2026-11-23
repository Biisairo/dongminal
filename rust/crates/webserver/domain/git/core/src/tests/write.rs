use std::sync::{Arc, Mutex};

use super::support::*;
use crate::guard::READ_COMMANDS;
use crate::write::WRITE_COMMANDS;
use crate::{DEFAULT_STDERR_TAIL_LINES, Kind, Output, Service, WriteSpec, is_write_command};

fn spec(argv: &[&str]) -> WriteSpec {
    WriteSpec {
        argv: argv.iter().map(|s| s.to_string()).collect(),
        ..WriteSpec::default()
    }
}

// W1 (V39, FR-GIT-95): 두 진입점은 서로의 목록을 실행하지 못한다.
#[tokio::test]
async fn exec_and_exec_write_reject_each_others_commands() {
    for cmd in WRITE_COMMANDS {
        let s = Service::builder()
            .runner(runner(move |_, _, _| panic!("{cmd}")))
            .build();
        assert!(
            s.exec(&bg(), &abs_tmp_repo(), &[*cmd])
                .await
                .unwrap_err()
                .is(Kind::WriteCommand)
        );
    }
    for cmd in READ_COMMANDS {
        let s = Service::builder()
            .write_runner(write_runner(move |_, _, _, _| panic!("{cmd}")))
            .build();
        let err = s
            .exec_write(&bg(), &abs_tmp_repo(), &spec(&[cmd]))
            .await
            .unwrap_err();
        assert!(err.is(Kind::WriteCommand), "{cmd}");
    }
}

#[tokio::test]
async fn exec_write_shares_guard_checks() {
    let cases: &[(&str, &[&str], Kind)] = &[
        ("", &[], Kind::UnsafeArgument),
        ("repo", &["add", "."], Kind::UnsafeArgument),
        ("", &["-c", "core.pager=x", "commit"], Kind::UnsafeArgument),
        ("", &["add", "a\0b"], Kind::UnsafeArgument),
        (
            "",
            &["push", "--receive-pack=/bin/sh"],
            Kind::UnsafeArgument,
        ),
        (
            "",
            &["commit", "--output=/etc/passwd"],
            Kind::UnsafeArgument,
        ),
        ("", &["frobnicate"], Kind::WriteCommand),
    ];
    for (dir, argv, want) in cases {
        let dir = if dir.is_empty() {
            abs_tmp_repo()
        } else {
            dir.to_string()
        };
        let s = Service::builder()
            .write_runner(write_runner(|_, _, a, _| panic!("{a:?}")))
            .build();
        assert!(
            s.exec_write(&bg(), &dir, &spec(argv))
                .await
                .unwrap_err()
                .is(*want),
            "{argv:?}"
        );
    }
}

// W2 · V158: 교집합이 비어 있고 worktree 는 어느 목록에도 없다.
#[test]
fn read_and_write_commands_disjoint() {
    for c in WRITE_COMMANDS {
        assert!(!READ_COMMANDS.contains(c), "{c}");
    }
    assert!(WRITE_COMMANDS.len() >= 10);
    assert!(!READ_COMMANDS.contains(&"worktree") && !WRITE_COMMANDS.contains(&"worktree"));
}

// W4 (I5): 파괴적 선언이 기록에 남는다. 거부도 마찬가지다.
#[tokio::test]
async fn exec_write_records_destructive_declaration() {
    let s = Service::builder()
        .write_runner(write_runner(|_, _, _, _| Ok(Output::default())))
        .build();
    let mut clean = spec(&["clean", "-fd"]);
    clean.destructive = true;
    s.exec_write(&bg(), &abs_tmp_repo(), &clean).await.unwrap();
    s.exec_write(&bg(), &abs_tmp_repo(), &spec(&["add", "."]))
        .await
        .unwrap();
    let mut status = spec(&["status"]);
    status.destructive = true;
    assert!(s.exec_write(&bg(), &abs_tmp_repo(), &status).await.is_err());
    let r = s.records(0);
    assert_eq!(r.len(), 3);
    assert!(r[0].destructive && r[0].exit_code == 0);
    assert!(!r[1].destructive);
    assert!(r[2].destructive && r[2].exit_code == -1 && !r[2].err.is_empty());
}

// W5 (FR-GIT-77, I6): stdin 은 실행기에 가고 기록에는 바이트 수만 남는다.
#[tokio::test]
async fn exec_write_stdin_not_recorded() {
    let msg = "제목\n\n본문 secret-token\n";
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let s = Service::builder()
        .write_runner(write_runner(move |_, _, _, stdin| {
            s2.lock().unwrap().push(stdin);
            Ok(Output::default())
        }))
        .build();
    let mut sp = spec(&["commit", "--file=-", "--cleanup=strip"]);
    sp.stdin = msg.into();
    s.exec_write(&bg(), &abs_tmp_repo(), &sp).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), [msg]);
    let rec = &s.records(0)[0];
    assert_eq!(rec.stdin_bytes, msg.len());
    let blob = format!("{:?}{}{}", rec.argv, rec.stderr, rec.err);
    assert!(!blob.contains("secret-token"));
}

#[tokio::test]
async fn exec_write_stdin_reaches_git_process() {
    if git_path().is_none() {
        return;
    }
    let repo = git_repo();
    let s = Service::new();
    let msg = "stdin 으로 온 제목\n\n본문\n";
    let mut sp = spec(&["commit", "--allow-empty", "--file=-", "--cleanup=strip"]);
    sp.stdin = msg.into();
    s.exec_write(&bg(), &repo.path, &sp).await.unwrap();
    let o = s
        .exec(&bg(), &repo.path, &["log", "-1", "--format=%B"])
        .await
        .unwrap();
    assert_eq!(o.stdout_str().trim(), msg.trim());
    assert_eq!(s.records(0)[0].stdin_bytes, msg.len());
}

// W6 (FR-GIT-96).
#[test]
fn output_stderr_tail() {
    let lines: Vec<String> = (0..300).map(|i| format!("line {i}")).collect();
    let o = out("", &(lines.join("\n") + "\n"), 0);
    let tail = o.stderr_tail(DEFAULT_STDERR_TAIL_LINES);
    let got: Vec<&str> = tail.split('\n').collect();
    assert_eq!(got.len(), DEFAULT_STDERR_TAIL_LINES);
    assert_eq!((got[0], got[got.len() - 1]), ("line 100", "line 299"));
    assert_eq!(o.stderr_tail(0), tail);
    assert_eq!(out("", "fatal: 하나\n", 0).stderr_tail(200), "fatal: 하나");
    assert_eq!(Output::default().stderr_tail(200), "");
}

// TC-GRF-1.
#[test]
fn is_write_command_verb_and_subcommand() {
    let cases: &[(&[&str], bool)] = &[
        (&["stash", "list", "--format=%gd"], false),
        (
            &["stash", "show", "--name-status", "-z", "stash@{0}"],
            false,
        ),
        (&["branch", "--list"], false),
        (&["branch", "-l"], false),
        (&["branch", "--show-current"], false),
        (&["branch"], false),
        (&["tag", "-l"], false),
        (&["tag"], false),
        (&["remote", "-v"], false),
        (&["remote", "show", "origin"], false),
        (&["remote"], false),
        (&["stash", "push", "-u"], true),
        (&["stash", "drop", "stash@{0}"], true),
        (&["stash"], true),
        (&["branch", "-d", "feat"], true),
        (&["branch", "feat"], true),
        (&["tag", "v1"], true),
        (&["remote", "add", "origin", "url"], true),
        (&["add", "-A"], true),
        (&["commit"], true),
        (&["status"], false),
        (&["worktree", "list"], false),
        (&[], false),
    ];
    for (argv, want) in cases {
        assert_eq!(is_write_command(argv), *want, "{argv:?}");
    }
}

// TC-GRF-2: 실행 게이트는 argv[0] 그대로다.
#[tokio::test]
async fn read_only_subcommand_still_gated_as_write() {
    let s = Service::builder()
        .runner(runner(|_, _, _| Ok(Output::default())))
        .build();
    let dir = temp_dir();
    assert!(s.exec(&bg(), &dir.path, &["stash", "list"]).await.is_err());
}
