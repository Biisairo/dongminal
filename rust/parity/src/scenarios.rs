//! 등록된 시나리오. 새 시나리오는 `all()` 에 더한다 (README 참고).

use crate::{Http, Rule, Scenario, Serve};

/// `version` 출력의 런타임 판(`go1.27.2`). 런타임이 다르면 값이 달라지므로 토큰으로 바꾼다.
fn go_runtime_rule() -> Rule {
    Rule::regex(r"\bgo\d+\.\d+(\.\d+)?\b", "<GORUNTIME>")
}

pub fn all() -> Vec<Scenario> {
    vec![
        Scenario::new("cli-version")
            .run(["version"])
            .normalize(go_runtime_rule()),
        Scenario::new("cli-version-flag")
            .run(["--version"])
            .normalize(go_runtime_rule()),
        Scenario::new("cli-help")
            .run(["--help"])
            .run(["-h"])
            .run(["help"]),
        Scenario::new("cli-no-args").run(Vec::<String>::new()),
        Scenario::new("cli-unknown-action").run(["bogus"]),
        Scenario::new("server-ping")
            .serve(Serve::new(
                ["start", "--foreground", "--port", "{port}"],
                "/api/ping",
            ))
            .http(Http::get("/api/ping")),
    ]
}
