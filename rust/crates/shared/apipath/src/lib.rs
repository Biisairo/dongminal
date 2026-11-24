//! Go 기준선 `dongminal/internal/shared/apipath` 의 Rust 포팅.
//!
//! 서버 로컬 API(`/api/*`)의 경로 한 벌이다 (FR-RGS-40). 쿼리(`?…`)와 경로 변수(`{id}`)는
//! 부르는 쪽이 붙인다.

// 기동·서버.
pub const PING: &str = "/api/ping";
pub const HEALTH: &str = "/api/health";
pub const STATS: &str = "/api/stats";
pub const STATE: &str = "/api/state";
pub const SETTINGS: &str = "/api/settings";
pub const WORKSPACE: &str = "/api/workspace";
pub const WHOAMI: &str = "/api/whoami";
pub const COMMANDS: &str = "/api/commands";
pub const SERVER_BIND: &str = "/api/server/bind";
pub const FILE_READ: &str = "/api/file/read";
pub const EDITORS_ADD: &str = "/api/editors/add";

// 도구.
pub const TOOLS: &str = "/api/tools";
/// `TOOLS_PREFIX` 는 `/api/tools/{id}/…` 의 앞부분이다.
pub const TOOLS_PREFIX: &str = "/api/tools/";
pub const TOOLS_INPUT: &str = "/api/tools/input";
pub const TOOLS_OUTPUT: &str = "/api/tools/output";
pub const TOOLS_MESSAGE: &str = "/api/tools/message";
pub const TOOLS_HEADLESS: &str = "/api/tools/headless";
pub const TOOLS_BACKGROUND: &str = "/api/tools/background";
pub const TOOLS_ACTIVITY_SET: &str = "/api/tools/activity/set";
pub const TOOLS_ACTIVITY_GET: &str = "/api/tools/activity/get";
pub const TOOLS_ACTIVITY_WAIT: &str = "/api/tools/activity/wait";
pub const TOOLS_ATTENTION_SET: &str = "/api/tools/attention/set";
pub const TOOLS_USAGE: &str = "/api/tools/usage";
pub const TOOLS_SUBAGENTS: &str = "/api/tools/subagents";
pub const TOOLS_MIGRATION_ADVICE: &str = "/api/tools/migration-advice";

// Run.
pub const RUNS: &str = "/api/runs";
/// `RUNS_PREFIX` 는 `/api/runs/{id}…` 의 앞부분이다.
pub const RUNS_PREFIX: &str = "/api/runs/";
pub const RUNS_MEMBERS: &str = "/api/runs/members";
pub const RUNS_REPORT: &str = "/api/runs/report";
pub const RUNS_CLOSE: &str = "/api/runs/close";
pub const RUNS_PREAMBLE: &str = "/api/runs/preamble";
pub const RUNS_TEAM: &str = "/api/runs/team";
pub const RUNS_ATTACH: &str = "/api/runs/attach";
pub const RUNS_DETACH: &str = "/api/runs/detach";
pub const RUNS_SUCCEED: &str = "/api/runs/succeed";
pub const RUNS_HANDOFF: &str = "/api/runs/handoff";
pub const RUNS_ASSIGN: &str = "/api/runs/assign";
pub const RUNS_COORDINATE: &str = "/api/runs/coordinate";
pub const RUNS_RECOVER: &str = "/api/runs/recover";
pub const RUNS_TREE: &str = "/api/runs/tree";
/// `RUNS_CONTEXT` 는 컨텍스트 관측의 수신 종단이다 (ORCHESTRATION_V2_SRS 묶음 C).
/// 활동 보고(`TOOLS_ACTIVITY_SET`)와 **별도 종단**인 이유는 둘의 실패가 서로를 막으면
/// 안 되기 때문이다 (NFR-CBG-2).
pub const RUNS_CONTEXT: &str = "/api/runs/context";

// Claude 계정.
pub const CLAUDE_ACCOUNTS: &str = "/api/claude-accounts";
pub const CLAUDE_ACCOUNTS_ADD: &str = "/api/claude-accounts/add";
pub const CLAUDE_ACCOUNTS_SWITCH: &str = "/api/claude-accounts/switch";
pub const CLAUDE_ACCOUNTS_REFRESH: &str = "/api/claude-accounts/refresh";
pub const CLAUDE_ACCOUNTS_RESET: &str = "/api/claude-accounts/reset";
pub const CLAUDE_ACCOUNTS_HISTORY: &str = "/api/claude-accounts/history";
pub const CLAUDE_ACCOUNTS_AUTOSWITCH: &str = "/api/claude-accounts/autoswitch";
pub const CLAUDE_ACCOUNTS_MAPPINGS: &str = "/api/claude-accounts/mappings";
pub const CLAUDE_ACCOUNTS_LAUNCH: &str = "/api/claude-accounts/launch";

// 간선.
pub const EDGES: &str = "/api/edges";
pub const EDGES_ADD: &str = "/api/edges/add";
pub const EDGES_REMOVE: &str = "/api/edges/remove";
pub const EDGES_INVITE: &str = "/api/edges/invite";
pub const EDGES_NOTIFY: &str = "/api/edges/notify";

// git.
/// `GIT_PREFIX` 는 `/api/git/{종단}` 의 앞부분이다.
pub const GIT_PREFIX: &str = "/api/git/";
pub const GIT_POLICY: &str = "/api/git/policy";
pub const GIT_JOBS: &str = "/api/git/jobs";

/// 이 crate 의 상수 전부다 (이름, 값). 시험과 정합 검사가 쓴다.
pub const ALL: &[(&str, &str)] = &[
    ("PING", PING),
    ("HEALTH", HEALTH),
    ("STATS", STATS),
    ("STATE", STATE),
    ("SETTINGS", SETTINGS),
    ("WORKSPACE", WORKSPACE),
    ("WHOAMI", WHOAMI),
    ("COMMANDS", COMMANDS),
    ("SERVER_BIND", SERVER_BIND),
    ("FILE_READ", FILE_READ),
    ("EDITORS_ADD", EDITORS_ADD),
    ("TOOLS", TOOLS),
    ("TOOLS_PREFIX", TOOLS_PREFIX),
    ("TOOLS_INPUT", TOOLS_INPUT),
    ("TOOLS_OUTPUT", TOOLS_OUTPUT),
    ("TOOLS_MESSAGE", TOOLS_MESSAGE),
    ("TOOLS_HEADLESS", TOOLS_HEADLESS),
    ("TOOLS_BACKGROUND", TOOLS_BACKGROUND),
    ("TOOLS_ACTIVITY_SET", TOOLS_ACTIVITY_SET),
    ("TOOLS_ACTIVITY_GET", TOOLS_ACTIVITY_GET),
    ("TOOLS_ACTIVITY_WAIT", TOOLS_ACTIVITY_WAIT),
    ("TOOLS_ATTENTION_SET", TOOLS_ATTENTION_SET),
    ("TOOLS_USAGE", TOOLS_USAGE),
    ("TOOLS_SUBAGENTS", TOOLS_SUBAGENTS),
    ("TOOLS_MIGRATION_ADVICE", TOOLS_MIGRATION_ADVICE),
    ("RUNS", RUNS),
    ("RUNS_PREFIX", RUNS_PREFIX),
    ("RUNS_MEMBERS", RUNS_MEMBERS),
    ("RUNS_REPORT", RUNS_REPORT),
    ("RUNS_CLOSE", RUNS_CLOSE),
    ("RUNS_PREAMBLE", RUNS_PREAMBLE),
    ("RUNS_TEAM", RUNS_TEAM),
    ("RUNS_ATTACH", RUNS_ATTACH),
    ("RUNS_DETACH", RUNS_DETACH),
    ("RUNS_SUCCEED", RUNS_SUCCEED),
    ("RUNS_HANDOFF", RUNS_HANDOFF),
    ("RUNS_ASSIGN", RUNS_ASSIGN),
    ("RUNS_COORDINATE", RUNS_COORDINATE),
    ("RUNS_RECOVER", RUNS_RECOVER),
    ("RUNS_TREE", RUNS_TREE),
    ("RUNS_CONTEXT", RUNS_CONTEXT),
    ("CLAUDE_ACCOUNTS", CLAUDE_ACCOUNTS),
    ("CLAUDE_ACCOUNTS_ADD", CLAUDE_ACCOUNTS_ADD),
    ("CLAUDE_ACCOUNTS_SWITCH", CLAUDE_ACCOUNTS_SWITCH),
    ("CLAUDE_ACCOUNTS_REFRESH", CLAUDE_ACCOUNTS_REFRESH),
    ("CLAUDE_ACCOUNTS_RESET", CLAUDE_ACCOUNTS_RESET),
    ("CLAUDE_ACCOUNTS_HISTORY", CLAUDE_ACCOUNTS_HISTORY),
    ("CLAUDE_ACCOUNTS_AUTOSWITCH", CLAUDE_ACCOUNTS_AUTOSWITCH),
    ("CLAUDE_ACCOUNTS_MAPPINGS", CLAUDE_ACCOUNTS_MAPPINGS),
    ("CLAUDE_ACCOUNTS_LAUNCH", CLAUDE_ACCOUNTS_LAUNCH),
    ("EDGES", EDGES),
    ("EDGES_ADD", EDGES_ADD),
    ("EDGES_REMOVE", EDGES_REMOVE),
    ("EDGES_INVITE", EDGES_INVITE),
    ("EDGES_NOTIFY", EDGES_NOTIFY),
    ("GIT_PREFIX", GIT_PREFIX),
    ("GIT_POLICY", GIT_POLICY),
    ("GIT_JOBS", GIT_JOBS),
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    fn crates_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    /// 소스 한 파일의 `"/api/…"` 문자열 리터럴 전부다.
    fn api_literals(src: &str, out: &mut BTreeSet<String>) {
        let mut rest = src;
        while let Some(i) = rest.find("\"/api/") {
            let tail = &rest[i + 1..];
            let Some(j) = tail.find('"') else { break };
            out.insert(tail[..j].to_owned());
            rest = &tail[j..];
        }
    }

    /// `dir` 아래 시험이 아닌 `.rs` 의 리터럴을 모은다. `tests` 디렉터리와 `tests.rs` 는 뺀다.
    fn collect_routes(dir: &Path, out: &mut BTreeSet<String>) {
        for e in std::fs::read_dir(dir).expect("서버 소스") {
            let p = e.expect("dir entry").path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if p.is_dir() {
                if name != "tests" {
                    collect_routes(&p, out);
                }
            } else if name.ends_with(".rs") && name != "tests.rs" {
                api_literals(&std::fs::read_to_string(&p).expect("소스"), out);
            }
        }
    }

    /// TestPathsMatchServerRoutes: 상수마다 서버가 같은 문자열로 라우트를 둔다 (FR-RGS-40).
    #[test]
    fn paths_match_server_routes() {
        let mut routes = BTreeSet::new();
        for dir in ["webserver/httpapi/src", "webserver/gitapi/src"] {
            collect_routes(&crates_root().join(dir), &mut routes);
        }
        assert!(
            !routes.is_empty(),
            "서버 라우트 리터럴을 하나도 읽지 못했다"
        );
        for (name, v) in ALL {
            assert!(routes.contains(*v), "{name} = {v:?} — 서버 라우트에 없다");
        }
    }

    #[test]
    fn all_values_are_unique() {
        let set: BTreeSet<&str> = ALL.iter().map(|(_, v)| *v).collect();
        assert_eq!(set.len(), ALL.len());
    }
}
