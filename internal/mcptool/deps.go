package mcptool

// ToolInfo is a minimal summary of a live tool for tool consumption.
type ToolInfo struct {
	ID       string
	Name     string
	ShellPID int
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
	Labels() map[string]string
	Entries() []WorkspaceEntry
	// CoordinateOf rewrites a UUID into the canonical positional coordinate
	// ("W{n}.P{n}.T{n}") consumed by the browser command pipeline. Non-UUID
	// input passes through unchanged. workspace_command uses this so MCP
	// callers can pass uuid in `location`.
	CoordinateOf(id string) (string, error)
	// IsKnownTabID reports whether id matches a known tab.id. workspace_command
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

// ClientToolResolver maps an SSE client's remote address to the tool whose
// shell hosts it (via PID parent-chain walking).
type ClientToolResolver interface {
	ResolveClientPane(remoteAddr string) (toolID string, shellPID int, err error)
}
