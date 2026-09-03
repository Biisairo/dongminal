package httpapi

import (
	"dongminal/internal/webserver/hub"

	"dongminal/internal/shared/sandbox"
	"dongminal/internal/shared/toolhub"

	"dongminal/internal/shared/workspace"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/sysstat"
	"dongminal/internal/webserver/domain/worktree"
	"dongminal/internal/webserver/seam/toolaccess"
)

// WorkspaceStore is implemented by *workspace.Manager; kept as an interface so
// tests can inject a fake without bringing up the real persister. Only the
// methods actually consumed by HTTP handlers in this package are listed —
// Resolve / Labels / Entries / InvalidateTool are callers' concerns
// (internal/webserver/seam/adapters/* + main).
type WorkspaceStore interface {
	Raw() []byte
	CurrentRev() uint64
	Snapshot() ([]byte, uint64)
	Save(blob []byte, ifMatch string) (uint64, error)
	// CoordinateOf rewrites a UUID identifier into the positional "W{n}.P{n}.T{n}"
	// coordinate the browser command pipeline parses. Non-UUID input passes
	// through unchanged. Used by handleCommandPost to make dmctl accept UUIDs.
	CoordinateOf(id string) (string, error)
	// IsKnownTabID reports whether id matches a known tab.id in the current
	// workspace index. Used by handleCommandPost to enforce FR-DMC-9
	// (location must be a list-workspace uuid; coords/labels/toolIds rejected).
	IsKnownTabID(id string) bool
	// Entries returns the flat tab-level index used by /api/whoami to map a
	// toolID to its workspace coordinates and uuids (DMCTL_WHO_AM_I_SRS
	// FR-API-WAI-1).
	Entries() []workspace.TabEntry
	// Windows 는 지금 저장된 Window 들이다. 샌드박스 창의 대응 컨테이너 회수가
	// 이것을 살아 있는 목록으로 쓴다 (FR-SBX-9).
	Windows() []workspace.WindowInfo
}

// SandboxReaper 는 샌드박스 창의 접합면이다. 인터페이스인 것은 방향 때문이다 —
// httpapi 는 컨테이너 런타임을 알지 않는다.
type SandboxReaper interface {
	// Reap 은 살아 있지 않은 Window 의 대응 컨테이너를 치운다.
	Reap(live []string)
	// Profiles 는 화면이 고를 수 있는 프로파일들이다 (FR-SBX-25).
	Profiles() []sandbox.ProfileInfo
}

// SettingsStore abstracts the in-memory + on-disk settings blob holder.
type SettingsStore interface {
	get() []byte
	set([]byte)
	save()
}

// Deps is the full injection surface for New.
type Deps struct {
	Tools toolhub.ToolHub
	Work  WorkspaceStore
	// Sandbox 는 샌드박스 창의 대응 컨테이너 회수자다. nil 이면 컨테이너
	// 런타임이 없거나 샌드박스가 구성되지 않은 서버이며, 그때 회수는 일어나지
	// 않는다 — 만든 적이 없으므로 치울 것도 없다.
	Sandbox     SandboxReaper
	Commands    hub.CommandBroker
	Settings    SettingsStore
	AttnTracker *hub.AttnTracker // daemon mode: attention/activity tracking in dongminal
	// WhoAmI resolves a request's RemoteAddr to the originating tool via
	// PID parent-chain walking. /api/whoami uses it (FR-API-WAI-1). Nil → 500.
	WhoAmI toolaccess.ClientToolResolver
	// ToolIO reads a tool's scrollback and writes into its PTY. Backed by
	// adapters.Tool so /api/tools/{output,input,message} behave identically in
	// direct and daemon mode (SKILL_INJECTION_SRS FR-API-6). Nil → 503.
	ToolIO toolaccess.ToolReader
	// Runs owns runs.json — the orchestration execution record
	// (RUN_ORCHESTRATION_SRS 묶음 R). nil 이면 /api/runs* 가 503 이며 그 밖의
	// 동작에는 영향이 없다 (NFR-RUN-1).
	Runs *run.Store
	// Worktrees 는 격리 Run 의 작업 트리를 만들고 정리한다 (묶음 W). nil 이면
	// 격리를 요청한 Run 시작이 거부된다 — 조용히 none 으로 낮추지 않는다
	// (FR-WKT-11).
	Worktrees *worktree.Manager
	// UserWorktrees 는 Git 창 Worktrees 탭이 쓰는 사용자 worktree 영역의 Manager 다
	// (FR-WKT-13) — root 는 $DONGMINAL_HOME/git-worktrees 로 Worktrees(위 필드,
	// Run 격리 영역)의 형제이며 별개의 Manager 인스턴스다. nil 이면 그 탭의
	// 목록·생성·제거가 전부 503 이다 — Run 격리에는 영향이 없다.
	UserWorktrees *worktree.Manager
	// WorkIndex resolves tool identifiers (uuid / toolId / label) and labels
	// them back for the agent-message envelope (FR-API-3/4). Nil → 503.
	WorkIndex toolaccess.WorkspaceReader
	// Stats supplies the status-bar metrics snapshot. Nil → /api/stats returns
	// only hostname and srvUptime (SYSTEM_STATS_SRS FR-STAT-7).
	Stats StatsSnapshotter
	// Git 은 모든 git 조회가 통과하는 지점이다 (GIT_SRS 묶음 A~C). nil 이면
	// /api/git/* 이 전부 503 이며 그 밖의 동작에는 영향이 없다 (FR-GIT-60).
	Git *store.Store
}

// StatsSnapshotter is satisfied by *sysstat.Sampler. Kept as an interface so the
// HTTP layer never reaches the kernel itself and tests can inject a fixed
// snapshot (SYSTEM_STATS_SRS FR-STAT-9).
type StatsSnapshotter interface {
	Snapshot() sysstat.Snapshot
}
