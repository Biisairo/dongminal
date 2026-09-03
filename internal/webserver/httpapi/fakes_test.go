package httpapi

import (
	"dongminal/internal/webserver/hub"

	"dongminal/internal/shared/toolhub"

	"sync"
	"time"

	"dongminal/internal/shared/workspace"
)

// ── fakePaneHub ─────────────────────────────────────

type fakePaneHub struct {
	lastPlace toolhub.Placement
	mu        sync.Mutex
	tools     map[string]*toolhub.Tool
	cwds      map[string]string
	busies    map[string]bool
	created   []string
	nextID    int
	lastCols  uint16
	lastRows  uint16
	lastCwd   string
}

func newFakePaneHub() *fakePaneHub {
	return &fakePaneHub{tools: map[string]*toolhub.Tool{}, cwds: map[string]string{}, busies: map[string]bool{}}
}

func (f *fakePaneHub) seed(id, name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tools[id] = &toolhub.Tool{ID: id, Name: name}
}

// setCwd records the working directory the hub reports for tool id via Cwd().
// Mirrors the live cwd a real toolhub.ToolManager/toolclient.ToolClient would resolve.
func (f *fakePaneHub) setCwd(id, cwd string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cwds[id] = cwd
}

// Cwd reports the recorded working directory for tool id (empty if unknown).
func (f *fakePaneHub) Cwd(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cwds[id]
}

// setBusy records the busy state the hub reports for tool id via Busy().
// Mirrors the live foreground-process state a real toolhub.ToolManager/toolclient.ToolClient
// would resolve (daemon mode routes through the busy RPC).
func (f *fakePaneHub) setBusy(id string, busy bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.busies[id] = busy
}

// Busy reports the recorded busy state for tool id (false if unknown).
func (f *fakePaneHub) Busy(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.busies[id]
}

func (f *fakePaneHub) List() []map[string]interface{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]map[string]interface{}, 0, len(f.tools))
	for _, p := range f.tools {
		out = append(out, map[string]interface{}{"id": p.ID, "name": p.Name, "pid": 0})
	}
	return out
}

func (f *fakePaneHub) Create(cwd string, cols, rows uint16, place toolhub.Placement) (*toolhub.Tool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	id := "fake" + itoa(f.nextID)
	p := &toolhub.Tool{ID: id, Name: "Fake " + id}
	f.tools[id] = p
	f.created = append(f.created, id)
	f.lastCols = cols
	f.lastRows = rows
	f.lastCwd = cwd
	f.lastPlace = place
	return p, nil
}

func (f *fakePaneHub) Get(id string) *toolhub.Tool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tools[id]
}

func (f *fakePaneHub) Delete(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.tools, id)
}

func (f *fakePaneHub) IsLive(id string) bool                               { return f.Get(id) != nil }
func (f *fakePaneHub) Write(id string, data []byte) error                  { return nil }
func (f *fakePaneHub) SendPaste(id string, text []byte, submit bool) error { return nil }
func (f *fakePaneHub) Resize(id string, cols, rows uint16) error           { return nil }
func (f *fakePaneHub) SnapshotTool(id string) (toolhub.ToolSnapshot, error) {
	return toolhub.ToolSnapshot{}, nil
}
func (f *fakePaneHub) IsDaemon() bool                            { return false }
func (f *fakePaneHub) SetBackground(string, bool) bool           { return false }
func (f *fakePaneHub) BackgroundList() []toolhub.BackgroundEntry { return nil }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// ── fakeWorkspaceStore ──────────────────────────────

type fakeWorkspaceStore struct {
	windows  []workspace.WindowInfo
	mu       sync.Mutex
	raw      []byte
	rev      uint64
	saves    int
	stale    bool // when true, Save returns ErrStale
	coordMap map[string]string
	coordErr map[string]error
	entries  []workspace.TabEntry
}

func newFakeWorkspaceStore() *fakeWorkspaceStore {
	return &fakeWorkspaceStore{}
}

func (f *fakeWorkspaceStore) Raw() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.raw...)
}

func (f *fakeWorkspaceStore) CurrentRev() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rev
}

func (f *fakeWorkspaceStore) Snapshot() ([]byte, uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.raw...), f.rev
}

func (f *fakeWorkspaceStore) Save(blob []byte, ifMatch string) (uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.stale {
		return 0, workspace.ErrStale
	}
	f.raw = append([]byte(nil), blob...)
	f.rev++
	f.saves++
	return f.rev, nil
}

func (f *fakeWorkspaceStore) CoordinateOf(id string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, ok := f.coordErr[id]; ok {
		return "", err
	}
	if v, ok := f.coordMap[id]; ok {
		return v, nil
	}
	return id, nil
}

func (f *fakeWorkspaceStore) Entries() []workspace.TabEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]workspace.TabEntry(nil), f.entries...)
}

func (f *fakeWorkspaceStore) IsKnownTabID(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id == "" {
		return false
	}
	_, ok := f.coordMap[id]
	return ok
}

// ── fakeCommandBroker ───────────────────────────────

type fakeCommandBroker struct {
	mu             sync.Mutex
	published      [][]byte
	awaitResult    hub.CmdResult
	awaitDelivered int
	awaitTimedOut  bool
	deliverCalls   []string // reqIds passed to DeliverResult
}

func (f *fakeCommandBroker) Add() *hub.CmdSub {
	return hub.NewCmdSub()
}

func (f *fakeCommandBroker) Remove(s *hub.CmdSub) {
	if s != nil {
		s.Close()
	}
}

func (f *fakeCommandBroker) Broadcast(payload []byte) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.published = append(f.published, append([]byte(nil), payload...))
	return 1
}

func (f *fakeCommandBroker) BroadcastAndAwait(payload []byte, reqId string, timeout time.Duration) (hub.CmdResult, int, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.published = append(f.published, append([]byte(nil), payload...))
	return f.awaitResult, f.awaitDelivered, f.awaitTimedOut
}

func (f *fakeCommandBroker) DeliverResult(reqId string, res hub.CmdResult) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deliverCalls = append(f.deliverCalls, reqId)
}

// ── fakeSettingsStore ───────────────────────────────

type fakeSettingsStore struct {
	mu    sync.Mutex
	blob  []byte
	saves int
}

func (f *fakeSettingsStore) get() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.blob...)
}
func (f *fakeSettingsStore) set(b []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.blob = append([]byte(nil), b...)
}
func (f *fakeSettingsStore) save() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saves++
}

// ── fakeUnknownHub ─────────────────────────────────────
//
// TOOL_LIST_UNKNOWN_SRS §2.2: 데몬 RPC 가 실패한 순간의 ToolClient 를 흉내낸다.
// `List()` 는 nil 을 주고 `ListOK()` 는 "모른다"를 함께 말한다 — 도구가 정말 0개인
// 경우(`nil, true`)와 갈리는 것이 이 fake 의 전부다 (FR-TLU-2).
type fakeUnknownHub struct {
	*fakePaneHub
}

func (f *fakeUnknownHub) List() []map[string]interface{} { return nil }

func (f *fakeUnknownHub) ListOK() ([]map[string]interface{}, bool) { return nil, false }

// windows 는 회수 시험이 주입하는 살아 있는 Window 목록이다. 기본값 nil 은
// "workspace 를 읽지 못했다" 를 뜻하며, 그때 회수는 일어나지 않아야 한다.
func (f *fakeWorkspaceStore) Windows() []workspace.WindowInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.windows
}
