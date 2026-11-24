//! 제어 CLI (`internal/ctl/cli`) 의 도움말·인자 오류 시나리오.
//!
//! 여기의 인자 오류는 모두 파서가 실행 전에 거절하는 입력이다(`settle` 이 종료 코드 2 를 내고
//! 액션을 부르지 않는다). 그래서 `stop`·`service`·`uninstall`·`update`·`rollback` 의 실제 실행
//! 경로는 하나도 돌지 않는다. 근거는 `rust/parity/SURFACE.md` 의 "시나리오 안전 근거" 절에 있다.

use crate::{Rule, Scenario};

const CLI: &str = "6.1";
const PRIVHELPER: &str = "6.2";
/// 존재하지 않는 플래그. 모든 파서가 첫 인자에서 거절한다.
const BOGUS_FLAG: &str = "--no-such-flag";

/// (액션, 담당 이슈, 실행 전에 거절되는 인자 묶음).
fn actions() -> Vec<(&'static str, &'static str, Vec<Vec<&'static str>>)> {
    vec![
        (
            "start",
            CLI,
            vec![
                vec!["--port"],
                vec!["--port", "abc"],
                vec!["--port", "70000"],
                vec!["--port="],
                vec!["--home"],
                vec!["--restart-daemon"],
                vec!["--server-only", "--refresh-daemon"],
                vec!["extra"],
            ],
        ),
        ("stop", CLI, vec![vec!["--port", "abc"], vec!["extra"]]),
        ("migrate", CLI, vec![vec!["--home"], vec!["extra"]]),
        (
            "rollback",
            CLI,
            vec![
                vec!["--gen"],
                vec!["--gen", "x"],
                vec!["--gen", "0"],
                vec!["--file"],
                vec!["--home"],
                vec!["extra"],
            ],
        ),
        ("window", CLI, vec![vec!["--port", "abc"], vec!["extra"]]),
        (
            "backup",
            CLI,
            vec![vec![], vec!["--out"], vec!["--out="], vec!["extra"]],
        ),
        (
            "restore",
            CLI,
            vec![vec![], vec!["a.zip", "b.zip"], vec!["--home"]],
        ),
        ("uninstall", CLI, vec![vec!["--port", "abc"], vec!["extra"]]),
        (
            "service",
            CLI,
            vec![
                vec![],
                vec!["bogus"],
                vec!["install", "extra"],
                vec!["--out"],
            ],
        ),
        ("update", CLI, vec![vec!["extra"]]),
        (
            "config",
            CLI,
            vec![
                vec![],
                vec!["bogus"],
                vec!["show", "extra"],
                vec!["set"],
                vec!["set", "no.such.key", "1"],
            ],
        ),
        ("health", CLI, vec![vec!["--port", "abc"], vec!["extra"]]),
        (
            "doctor",
            CLI,
            vec![vec!["--probe-pty"], vec!["--bundle"], vec!["extra"]],
        ),
        (
            "verify",
            CLI,
            vec![
                vec!["--repo"],
                vec!["--port", "70000"],
                vec!["--home", "x"],
                vec!["extra"],
            ],
        ),
        ("version", CLI, vec![vec!["extra"]]),
    ]
}

/// `version` 출력의 Go 런타임 판(`go1.27.2`).
pub fn go_runtime_rule() -> Rule {
    Rule::regex(r"\bgo\d+\.\d+(\.\d+)?\b", "<GORUNTIME>")
}

pub fn all() -> Vec<Scenario> {
    let mut out = vec![
        Scenario::new("cli-version")
            .owner(CLI)
            .run(["version"])
            .normalize(go_runtime_rule()),
        Scenario::new("cli-version-flag")
            .owner(CLI)
            .run(["--version"])
            .normalize(go_runtime_rule()),
        Scenario::new("cli-help")
            .owner(CLI)
            .run(["--help"])
            .run(["-h"])
            .run(["help"]),
        Scenario::new("cli-empty")
            .owner(CLI)
            .run(Vec::<String>::new()),
        Scenario::new("cli-unknown-action")
            .owner(CLI)
            .run(["bogus"])
            .run(["--bogus"])
            .run(["Start"]),
    ];
    for (action, owner, bad) in actions() {
        out.push(
            Scenario::new(&format!("cli-{action}-help"))
                .owner(owner)
                .run([action, "--help"])
                .run([action, "-h"]),
        );
        let mut s = Scenario::new(&format!("cli-{action}-args"))
            .owner(owner)
            .run([action, BOGUS_FLAG]);
        for args in bad {
            s = s.run(std::iter::once(action).chain(args));
        }
        out.push(s);
    }
    // otp 는 하위 명령 방식이다. `status`·`install`·`uninstall`·`run` 은 특권 헬퍼에 닿으므로 넣지 않는다.
    out.push(
        Scenario::new("cli-otp")
            .owner(PRIVHELPER)
            .run(["otp"])
            .run(["otp", "--help"])
            .run(["otp", "-h"])
            .run(["otp", "help"])
            .run(["otp", "bogus"])
            .run(["otp", BOGUS_FLAG])
            .run(["helper", "--help"])
            .run(["helper", "bogus"]),
    );
    out
}
