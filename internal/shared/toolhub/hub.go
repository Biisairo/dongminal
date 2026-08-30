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
	// SendPaste 는 텍스트를 넣고 submit 이면 제출까지 한다. **감싸기 판단이
	// 구현 쪽에 있다** — 셸이 bracketed paste 모드를 켰는지는 PTY 출력을 읽는
	// 쪽만 알고, daemon 모드의 Get(id) 은 cmd 없는 Tool 을 주기 때문이다
	// (BRACKETED_PASTE_SRS FR-BPW-4/5). Cwd·Busy 와 같은 이유의 우회다.
	SendPaste(id string, text []byte, submit bool) error
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
