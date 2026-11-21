// Package apipath 는 서버 로컬 API(`/api/*`)의 경로 한 벌이다 — dmctl·헬퍼·제어
// CLI 가 서버를 부를 때 이 이름을 쓴다 (REFACTOR3_GO_STRUCT_SRS FR-RGS-40).
//
// 종전에는 부르는 쪽마다 `"/api/…"` 를 그대로 적었다. 서버가 경로를 바꾸면 빌드가
// 아니라 실행 중 404 로 드러났다. 값이 서버의 라우트 표와 같은지는 이 패키지의
// 시험이 서버 소스를 읽어 대조한다. 쿼리(`?…`)와 경로 변수(`{id}`)는 부르는 쪽이
// 붙인다.
package apipath

// 기동·서버.
const (
	Ping       = "/api/ping"
	Health     = "/api/health"
	Stats      = "/api/stats"
	State      = "/api/state"
	Settings   = "/api/settings"
	Workspace  = "/api/workspace"
	Whoami     = "/api/whoami"
	Commands   = "/api/commands"
	ServerBind = "/api/server/bind"
	FileRead   = "/api/file/read"
	EditorsAdd = "/api/editors/add"
)

// 도구.
const (
	Tools = "/api/tools"
	// ToolsPrefix 는 `/api/tools/{id}/…` 의 앞부분이다.
	ToolsPrefix          = "/api/tools/"
	ToolsInput           = "/api/tools/input"
	ToolsOutput          = "/api/tools/output"
	ToolsMessage         = "/api/tools/message"
	ToolsHeadless        = "/api/tools/headless"
	ToolsBackground      = "/api/tools/background"
	ToolsActivitySet     = "/api/tools/activity/set"
	ToolsActivityGet     = "/api/tools/activity/get"
	ToolsActivityWait    = "/api/tools/activity/wait"
	ToolsAttentionSet    = "/api/tools/attention/set"
	ToolsUsage           = "/api/tools/usage"
	ToolsSubagents       = "/api/tools/subagents"
	ToolsMigrationAdvice = "/api/tools/migration-advice"
)

// Run.
const (
	Runs = "/api/runs"
	// RunsPrefix 는 `/api/runs/{id}…` 의 앞부분이다.
	RunsPrefix     = "/api/runs/"
	RunsMembers    = "/api/runs/members"
	RunsReport     = "/api/runs/report"
	RunsClose      = "/api/runs/close"
	RunsPreamble   = "/api/runs/preamble"
	RunsTeam       = "/api/runs/team"
	RunsAttach     = "/api/runs/attach"
	RunsDetach     = "/api/runs/detach"
	RunsSucceed    = "/api/runs/succeed"
	RunsHandoff    = "/api/runs/handoff"
	RunsAssign     = "/api/runs/assign"
	RunsCoordinate = "/api/runs/coordinate"
	RunsRecover    = "/api/runs/recover"
	RunsTree       = "/api/runs/tree"
	// RunsContext 는 컨텍스트 관측의 수신 종단이다 (ORCHESTRATION_V2_SRS 묶음 C).
	// 활동 보고(ToolsActivitySet)와 **별도 종단**인 이유는 둘의 실패가 서로를 막으면
	// 안 되기 때문이다 (NFR-CBG-2).
	RunsContext = "/api/runs/context"
)

// Claude 계정.
const (
	ClaudeAccounts           = "/api/claude-accounts"
	ClaudeAccountsAdd        = "/api/claude-accounts/add"
	ClaudeAccountsSwitch     = "/api/claude-accounts/switch"
	ClaudeAccountsRefresh    = "/api/claude-accounts/refresh"
	ClaudeAccountsReset      = "/api/claude-accounts/reset"
	ClaudeAccountsHistory    = "/api/claude-accounts/history"
	ClaudeAccountsAutoswitch = "/api/claude-accounts/autoswitch"
	ClaudeAccountsMappings   = "/api/claude-accounts/mappings"
	ClaudeAccountsLaunch     = "/api/claude-accounts/launch"
)

// 간선.
const (
	Edges       = "/api/edges"
	EdgesAdd    = "/api/edges/add"
	EdgesRemove = "/api/edges/remove"
	EdgesInvite = "/api/edges/invite"
	EdgesNotify = "/api/edges/notify"
)

// git.
const (
	// GitPrefix 는 `/api/git/{종단}` 의 앞부분이다.
	GitPrefix = "/api/git/"
	GitPolicy = "/api/git/policy"
	GitJobs   = "/api/git/jobs"
)
