use super::support::*;
use crate::guard::{READ_COMMANDS, guard_args, is_read_command};
use crate::write::{WRITE_COMMANDS, is_write_verb};
use crate::{Kind, Service, guard_write_args, rel_path};

// 케이스 5 (V1, FR-GIT-7): 저장소를 변경하는 명령은 실행 경로 자체가 없다.
#[tokio::test]
async fn exec_rejects_write_commands() {
    let writes = [
        "commit",
        "push",
        "add",
        "reset",
        "checkout",
        "stash",
        "clean",
        "merge",
        "rebase",
        "pull",
        "fetch",
        "branch",
        "tag",
        "worktree",
        "restore",
        "switch",
        "cherry-pick",
        "revert",
        "apply",
        "rm",
        "mv",
        "init",
        "clone",
    ];
    for cmd in writes {
        let s = Service::builder()
            .runner(runner(move |_, _, _| panic!("{cmd} 가 실행됐다")))
            .build();
        let err = s
            .exec(&bg(), &abs_tmp_repo(), &[cmd, "-m", "x"])
            .await
            .unwrap_err();
        assert!(err.is(Kind::WriteCommand), "{cmd}: {err}");
    }
}

#[test]
fn read_commands_read_only() {
    for c in [
        "rev-parse",
        "status",
        "diff",
        "show",
        "log",
        "for-each-ref",
        "config",
    ] {
        assert!(is_read_command(c), "{c}");
    }
    for c in [
        "commit", "push", "add", "reset", "checkout", "stash", "clean", "branch",
    ] {
        assert!(!is_read_command(c), "{c}");
    }
    assert_eq!(READ_COMMANDS.len(), 16);
    assert_eq!(WRITE_COMMANDS.len(), 24);
}

// 케이스 6 (V1, FR-GIT-2).
#[test]
fn guard_args_rejects() {
    let cases: &[(&str, &[&str], Kind)] = &[
        ("빈 슬라이스", &[], Kind::UnsafeArgument),
        (
            "전역 옵션 -c",
            &["-c", "core.pager=x", "status"],
            Kind::UnsafeArgument,
        ),
        (
            "전역 옵션 --exec-path",
            &["--exec-path=/x", "status"],
            Kind::UnsafeArgument,
        ),
        (
            "전역 옵션 --upload-pack",
            &["--upload-pack=x", "status"],
            Kind::UnsafeArgument,
        ),
        (
            "뒤따르는 --exec-path",
            &["status", "--exec-path=/x"],
            Kind::UnsafeArgument,
        ),
        (
            "뒤따르는 --upload-pack",
            &["log", "--upload-pack=/bin/sh"],
            Kind::UnsafeArgument,
        ),
        (
            "뒤따르는 --receive-pack",
            &["log", "--receive-pack=/bin/sh"],
            Kind::UnsafeArgument,
        ),
        (
            "파일 쓰기 --output",
            &["diff", "--output=/etc/passwd"],
            Kind::UnsafeArgument,
        ),
        (
            "파일 쓰기 -o",
            &["diff", "-o/etc/passwd"],
            Kind::UnsafeArgument,
        ),
        (
            "NUL 포함",
            &["log", "--format=%H\0id"],
            Kind::UnsafeArgument,
        ),
        ("하위 명령에 NUL", &["status\0"], Kind::WriteCommand),
        ("쓰기 명령", &["commit"], Kind::WriteCommand),
        ("알 수 없는 명령", &["frobnicate"], Kind::WriteCommand),
    ];
    for (name, args, want) in cases {
        let err = guard_args(args).expect_err(name);
        assert!(err.is(*want), "{name}: {err}");
    }
}

#[test]
fn guard_args_allows() {
    let ok: &[&[&str]] = &[
        &["rev-parse", "--show-toplevel"],
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
        ],
        &["diff", "--numstat", "--", "a/b.txt"],
        &["log", "--format=%H%x00%an", "-n", "50"],
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        &["show", "HEAD:README.md"],
    ];
    for args in ok {
        guard_args(args).unwrap_or_else(|e| panic!("{args:?}: {e}"));
    }
}

// W10.
#[test]
fn guard_args_config_read_only() {
    let ok: &[&[&str]] = &[
        &["config", "--get", "user.name"],
        &["config", "--get-all", "remote.origin.url"],
        &["config", "--list"],
        &["config", "--null", "--list"],
        &["config", "--type=bool", "--get", "commit.gpgsign"],
    ];
    for args in ok {
        guard_args(args).unwrap_or_else(|e| panic!("{args:?}: {e}"));
    }
    let bad: &[&[&str]] = &[
        &["config", "user.name", "x"],
        &["config", "--unset", "user.name"],
        &["config", "--add", "remote.origin.url", "git@example.com"],
        &["config", "--global", "--get", "user.name"],
        &["config", "--file=/etc/passwd", "--list"],
        &["config", "--get", "user.name", "extra"],
        &["config", "--null", "user.name", "x"],
        &["config", "-z", "--list"],
    ];
    for args in bad {
        assert!(
            guard_args(args).unwrap_err().is(Kind::UnsafeArgument),
            "{args:?}"
        );
    }
}

#[test]
fn read_commands_blame() {
    assert!(is_read_command("blame"));
    assert!(!is_write_verb("blame"));
}

// FR-WTP-8: 경로 가드는 이 OS 의 구분자로 조각을 나눠 본다.
#[test]
fn rel_path_rejects_parent_ref_with_os_separator() {
    let sep = dm_gocompat::filepath::SEPARATOR;
    for p in [
        format!("src{sep}..{sep}x"),
        format!("..{sep}x"),
        format!("a{sep}b{sep}.."),
    ] {
        assert!(rel_path(&p, Kind::UnsafeArgument).is_err(), "{p}");
    }
}

#[test]
fn rel_path_keeps_ordinary_relative_paths() {
    for p in ["a.txt", "src/a.txt", "디렉터리/파일.txt", "a..b", "..."] {
        assert_eq!(rel_path(p, Kind::UnsafeArgument).unwrap(), p);
    }
}

#[test]
fn rel_path_kind_is_callers() {
    for p in ["", " ", "/abs", "a/../b", "a\0b", "./a", "a//b"] {
        assert!(
            rel_path(p, Kind::RefName).unwrap_err().is(Kind::RefName),
            "{p:?}"
        );
    }
}

// REPO_FIX 01 §7.7.
#[test]
fn guard_unsafe_prefix_only_in_option_position() {
    let allowed: &[&[&str]] = &[
        &["add", "--", "-old.txt"],
        &["checkout", "-q", "--", "-output.txt"],
        &["commit", "-m", "-oops message"],
        &["commit", "--message", "-o"],
        &["tag", "-a", "v1", "-m", "-o fix"],
        &["tag", "-a", "v1", "--message=-o fix"],
        &["commit", "-F", "-"],
    ];
    for a in allowed {
        guard_write_args(a).unwrap_or_else(|e| panic!("{a:?}: {e}"));
    }
    let denied: &[&[&str]] = &[
        &["add", "-o", "x"],
        &["commit", "--output=/tmp/x"],
        &["branch", "-m", "-oops"],
        &["add", "--", "ok", "a\0b"],
    ];
    for a in denied {
        assert!(guard_write_args(a).is_err(), "{a:?}");
    }
}

// B8 (FR-GIT-7).
#[test]
fn guard_args_check_ref_format() {
    let cases: &[(&[&str], bool)] = &[
        (&["check-ref-format", "--branch", "feat"], true),
        (&["check-ref-format", "--normalize", "refs/tags/v1"], true),
        (&["check-ref-format", "feat"], false),
        (&["check-ref-format", "--branch"], false),
        (&["check-ref-format", "--branch", "a", "b"], false),
        (
            &["check-ref-format", "--allow-onelevel", "--branch", "a"],
            false,
        ),
    ];
    for (args, ok) in cases {
        let r = guard_args(args);
        if *ok {
            assert!(r.is_ok(), "{args:?}");
        } else {
            assert!(r.unwrap_err().is(Kind::UnsafeArgument), "{args:?}");
        }
    }
}

// V196 (FR-GIT-269).
#[test]
fn guard_write_args_remote_limited_to_add_and_remove() {
    let ok: &[&[&str]] = &[
        &["remote", "add", "origin", "/tmp/remote.git"],
        &["remote", "remove", "origin"],
    ];
    for a in ok {
        guard_write_args(a).unwrap_or_else(|e| panic!("{a:?}: {e}"));
    }
    let bad: &[&[&str]] = &[
        &["remote"],
        &["remote", "set-url", "origin", "/tmp/x.git"],
        &["remote", "prune", "origin"],
        &["remote", "update"],
        &["remote", "add", "origin"],
        &["remote", "add", "origin", "/tmp/x.git", "extra"],
        &["remote", "remove"],
        &["remote", "remove", "origin", "x"],
        &["remote", "add", "-x", "/tmp/x.git"],
        &["remote", "add", "origin", "--upload-pack=evil"],
    ];
    for a in bad {
        assert!(guard_write_args(a).is_err(), "{a:?}");
    }
    assert!(guard_args(&["remote", "add", "origin", "/tmp/x.git"]).is_err());
    assert!(!is_read_command("remote"));
}

// FR-GDT-20 · FR-RTU-29: 출구 전용 동사와 인자 없는 init.
#[test]
fn guard_write_args_op_only_and_init() {
    let ok: &[&[&str]] = &[
        &["am", "--continue"],
        &["am", "--skip"],
        &["am", "--abort"],
        &["bisect", "reset"],
        &["init"],
    ];
    for a in ok {
        guard_write_args(a).unwrap_or_else(|e| panic!("{a:?}: {e}"));
    }
    let bad: &[&[&str]] = &[
        &["am"],
        &["am", "x.mbox"],
        &["am", "--continue", "x"],
        &["bisect", "start"],
        &["init", "--bare"],
        &["init", "x"],
    ];
    for a in bad {
        assert!(
            guard_write_args(a).unwrap_err().is(Kind::UnsafeArgument),
            "{a:?}"
        );
    }
}

#[test]
fn check_ref_arg_rejects() {
    use crate::check_ref_arg;
    assert!(check_ref_arg("branch", "feat/x").is_ok());
    for v in ["", " ", "-x", "a\0b", "a..b"] {
        assert!(
            check_ref_arg("branch", v).unwrap_err().is(Kind::RefName),
            "{v:?}"
        );
    }
}
