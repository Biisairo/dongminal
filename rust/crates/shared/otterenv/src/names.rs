/// 도구의 셸에 심기는 도구 식별자.
pub const ENV_TOOL_ID: &str = "OTTERMINAL_TOOL_ID";
/// 인스턴스의 홈.
pub const ENV_HOME: &str = "OTTERMINAL_HOME";
/// 도구 셸에 심을 HOME 을 덮어쓴다. 비면 사용자 홈이다.
pub const ENV_TOOL_HOME: &str = "OTTERMINAL_TOOL_HOME";
/// 도구 셸이 쓸 히스토리 파일 (TOOL_HISTORY_ISOLATION_SRS FR-THI-21·22).
pub const ENV_HIST_FILE: &str = "OTTERMINAL_HISTFILE";
pub const ENV_HOST: &str = "OTTERMINAL_HOST";
pub const ENV_PORT: &str = "OTTERMINAL_PORT";
/// 샌드박스 컨테이너에서 호스트를 부르는 이름 (HOT_REBIND_SRS FR-HRB-13).
pub const CONTAINER_HOST: &str = "host.docker.internal";
/// 홈의 주소 파일 폴더(`run/`)가 컨테이너 안에 붙는 자리.
pub const CONTAINER_ADDR_DIR: &str = "/run/otterminal";
/// 에이전트 도구의 실행 파일을 먼저 찾는 디렉터리.
pub const ENV_AGENT_BIN_DIR: &str = "OTTERMINAL_AGENT_BIN_DIR";
/// 도구 셸로 띄울 프로그램. Windows 에서만 읽는다 (CROSS_PLATFORM_SRS FR-XSH-3).
pub const ENV_SHELL: &str = "OTTERMINAL_SHELL";
pub const ENV_LOG_LEVEL: &str = "OTTERMINAL_LOG_LEVEL";
pub const ENV_LOG_FILE: &str = "OTTERMINAL_LOG";
/// 최신 판 확인을 통째로 막는다 (FR-UPD-11). 다른 모든 계층을 이긴다.
pub const ENV_NO_CHECK: &str = "OTTERMINAL_NO_UPDATE_CHECK";
/// 위임된 재시작 대리임을 알린다 (FR-ACT-3b).
pub const ENV_RESTART_RUNNER: &str = "OTTERMINAL_RESTART_RUNNER";
/// `ENV_HOME` 이 비었을 때 사용자 홈 아래에 잡는 이름.
pub const DEFAULT_HOME_DIR: &str = ".otterminal";
pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: &str = "58146";

/// L2 유휴 알람의 문턱(ms). 0 이면 L2 를 끈다.
pub const ENV_ATTENTION_IDLE_MS: &str = "OTTERMINAL_ATTENTION_IDLE_MS";
/// 맨 BEL 을 주의 신호로 볼지. "1" 이면 켠다.
pub const ENV_ATTENTION_BELL: &str = "OTTERMINAL_ATTENTION_BELL";
/// 커맨드 결과 long-poll 의 상한(ms) (NFR-RCR-1).
pub const ENV_CMD_RESULT_TIMEOUT_MS: &str = "OTTERMINAL_CMD_RESULT_TIMEOUT_MS";
/// 출력이 이만큼(ms) 없으면 도구의 에뮬레이터 기록을 줄 저장소로 옮겨 비운다(PERF D-50). 검사용 덮어쓰기다.
pub const ENV_SCREEN_IDLE_COMPACT_MS: &str = "OTTERMINAL_SCREEN_IDLE_COMPACT_MS";

// 홈(`$OTTERMINAL_HOME`) 바로 아래 이름들 (FR-OPT-10-2). 값은 디스크의 계약이다.
pub const WORKSPACE_FILE: &str = "workspace.json";
pub const SETTINGS_FILE: &str = "settings.json";
pub const ACCESS_FILE: &str = "access.json";
pub const LSP_PATHS_FILE: &str = "lsp-paths.json";
pub const TOOLS_FILE: &str = "tools.json";
/// 변환 전 레이아웃. migrate 가 `WORKSPACE_FILE`·`TOOLS_FILE` 로 옮긴다.
pub const PANES_FILE: &str = "panes.json";
pub const PANED_PID_FILE: &str = "paned.pid";
pub const SERVER_LOG_FILE: &str = "server.log";
pub const DAEMON_LOG_FILE: &str = "daemon.log";
/// 노드 간 통신의 설정·간선 목록과 노드 신원 (PEER_NETWORK_SRS FR-PNW-1·2).
pub const EDGES_FILE: &str = "edges.json";
/// `EDGES_FILE` 의 옛 이름. 이관에만 쓴다 (FR-PDM-71).
pub const LEGACY_PEERS_FILE: &str = "peers.json";
pub const EDGE_CERT_FILE: &str = "edge-cert.pem";
pub const EDGE_KEY_FILE: &str = "edge-key.pem";
/// 신원 파일의 옛 이름. 지우기에만 쓴다 (FR-PDM-71).
pub const LEGACY_NODE_CERT_FILE: &str = "node-cert.pem";
pub const LEGACY_NODE_KEY_FILE: &str = "node-key.pem";
/// Telegram 브리지 설정. token 이 있어 권한 600 이다 (FR-TGB-2).
pub const TELEGRAM_FILE: &str = "telegram.json";
/// Claude 다중 계정의 자리. 0700 이다 (FR-CAC-1).
pub const CLAUDE_ACCOUNTS_DIR: &str = "claude-accounts";
pub const BIN_DIR: &str = "bin";
pub const NOTES_DIR: &str = "notes";
pub const WORKTREES_DIR: &str = "worktrees";
pub const GIT_WORKTREES_DIR: &str = "git-worktrees";
pub const EXT_DIR: &str = "ext";

#[cfg(test)]
mod tests {
    use super::*;

    // FR-OPT-10-2: 홈 아래 이름은 디스크의 계약이다.
    #[test]
    fn home_file_names() {
        for (got, want) in [
            (WORKSPACE_FILE, "workspace.json"),
            (SETTINGS_FILE, "settings.json"),
            (ACCESS_FILE, "access.json"),
            (LSP_PATHS_FILE, "lsp-paths.json"),
            (TOOLS_FILE, "tools.json"),
            (PANES_FILE, "panes.json"),
            (PANED_PID_FILE, "paned.pid"),
            (SERVER_LOG_FILE, "server.log"),
            (DAEMON_LOG_FILE, "daemon.log"),
            (BIN_DIR, "bin"),
            (NOTES_DIR, "notes"),
            (WORKTREES_DIR, "worktrees"),
            (GIT_WORKTREES_DIR, "git-worktrees"),
            (EXT_DIR, "ext"),
        ] {
            assert_eq!(got, want);
        }
    }
}
