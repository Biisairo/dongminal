// Package toolaccess 는 도구(PTY)·워크스페이스·커맨드 허브에 대한 읽기·쓰기 접합면을
// 인터페이스로 정의한다. 구체 타입(internal/webserver/httpapi, internal/shared/workspace)을 소비자에게
// 노출하지 않기 위한 경계이며, 구현은 internal/webserver/seam/adapters 가 제공한다.
package toolaccess

// ToolInfo is a minimal summary of a live tool for tool consumption.
type ToolInfo struct {
	ID       string
	Name     string
	ShellPID int

	// ForegroundName is the tool's foreground process name, or "" when the
	// shell sits at a prompt or the lookup failed (CONVENIENCE_SRS FR-TAN-5/6).
	// The lookup happens in whichever process owns the PTY, so this is filled
	// identically in direct and daemon mode (FR-TAN-7).
	ForegroundName string
}

// ToolReader exposes read/write access to PTY-backed tools without leaking
// the concrete Tool type into the tool layer.
type ToolReader interface {
	List() []ToolInfo
	Has(toolID string) bool
	Snapshot(toolID string) (data []byte, droppedTotal int64, ok bool)
	SendPaste(toolID string, text []byte, submit bool) error
	Size(toolID string) string
}

// WorkspaceEntry mirrors workspace.TabEntry but is owned by this package so
// tools do not need to import the workspace package directly.
type WorkspaceEntry struct {
	ToolID     string
	Label      string
	WindowName string
	TabName    string
	IsActive   bool

	// Entity identity (UUID_IDENTITY_SRS Phase 1). Empty when upstream
	// workspace.json predates the schema.
	WindowUUID string
	PaneUUID   string
	TabUUID    string
	ShortCode  string
}

type WorkspaceReader interface {
	Resolve(labelOrID string) (string, error)
	// ResolveStrict is Resolve without coordinate-label acceptance
	// (ORCHESTRATION_V2_SRS FR-IDU-1). Agent-facing endpoints use this so a
	// label cannot silently retarget another tool after a reflow; layout
	// commands keep using Resolve. Step 0: delegates to Resolve.
	ResolveStrict(id string) (string, error)
	Labels() map[string]string
	Entries() []WorkspaceEntry
	// CoordinateOf rewrites a UUID into the canonical positional coordinate
	// ("W{n}.P{n}.T{n}") consumed by the browser command pipeline. Non-UUID
	// input passes through unchanged. /api/commands uses this so callers can
	// pass uuid in `location`.
	CoordinateOf(id string) (string, error)
	// IsKnownTabID reports whether id matches a known tab.id. /api/commands
	// uses this to reject non-uuid location inputs (FR-DMC-9).
	IsKnownTabID(id string) bool
}

// TabRef pairs a new tab's uuid with its toolId (REMOTE_COMMAND_RESULT_SRS).
type TabRef struct {
	UUID   string `json:"uuid"`
	ToolID string `json:"toolId"`
}

// CmdResult is the set of entities a creating command produced.
type CmdResult struct {
	NewWindows []string `json:"newWindows"`
	NewPanes   []string `json:"newPanes"`
	NewTabs    []TabRef `json:"newTabs"`
}

// CommandBroadcaster delivers workspace UI commands to connected browsers.
type CommandBroadcaster interface {
	AllowedAction(action string) bool
	Broadcast(payload []byte) int
	// 생성 명령 결과 correlation (REMOTE_COMMAND_RESULT_SRS FR-RCR-8).
	IsCreatingAction(action string) bool
	NewReqId() string
	BroadcastAndAwait(payload []byte, reqId string) (CmdResult, int, bool)
}

// ClientToolResolver maps a caller's remote address to the tool whose shell
// hosts it (via PID parent-chain walking). /api/whoami falls back to this when
// the request carries no toolId (DMCTL_WHO_AM_I_SRS FR-API-WAI-1).
type ClientToolResolver interface {
	ResolveClientPane(remoteAddr string) (toolID string, shellPID int, err error)
}
