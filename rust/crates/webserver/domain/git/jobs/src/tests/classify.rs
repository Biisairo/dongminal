//! Go `classify_test.go`.

use dm_webserver_domain_git_core::{self as core, Kind};

use crate::{
    ERROR_SERVER_SHUTDOWN, ERROR_TIMEOUT, Job, REMOTE_REJECT_OPTIONS, classify_outcome,
    remote_reject_fixes,
};

fn job(kind: &str) -> Job {
    Job {
        kind: kind.to_owned(),
        ..Job::default()
    }
}

// FR-OPT-9-5 (DOM-32): finish 에서 떼어낸 결말 분류는 순수 함수다.
#[test]
fn classify_outcome_cases() {
    let timeout = core::Error::new(Kind::Timeout, "상한");
    let boom = core::Error::other("boom");
    let done = |kind: &str| Job {
        done: true,
        ..job(kind)
    };
    struct Case<'a> {
        name: &'a str,
        kind: &'a str,
        canceled: bool,
        shutdown: bool,
        run_err: Option<&'a core::Error>,
        exit: i32,
        tail: &'a str,
        want: Job,
    }
    let base = |name, kind, want| Case {
        name,
        kind,
        canceled: false,
        shutdown: false,
        run_err: None,
        exit: 0,
        tail: "",
        want,
    };
    let cases = vec![
        base("성공", "commit", done("commit")),
        Case {
            exit: 1,
            tail: "! [rejected]",
            ..base(
                "exit 만의 실패",
                "merge",
                Job {
                    exit_code: 1,
                    stderr_tail: "! [rejected]".into(),
                    err: "git merge 가 exit 1 로 끝났다".into(),
                    ..done("merge")
                },
            )
        },
        Case {
            canceled: true,
            shutdown: true,
            exit: 1,
            tail: "Authentication failed",
            ..base(
                "서버 종료는 취소가 아니다",
                "push",
                Job {
                    exit_code: 1,
                    stderr_tail: "Authentication failed".into(),
                    error_code: ERROR_SERVER_SHUTDOWN.into(),
                    err: "서버 종료로 중단했다 — 일부가 적용됐을 수 있다".into(),
                    ..done("push")
                },
            )
        },
        Case {
            canceled: true,
            ..base(
                "원격 취소",
                "fetch",
                Job {
                    canceled: true,
                    err: "취소했다. 원격에 일부가 적용됐을 수 있다".into(),
                    ..done("fetch")
                },
            )
        },
        Case {
            canceled: true,
            ..base(
                "로컬 취소",
                "commit",
                Job {
                    canceled: true,
                    err: "취소했다. 일부가 적용됐을 수 있다 — 상태를 확인하라".into(),
                    ..done("commit")
                },
            )
        },
        Case {
            run_err: Some(&timeout),
            ..base(
                "시한",
                "commit",
                Job {
                    error_code: ERROR_TIMEOUT.into(),
                    err: core::sanitize_remote(&timeout.to_string()),
                    ..done("commit")
                },
            )
        },
        Case {
            run_err: Some(&boom),
            ..base(
                "실행기 오류",
                "commit",
                Job {
                    err: "boom".into(),
                    ..done("commit")
                },
            )
        },
        Case {
            exit: 1,
            tail: "! [rejected] main -> main (non-fast-forward)",
            ..base(
                "원격 거부는 선택지를 싣는다",
                "push",
                Job {
                    exit_code: 1,
                    stderr_tail: "! [rejected] main -> main (non-fast-forward)".into(),
                    err: "git push 가 exit 1 로 끝났다".into(),
                    rejected: true,
                    options: Some(
                        REMOTE_REJECT_OPTIONS
                            .iter()
                            .map(|s| (*s).to_owned())
                            .collect(),
                    ),
                    fixes: Some(remote_reject_fixes()),
                    ..done("push")
                },
            )
        },
    ];
    for c in cases {
        let got = classify_outcome(
            job(c.kind),
            c.canceled,
            c.shutdown,
            c.run_err,
            c.exit,
            c.tail,
        );
        assert_eq!(format!("{got:?}"), format!("{:?}", c.want), "{}", c.name);
    }
}
