package toolhub

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
