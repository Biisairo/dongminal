//! 홈의 구성 — 한 곳에서 선언한다 (M5 G4-3·G3-4).
//!
//! `backup` 이 담을 것과 `uninstall` 이 지울 것은 같은 물음("무엇이 이 제품의 것인가")의 두 답이다.

use otter_shared_otterenv as otterenv;
use otter_shared_serverconf as serverconf;

pub(crate) const DAEMON_PID_FILE: &str = otterenv::PANED_PID_FILE;
pub(crate) const DAEMON_SOCK_FILE: &str = otter_shared_platform::SOCKET_FILE_NAME;
/// 위임된 재시작의 출력이 남는 곳이다. 대리 프로세스는 제어 터미널이 없다.
pub(crate) const RESTART_LOG_FILE: &str = "restart.log";
/// 격리 기동에서 도구 셸이 쓰는 홈이다.
pub(crate) const TOOL_HOME_DIR: &str = "tool-home";

/// 홈 아래 항목 하나다.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HomeEntry {
    /// 홈 기준 이름이다. 디렉터리여도 끝에 `/` 가 없다.
    pub name: &'static str,
    pub is_dir: bool,
    /// 사람이 읽는 설명이다. `uninstall --dry-run` 의 목록이 곧 안내다.
    pub what: &'static str,
    /// `backup` 이 zip 에 담는가다.
    pub in_backup: bool,
    /// 맨 `uninstall` 이 보존하는가다(`--purge` 는 그것도 지운다). FR-DSY-60~62.
    pub keep_on_uninstall: bool,
    /// 다음 기동이 다시 만드는 것인가다.
    pub ephemeral: bool,
    /// `rollback` 이 되돌릴 수 있는가다 — 세대를 남기는 상태 파일만 참이다 (SHR-19).
    pub rollback: bool,
}

const fn state(name: &'static str, what: &'static str, rollback: bool) -> HomeEntry {
    HomeEntry {
        name,
        is_dir: false,
        what,
        in_backup: true,
        keep_on_uninstall: true,
        ephemeral: false,
        rollback,
    }
}

const fn kept_dir(name: &'static str, what: &'static str) -> HomeEntry {
    HomeEntry {
        is_dir: true,
        ..state(name, what, false)
    }
}

const fn regen(name: &'static str, is_dir: bool, what: &'static str) -> HomeEntry {
    HomeEntry {
        name,
        is_dir,
        what,
        in_backup: false,
        keep_on_uninstall: false,
        ephemeral: true,
        rollback: false,
    }
}

/// 홈의 전수 목록이다. 순서가 도움말과 안내 문구의 순서다.
pub fn home_layout() -> Vec<HomeEntry> {
    vec![
        // ── 되살릴 수 있는 상태 ──
        state(
            otterenv::WORKSPACE_FILE,
            "창·칸·탭의 배치와 도구 연결",
            true,
        ),
        state(
            otterenv::SETTINGS_FILE,
            "테마·단축키·상태바·레이아웃 프리셋",
            true,
        ),
        state(
            otterenv::ACCESS_FILE,
            "접속 허용 목록 (기기·호스트 이름)",
            true,
        ),
        state(
            otterenv::LSP_PATHS_FILE,
            "언어 서버 실행 파일 경로 표 (설정 ▸ Code)",
            false,
        ),
        state(
            otter_shared_runfile::FILE_NAME,
            "Run(오케스트레이션) 기록",
            true,
        ),
        state(
            otterenv::TOOLS_FILE,
            "도구의 이름·작업 폴더 등 복원 정보",
            true,
        ),
        state(serverconf::FILE_NAME, "서버 기동값 (host·port·로그)", false),
        state("sandbox.json", "샌드박스 프로파일 정의", false),
        // FR-PNW-1·2: 키를 담아야 복원 뒤에도 지문이 같아 간선이 유지된다. backup zip 은 비밀이다.
        state(otterenv::EDGES_FILE, "노드 간 통신 설정과 간선 목록", false),
        state(
            otterenv::EDGE_CERT_FILE,
            "노드 인증서 (노드 간 통신의 신원)",
            false,
        ),
        state(otterenv::EDGE_KEY_FILE, "노드 개인키", false),
        state(
            otterenv::TELEGRAM_FILE,
            "Telegram 알림 설정 (봇 token·허용 계정·무음 시간)",
            false,
        ),
        // ── 사용자가 만든 내용 ──
        kept_dir(
            otterenv::CLAUDE_ACCOUNTS_DIR,
            "Claude 다중 계정 (계정 목록·자격증명 백업·사용량 캐시)",
        ),
        kept_dir(otterenv::NOTES_DIR, "메모장"),
        // ── 다시 만들어지는 것 ──
        regen(
            otterenv::BIN_DIR,
            true,
            "런타임 헬퍼 (서버가 기동마다 다시 채운다)",
        ),
        regen("tool-history", true, "도구 셸의 히스토리 파일"),
        regen(DAEMON_SOCK_FILE, false, "데몬 IPC 소켓"),
        regen(DAEMON_PID_FILE, false, "데몬 pidfile"),
        regen(
            otter_shared_platform::LAST_EXIT_FILE,
            false,
            "마지막 종료가 정상이었는지의 표시",
        ),
        regen(otterenv::SERVER_LOG_FILE, false, "웹 서버 로그"),
        regen(otterenv::DAEMON_LOG_FILE, false, "otterminald 로그"),
        regen(RESTART_LOG_FILE, false, "재시작 대리의 출력"),
        // FR-HRB-10 / D-HRB-9: 주소 파일은 리슨마다 쓰고 정상 종료 때 지운다.
        regen(
            serverconf::ADDR_DIR,
            true,
            "서버가 지금 리슨하는 주소 (server.addr, host:port 한 줄)",
        ),
        // ── FR-STR-30 에서 더한 것 ──
        // git-worktrees: 사용자가 Git 창에서 만든 worktree 다. 커밋하지 않은 작업이 산다 (D-STR-4).
        kept_dir(
            otterenv::GIT_WORKTREES_DIR,
            "Git 창에서 만든 사용자 worktree",
        ),
        state(
            otterenv::PANES_FILE,
            "변환 전 레이아웃 (migrate 가 workspace.json 으로 옮긴다)",
            false,
        ),
        regen(
            otterenv::WORKTREES_DIR,
            true,
            "Run 격리 worktree (정리는 Run 레코드가 정한다)",
        ),
        regen(
            otterenv::EXT_DIR,
            true,
            "편집기 플러그인·언어 서버 (다시 받을 수 있다)",
        ),
        // 이름의 출처는 shared/sandbox 의 helperCacheDir 이다.
        regen(
            "cache",
            true,
            "컨테이너용 리눅스 헬퍼 캐시 (판마다 다시 만든다)",
        ),
        regen(TOOL_HOME_DIR, true, "격리 기동에서 도구 셸이 쓰는 홈"),
        regen(
            otter_shared_toolipc::DAEMON_BUILD_FILE,
            false,
            "도는 데몬의 코드 지문",
        ),
        regen("doctor", true, "doctor 의 IPC 자리"),
        regen("doctor-tools", true, "doctor 가 띄운 도구의 데이터"),
        regen("doctor-probe.txt", false, "doctor 탐침의 출력"),
        regen(
            "verify-too-large.bin",
            false,
            "verify 가 413 을 확인할 때 쓰는 큰 파일 (죽으면 남는다)",
        ),
    ]
}
