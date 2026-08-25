package server

import (
	"dongminal/internal/run"
	"dongminal/internal/sysstat"
	"dongminal/internal/toolaccess"
	"dongminal/internal/workspace"
	"time"
)

// ToolHub is the minimum surface that HTTP/WS handlers need from the tool
// registry. *ToolManager satisfies it naturally.
type ToolHub interface {
	List() []map[string]interface{}
	Create(cwd string, cols, rows uint16) (*Tool, error)
	Get(id string) *Tool
	// Cwd resolves the live working directory of tool id (empty if unknown).
	// In daemon mode this routes through the daemon cwd RPC; Get(id).Cwd() is
	// not usable there because Get returns a cmd-less Tool (DAEMON_CWDPANE_RESOLVE_SRS).
	Cwd(id string) string
	// Busy reports whether tool id has a running foreground process.
	// In daemon mode this routes through the daemon busy RPC; Get(id).IsBusy()
	// is not usable there because Get returns a cmd-less Tool
	// (DAEMON_PANE_BUSY_RESOLVE_SRS).
	Busy(id string) bool
	Delete(id string)
	Write(id string, data []byte) error
	Resize(id string, cols, rows uint16) error
	SnapshotTool(id string) (ToolSnapshot, error)
	IsLive(id string) bool
	// IsDaemon reports whether this hub is a daemon-backed client.
	// Used by handleWS to choose the daemon-mode code path.
	IsDaemon() bool
	// SetBackground detaches tool id from its tab (bg=true) or restores it
	// (bg=false). False when the tool does not exist (FR-BG-2/4/7).
	SetBackground(id string, bg bool) bool
	// BackgroundList returns the tools currently sent to the background,
	// oldest first (FR-BG-6).
	BackgroundList() []BackgroundEntry
}

// WorkspaceStore is implemented by *workspace.Manager; kept as an interface so
// tests can inject a fake without bringing up the real persister. Only the
// methods actually consumed by HTTP handlers in this package are listed —
// Resolve / Labels / Entries / InvalidateTool are callers' concerns
// (internal/adapters/* + main).
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
}

// CommandBroker abstracts *CommandHub. Methods stay unexported — the SSE
// handler is package-internal, so only same-package types satisfy it.
type CommandBroker interface {
	add() *cmdSub
	remove(*cmdSub)
	Broadcast(payload []byte) int
	// BroadcastAndAwait / DeliverResult support creating-command result
	// correlation (REMOTE_COMMAND_RESULT_SRS).
	BroadcastAndAwait(payload []byte, reqId string, timeout time.Duration) (CmdResult, int, bool)
	DeliverResult(reqId string, res CmdResult)
}

// SettingsStore abstracts the in-memory + on-disk settings blob holder.
type SettingsStore interface {
	get() []byte
	set([]byte)
	save()
}

// Deps is the full injection surface for New.
type Deps struct {
	Tools       ToolHub
	Work        WorkspaceStore
	Commands    CommandBroker
	Settings    SettingsStore
	AttnTracker *AttnTracker // daemon mode: attention/activity tracking in dongminal
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
	// WorkIndex resolves tool identifiers (uuid / toolId / label) and labels
	// them back for the agent-message envelope (FR-API-3/4). Nil → 503.
	WorkIndex toolaccess.WorkspaceReader
	// Stats supplies the status-bar metrics snapshot. Nil → /api/stats returns
	// only hostname and srvUptime (SYSTEM_STATS_SRS FR-STAT-7).
	Stats StatsSnapshotter
}

// StatsSnapshotter is satisfied by *sysstat.Sampler. Kept as an interface so the
// HTTP layer never reaches the kernel itself and tests can inject a fixed
// snapshot (SYSTEM_STATS_SRS FR-STAT-9).
type StatsSnapshotter interface {
	Snapshot() sysstat.Snapshot
}
