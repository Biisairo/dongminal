package server

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"dongminal/internal/mcptool"
	"dongminal/internal/workspace"
)

// ── fakePaneHub ─────────────────────────────────────

type fakePaneHub struct {
	mu       sync.Mutex
	panes    map[string]*Pane
	cwds     map[string]string
	created  []string
	nextID   int
	lastCols uint16
	lastRows uint16
	lastCwd  string
}

func newFakePaneHub() *fakePaneHub {
	return &fakePaneHub{panes: map[string]*Pane{}, cwds: map[string]string{}}
}

func (f *fakePaneHub) seed(id, name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.panes[id] = &Pane{ID: id, Name: name}
}

// setCwd records the working directory the hub reports for pane id via Cwd().
// Mirrors the live cwd a real PaneManager/PaneClient would resolve.
func (f *fakePaneHub) setCwd(id, cwd string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cwds[id] = cwd
}

// Cwd reports the recorded working directory for pane id (empty if unknown).
func (f *fakePaneHub) Cwd(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cwds[id]
}

func (f *fakePaneHub) List() []map[string]interface{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]map[string]interface{}, 0, len(f.panes))
	for _, p := range f.panes {
		out = append(out, map[string]interface{}{"id": p.ID, "name": p.Name, "pid": 0})
	}
	return out
}

func (f *fakePaneHub) Create(cwd string, cols, rows uint16) (*Pane, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	id := "fake" + itoa(f.nextID)
	p := &Pane{ID: id, Name: "Fake " + id}
	f.panes[id] = p
	f.created = append(f.created, id)
	f.lastCols = cols
	f.lastRows = rows
	f.lastCwd = cwd
	return p, nil
}

func (f *fakePaneHub) Get(id string) *Pane {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.panes[id]
}

func (f *fakePaneHub) Delete(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.panes, id)
}

func (f *fakePaneHub) IsLive(id string) bool                     { return f.Get(id) != nil }
func (f *fakePaneHub) Write(id string, data []byte) error        { return nil }
func (f *fakePaneHub) Resize(id string, cols, rows uint16) error { return nil }
func (f *fakePaneHub) SnapshotPane(id string) (PaneSnapshot, error) {
	return PaneSnapshot{}, nil
}
func (f *fakePaneHub) IsDaemon() bool { return false }

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

// ── fakeCodeServerHost ──────────────────────────────

type fakeCodeServerHost struct {
	mu        sync.Mutex
	startResp *CodeServerInst
	startErr  error
	touchOK   bool
	stopped   []string
	listResp  []map[string]interface{}
}

func (f *fakeCodeServerHost) List() []map[string]interface{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.listResp
}
func (f *fakeCodeServerHost) Start(folder string) (*CodeServerInst, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.startResp, f.startErr
}
func (f *fakeCodeServerHost) Get(string) *CodeServerInst { return nil }
func (f *fakeCodeServerHost) Touch(string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.touchOK
}
func (f *fakeCodeServerHost) Stop(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped = append(f.stopped, id)
}

// ── fakeWorkspaceStore ──────────────────────────────

type fakeWorkspaceStore struct {
	mu       sync.Mutex
	raw      []byte
	rev      uint64
	saves    int
	stale    bool // when true, Save returns ErrStale
	coordMap map[string]string
	coordErr map[string]error
	entries  []workspace.PaneLabel
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

func (f *fakeWorkspaceStore) Entries() []workspace.PaneLabel {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]workspace.PaneLabel(nil), f.entries...)
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

// ── fakeToolDispatcher ──────────────────────────────

type dispatchCall struct {
	Name string
	Args json.RawMessage
}

type fakeToolDispatcher struct {
	mu     sync.Mutex
	calls  []dispatchCall
	result mcptool.Result
	names  []string
}

func newFakeToolDispatcher() *fakeToolDispatcher {
	return &fakeToolDispatcher{
		result: mcptool.TextResult("fake-dispatched"),
		names:  []string{"fake_tool"},
	}
}

func (f *fakeToolDispatcher) List() []map[string]any {
	out := make([]map[string]any, 0, len(f.names))
	for _, n := range f.names {
		out = append(out, map[string]any{"name": n})
	}
	return out
}

func (f *fakeToolDispatcher) Dispatch(ctx context.Context, name string, args json.RawMessage) (mcptool.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, dispatchCall{Name: name, Args: append(json.RawMessage(nil), args...)})
	// Simulate unknown tool for names not in the registry.
	known := false
	for _, n := range f.names {
		if n == name {
			known = true
			break
		}
	}
	if !known {
		return nil, fmt.Errorf("%w: %s", mcptool.ErrUnknownTool, name)
	}
	return f.result, nil
}

// ── fakeCommandBroker ───────────────────────────────

type fakeCommandBroker struct {
	mu             sync.Mutex
	published      [][]byte
	awaitResult    CmdResult
	awaitDelivered int
	awaitTimedOut  bool
	deliverCalls   []string // reqIds passed to DeliverResult
}

func (f *fakeCommandBroker) add() *cmdSub {
	return &cmdSub{ch: make(chan []byte, 1), done: make(chan struct{})}
}

func (f *fakeCommandBroker) remove(s *cmdSub) {
	if s != nil {
		s.once.Do(func() { close(s.done) })
	}
}

func (f *fakeCommandBroker) Broadcast(payload []byte) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.published = append(f.published, append([]byte(nil), payload...))
	return 1
}

func (f *fakeCommandBroker) BroadcastAndAwait(payload []byte, reqId string, timeout time.Duration) (CmdResult, int, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.published = append(f.published, append([]byte(nil), payload...))
	return f.awaitResult, f.awaitDelivered, f.awaitTimedOut
}

func (f *fakeCommandBroker) DeliverResult(reqId string, res CmdResult) {
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
