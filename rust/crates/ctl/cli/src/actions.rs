//! 액션 표와 분기 (FR-CLI-1..7). 행 하나가 액션 하나이며 `help`·`usage`·`dispatch` 가 모두 이
//! 표에서 나온다.

use std::io::Write;

use crate::backup::{parse_backup, parse_restore};
use crate::config::{parse_config, run_config_in};
use crate::env::Env;
use crate::help::{help, unknown_action, usage};
use crate::help::{
    usage_backup, usage_config, usage_doctor, usage_health, usage_migrate, usage_restore,
    usage_rollback, usage_service, usage_start, usage_stop, usage_uninstall, usage_update,
    usage_verify, usage_window,
};
use crate::open::open_frameless;
use crate::options::{
    ParseError, parse_doctor, parse_health, parse_migrate, parse_start, parse_stop, parse_verify,
    parse_window,
};
use crate::proc::Procs;
use crate::rollback::parse_rollback;
use crate::service::parse_service;
use crate::staleness::DAEMON_BUILD;
use crate::uninstall::parse_uninstall;
use crate::update::parse_update;
use crate::version::{parse_version, run_version, usage_version};
use crate::window::run_window_in;
use crate::{
    backup, doctor, health, migrate, rollback, service, start, stop, uninstall, update, verify,
};

/// `start --foreground` 가 이 프로세스로 띄울 서버다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServeTarget<'a> {
    pub home: &'a str,
    pub host: &'a str,
    pub port: &'a str,
    /// 도구 셸이 자기 홈으로 쓸 자리다. 격리 기동에서만 차고, 비면 사용자 홈이다. Go 는 이것을
    /// `OTTERMINAL_TOOL_HOME` 으로 프로세스 환경에 심었다 — Rust 는 환경을 바꾸지 않고 넘긴다.
    pub tool_home: &'a str,
}

/// 서버를 이 프로세스로 실행하는 콜백이다. cmd/otterminal 이 준다.
pub type Serve<'a> = dyn Fn(&ServeTarget<'_>) -> i32 + 'a;

type RunFn = fn(&[String], &Env<'_>, &Serve<'_>, &mut dyn Write, &mut dyn Write) -> i32;

pub(crate) struct Action {
    /// argv[1] 이다.
    pub name: &'static str,
    /// `help()` 의 액션 목록 한 줄이다.
    pub brief: &'static str,
    /// `<action> --help` 의 전문이다.
    pub usage: fn() -> String,
    /// 파싱과 실행을 함께 감싼다.
    run: RunFn,
}

pub(crate) fn actions() -> Vec<Action> {
    vec![
        Action {
            name: "start",
            brief: "서버를 띄운다 (필요하면 otterminald 도 함께)",
            usage: usage_start,
            run: |rest, env, serve, out, err| {
                drive("start", parse_start(rest), out, err, |o, out, err| {
                    start::run_start_in(&o, env, &Procs::platform(), serve, out, err)
                })
            },
        },
        Action {
            name: "stop",
            brief: "서버를 정지한다",
            usage: usage_stop,
            run: |rest, env, _, out, err| {
                drive("stop", parse_stop(rest), out, err, |o, out, err| {
                    stop::run_stop_in(&o, env, &Procs::platform(), out, err)
                })
            },
        },
        Action {
            name: "migrate",
            brief: "워크스페이스 데이터를 최신 스키마로 변환한다 (1회성)",
            usage: usage_migrate,
            run: |rest, env, _, out, err| {
                drive("migrate", parse_migrate(rest), out, err, |o, out, err| {
                    migrate::run_migrate_in(&o, env, out, err)
                })
            },
        },
        Action {
            name: "rollback",
            brief: "workspace.json 을 백업 세대로 되돌린다 (G3-2)",
            usage: usage_rollback,
            run: |rest, env, _, out, err| {
                drive("rollback", parse_rollback(rest), out, err, |o, out, err| {
                    rollback::run_rollback_in(&o, env, out, err)
                })
            },
        },
        Action {
            name: "window",
            brief: "돌고 있는 서버에 frameless window 를 연다 (서버를 띄우지 않는다)",
            usage: usage_window,
            run: |rest, env, _, out, err| {
                drive("window", parse_window(rest), out, err, |o, out, err| {
                    run_window_in(&o, env, &open_frameless, out, err)
                })
            },
        },
        Action {
            name: "backup",
            brief: "홈 전체를 zip 하나로 담는다 (G4-3)",
            usage: usage_backup,
            run: |rest, env, _, out, err| {
                drive("backup", parse_backup(rest), out, err, |o, out, err| {
                    backup::run_backup_in(&o, env, out, err)
                })
            },
        },
        Action {
            name: "restore",
            brief: "backup 으로 담은 zip 을 홈에 되돌린다 (G4-3)",
            usage: usage_restore,
            run: |rest, env, _, out, err| {
                drive("restore", parse_restore(rest), out, err, |o, out, err| {
                    backup::run_restore_in(&o, env, out, err)
                })
            },
        },
        Action {
            name: "uninstall",
            brief: "무엇을 지울지 보이고, --yes 가 있을 때만 지운다 (G3-4)",
            usage: usage_uninstall,
            run: |rest, env, _, out, err| {
                drive(
                    "uninstall",
                    parse_uninstall(rest),
                    out,
                    err,
                    |o, out, err| uninstall::run_uninstall_in(&o, env, out, err),
                )
            },
        },
        Action {
            name: "service",
            brief: "이 OS 의 감독자(launchd·systemd)에 넣을 정의를 만든다 (SEC-23)",
            usage: usage_service,
            run: |rest, env, _, out, err| {
                drive("service", parse_service(rest), out, err, |o, out, err| {
                    service::run_service_in(&o, env, out, err)
                })
            },
        },
        Action {
            name: "update",
            brief: "최신 판이 있는지 확인한다 (--check 를 줄 때만 나간다, G3-3)",
            usage: usage_update,
            run: |rest, _, _, out, err| {
                drive("update", parse_update(rest), out, err, |o, out, err| {
                    update::run_update(&o, out, err)
                })
            },
        },
        Action {
            name: "config",
            brief: "설정의 실효값과 출처를 보이고, 설정 파일을 대조한다 (G5-1)",
            usage: usage_config,
            run: |rest, env, _, out, err| {
                drive("config", parse_config(rest), out, err, |o, out, err| {
                    run_config_in(&o, env, out, err)
                })
            },
        },
        Action {
            name: "health",
            brief: "서버와 otterminald 의 상태를 확인한다",
            usage: usage_health,
            run: |rest, env, _, out, err| {
                drive("health", parse_health(rest), out, err, |o, out, err| {
                    health::run_health_in(
                        &o,
                        env,
                        otter_shared_platform::current().process,
                        DAEMON_BUILD,
                        out,
                        err,
                    )
                })
            },
        },
        Action {
            name: "doctor",
            brief: "이 호스트에서 플랫폼 계층이 동작하는지 확인한다",
            usage: usage_doctor,
            run: |rest, env, _, out, err| {
                drive("doctor", parse_doctor(rest), out, err, |o, out, err| {
                    doctor::run_doctor_in(&o, env, out, err)
                })
            },
        },
        Action {
            name: "verify",
            brief: "격리 인스턴스를 띄워 종단간 표면을 훑는다 (개발·CI)",
            usage: usage_verify,
            run: |rest, env, _, out, err| {
                drive("verify", parse_verify(rest), out, err, |o, out, err| {
                    verify::run_verify_in(&o, env, out, err)
                })
            },
        },
        Action {
            name: "otp",
            brief: "OTP 도우미 — 채팅 강제 삭제·강퇴를 사람만 하게 한다 (설치는 sudo, macOS)",
            usage: || otter_ctl_privhelper::USAGE.to_owned(),
            run: |rest, _, _, out, err| otter_ctl_privhelper::main(rest, out, err),
        },
        // `--version` 별칭은 dispatch 가 처리한다.
        Action {
            name: "version",
            brief: "판·대상·go 런타임을 찍는다 (--version 도 동일)",
            usage: usage_version,
            run: |rest, _, _, out, err| {
                drive("version", parse_version(rest), out, err, |(), out, _| {
                    run_version(out)
                })
            },
        },
    ]
}

/// 목록에 보이지 않는 옛 이름이다. `helper` 는 이미 설치된 OTP 도우미의 LaunchDaemon 이
/// `helper run` 으로 부르므로 남긴다.
const ACTION_ALIASES: [(&str, &str); 1] = [("helper", "otp")];

pub(crate) fn lookup_action(name: &str) -> Option<Action> {
    let name = ACTION_ALIASES
        .iter()
        .find(|(from, _)| *from == name)
        .map_or(name, |(_, to)| *to);
    actions().into_iter().find(|a| a.name == name)
}

/// 액션 표의 이름들이다.
pub fn action_names() -> Vec<&'static str> {
    actions().iter().map(|a| a.name).collect()
}

/// 액션을 해석해 실행한다 (FR-CLI-1..7). args 는 프로그램 이름을 뺀 인자다.
pub fn dispatch(
    args: &[String],
    serve: &Serve<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    dispatch_in(args, &Env::process(), serve, stdout, stderr)
}

pub(crate) fn dispatch_in(
    args: &[String],
    env: &Env<'_>,
    serve: &Serve<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let Some((first, rest)) = args.split_first() else {
        let _ = write!(stdout, "{}", help());
        return 0;
    };
    let name = match first.as_str() {
        "-h" | "--help" | "help" => {
            let _ = write!(stdout, "{}", help());
            return 0;
        }
        // 액션 이름이 아니라 플래그 모양의 별칭이다 (FR-CLI-4).
        "--version" => "version",
        n => n,
    };
    match lookup_action(name) {
        Some(a) => (a.run)(rest, env, serve, stdout, stderr),
        None => {
            let _ = write!(stderr, "{}", unknown_action(name));
            2
        }
    }
}

/// 파서의 결과를 실행이나 종료 코드로 잇는다. help 요청이거나 옵션 오류면 액션을 실행하지 않는다
/// (FR-CLI-6/7).
fn drive<O>(
    action: &str,
    parsed: Result<O, ParseError>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    run: impl FnOnce(O, &mut dyn Write, &mut dyn Write) -> i32,
) -> i32 {
    match parsed {
        Ok(o) => run(o, stdout, stderr),
        Err(ParseError::Help) => {
            let _ = write!(stdout, "{}", usage(action));
            0
        }
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            2
        }
    }
}
