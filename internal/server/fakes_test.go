package server

import (
	"context"
	"encoding/json"
	"sync"

	"dongminal/internal/mcptool"
	"dongminal/internal/workspace"
)

// ── fakePaneHub ─────────────────────────────────────

type fakePaneHub struct {
	mu      sync.Mutex
	panes   map[string]*Pane
	created []string
	nextID  int
}

func newFakePaneHub() *fakePaneHub {
	return &fakePaneHub{panes: map[string]*Pane{}}
}

func (f *fakePaneHub) seed(id, name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.panes[id] = &Pane{ID: id, Name: name}
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

type fakeCodeServerHost struct{}

func (fakeCodeServerHost) List() []map[string]interface{}           { return nil }
func (fakeCodeServerHost) Start(string) (*CodeServerInst, error)    { return nil, nil }
func (fakeCodeServerHost) Get(string) *CodeServerInst               { return nil }
func (fakeCodeServerHost) Touch(string) bool                        { return false }
func (fakeCodeServerHost) Stop(string)                              {}

// ── fakeWorkspaceStore ──────────────────────────────

type fakeWorkspaceStore struct {
	mu    sync.Mutex
	raw   []byte
	rev   uint64
	saves int
	stale bool // when true, Save returns ErrStale
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
	return f.result, nil
}

// ── fakeCommandBroker ───────────────────────────────

type fakeCommandBroker struct {
	mu        sync.Mutex
	published [][]byte
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
