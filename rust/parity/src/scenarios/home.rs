//! 홈 파일 생성 결과 시나리오.

use crate::{Rule, Scenario, Serve};

const CLI: &str = "6.1";
const ENTRY: &str = "7";

pub fn all() -> Vec<Scenario> {
    vec![
        // 빈 홈에서 읽기만 하는 config 하위 명령, 그다음 set 으로 server.json 을 만든다.
        Scenario::new("home-config")
            .owner(CLI)
            .run(["config", "show"])
            .run(["config", "show", "--json"])
            .run(["config", "validate"])
            .run(["config", "validate", "--json"])
            .run(["config", "get"])
            .run(["config", "set", "port", "60999"])
            .run(["config", "set", "expose", "off"])
            .run(["config", "get"])
            .run(["config", "show", "--json"])
            .home_file("server.json")
            .home_tree(Vec::<String>::new()),
        // 서버를 한 번 띄웠다 내린 뒤 홈에 남는 파일.
        Scenario::new("home-after-start")
            .owner(ENTRY)
            .serve(Serve::new(
                ["start", "--foreground", "--port", "{port}"],
                "/api/ping",
            ))
            .home_file("server.json")
            .home_file("settings.json")
            .home_file("workspace.json")
            .home_file("access.json")
            .home_file("runs.json")
            .home_file("tools.json")
            // 일시 항목(SURFACE.md 6절의 E)은 데몬이 언제 끝났는지에 따라 남거나 사라지므로 뺀다.
            .home_tree([
                "bin/",
                "tool-history/",
                "daemon.log",
                "server.log",
                "paned.",
                "run/",
                ".lastexit",
                "report.sock",
                "chat.sock",
                "node.sock",
                "dial.sock",
            ])
            .normalize(Rule::rfc3339())
            .normalize(Rule::uuid()),
    ]
}
