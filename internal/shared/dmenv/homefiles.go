package dmenv

// 홈(`$DONGMINAL_HOME`) 바로 아래 이름들 (OPTIMIZE_REFACTOR_SRS FR-OPT-10-2).
//
// 쓰는 쪽(서버·데몬)과 거두는 쪽(`backup`·`uninstall`·`rollback`·`migrate`)이 서로를
// import 할 수 없어서 이름이 패키지마다 리터럴로 흩어져 있었다. 값은 디스크의 계약이다 —
// 바꾸면 옛 홈의 상태를 읽지 못한다. `ctl/cli` 의 `homeLayout()` 표가 이 상수를 참조하고,
// `scripts/check-home-layout.sh` 가 정의를 따라가 코드·표·문서를 대조한다.
//
// 자기 패키지에 이미 이름을 가진 것(`serverconf.FileName`·`runfile.FileName`·
// `sandbox.ProfilesFileName`·`platform.SocketFileName` 등)은 그 자리가 원천이다.
const (
	WorkspaceFile = "workspace.json"
	SettingsFile  = "settings.json"
	AccessFile    = "access.json"
	LSPPathsFile  = "lsp-paths.json"
	ToolsFile     = "tools.json"
	// PanesFile 은 변환 전 레이아웃이다 — migrate 가 WorkspaceFile·ToolsFile 로 옮긴다.
	PanesFile     = "panes.json"
	PanedPIDFile  = "paned.pid"
	ServerLogFile = "server.log"
	DaemonLogFile = "daemon.log"

	BinDir          = "bin"
	NotesDir        = "notes"
	WorktreesDir    = "worktrees"
	GitWorktreesDir = "git-worktrees"
	ExtDir          = "ext"
	// BrowserDir 는 브라우저 탭의 프로필들이다 (BROWSER_TAB_SRS FR-BRT-10).
	BrowserDir = "browser"
)
