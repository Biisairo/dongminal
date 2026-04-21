package mcptool

// PaneInfo is a minimal summary of a live pane for tool consumption.
type PaneInfo struct {
	ID       string
	Name     string
	ShellPID int
}

// PaneReader exposes read/write access to PTY-backed panes without leaking
// the concrete Pane type into the tool layer.
type PaneReader interface {
	List() []PaneInfo
	Has(paneID string) bool
	Snapshot(paneID string) (data []byte, droppedTotal int64, ok bool)
	SendPaste(paneID string, text []byte, submit bool) error
	Size(paneID string) string
}

// WorkspaceEntry mirrors workspace.PaneLabel but is owned by this package so
// tools do not need to import the workspace package directly.
type WorkspaceEntry struct {
	PaneID      string
	Label       string
	SessionName string
	TabName     string
	IsActive    bool
}

type WorkspaceReader interface {
	Resolve(labelOrID string) (string, error)
	Labels() map[string]string
	Entries() []WorkspaceEntry
}

// CommandBroadcaster delivers workspace UI commands to connected browsers.
type CommandBroadcaster interface {
	AllowedAction(action string) bool
	Broadcast(payload []byte) int
}

// ClientPaneResolver maps an SSE client's remote address to the pane whose
// shell hosts it (via PID parent-chain walking).
type ClientPaneResolver interface {
	ResolveClientPane(remoteAddr string) (paneID string, shellPID int, err error)
}
