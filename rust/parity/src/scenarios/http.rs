//! 서버를 띄운 뒤 읽기 전용 HTTP GET 시나리오.
//!
//! 목록은 `SURFACE.md` 3절의 GET 라우트에서 뽑았다. 뺀 것과 이유:
//! - `/api/lsp/ws` (WebSocket), `/api/git/job/events` (SSE), `/api/tools/activity/wait` (long-poll)
//! - `/api/stats`, `/api/diag` (CPU·메모리·런타임 수치가 실행마다 다르다)

use crate::{Http, Rule, Scenario, Serve};

const HTTPAPI: &str = "5.5";
const GITAPI: &str = "5.4";
const WEB: &str = "7";

fn server() -> Serve {
    Serve::new(["start", "--foreground", "--port", "{port}"], "/api/ping")
}

/// 질의 없이 부르는 읽기 전용 GET. 빠진 인자에 대한 오류 응답도 비교 대상이다.
const API_GETS: &[&str] = &[
    "/api/ping",
    "/api/state",
    "/api/snapshot",
    "/api/whoami",
    "/api/tools/attention",
    "/api/tools/activity",
    "/api/tools/output",
    "/api/tools/background",
    "/api/tools/activity/get",
    "/api/tools/migration-advice",
    "/api/tools/busy",
    "/api/tools/nope/busy",
    "/api/runs",
    "/api/runs/preamble",
    "/api/runs/team",
    "/api/runs/tree",
    "/api/runs/nope/graph",
    "/api/focus",
    "/api/sandbox/profiles",
    "/api/sandbox/runtime",
    "/api/sandbox/config",
    "/api/workspace",
    "/api/workspace/revisions",
    "/api/meta",
    "/api/settings",
    "/api/server/bind",
    "/api/server/carry/nope",
    "/api/update",
    "/api/access",
    "/api/download",
    "/api/cwd",
    "/api/file/read",
    "/api/file/probe",
    "/api/file/raw",
    "/api/fs/list",
    "/api/fs/find",
    "/api/fs/grep",
    "/api/fs/download",
    "/api/fs/download-dir",
    "/api/fs/download-many",
    "/api/lsp/paths",
    "/api/editors",
    "/api/health",
    "/api/chat",
    "/api/edges",
    "/api/profile",
    "/api/claude-accounts",
    "/api/claude-accounts/history",
    "/api/claude-accounts/autoswitch",
    "/api/claude-accounts/mappings",
    "/api/claude-accounts/resolve",
    "/api/claude-accounts/unclaimed",
    "/api/telegram",
    "/api/nope",
];

const GIT_GETS: &[&str] = &[
    "/api/git/repos",
    "/api/git/status",
    "/api/git/signature",
    "/api/git/diff-content",
    "/api/git/blob",
    "/api/git/preflight",
    "/api/git/policy",
    "/api/git/recovery",
    "/api/git/log",
    "/api/git/blame",
    "/api/git/commit",
    "/api/git/refs",
    "/api/git/records",
    "/api/git/jobs",
    "/api/git/remotes",
    "/api/git/actions",
    "/api/git/branch/validate",
    "/api/git/branch/merge-preview",
    "/api/git/stash",
    "/api/git/stash/show",
    "/api/git/tag/validate",
    "/api/git/file-head",
    "/api/git/hunks",
    "/api/git/commit-range",
    "/api/git/submodules",
    "/api/git/worktrees",
    "/api/git/nope",
];

const STATIC_GETS: &[&str] = &["/", "/index.html", "/nope.js"];

/// 홈마다 새로 만드는 노드 신원(간선 인증서 지문, 태그, 채팅 참가자 ID).
pub fn node_identity_rules() -> [Rule; 4] {
    [
        Rule::regex(r"\b[0-9a-f]{64}-[0-9a-f]{32}\b", "<PARTICIPANT>").only(["body"]),
        Rule::regex(r"\b[0-9a-f]{64}\b", "<FP>").only(["body"]),
        Rule::regex(r#""(fp|node)":"[0-9a-f]{12}""#, r#""${1}":"<FP12>""#).only(["body"]),
        Rule::regex(r#"("tag":"|#)\d{4}""#, r#"${1}<TAG>""#).only(["body"]),
    ]
}

fn gets(mut s: Scenario, paths: &[&str]) -> Scenario {
    for p in paths {
        s = s.http(Http::get(p));
    }
    s
}

pub fn all() -> Vec<Scenario> {
    let mut api = gets(
        Scenario::new("http-get-api").owner(HTTPAPI).serve(server()),
        API_GETS,
    )
    .normalize(Rule::rfc3339())
    .normalize(Rule::regex(r#""nextTickAt":\d+"#, r#""nextTickAt":<UNIX>"#).only(["body"]));
    for rule in node_identity_rules() {
        api = api.normalize(rule);
    }
    vec![
        api,
        gets(
            Scenario::new("http-get-git").owner(GITAPI).serve(server()),
            GIT_GETS,
        ),
        gets(
            Scenario::new("http-static").owner(WEB).serve(server()),
            STATIC_GETS,
        ),
    ]
}
