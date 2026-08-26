package server

import "dongminal/internal/shared/toolhub"

import "sync"

// ── Phase 1: ExpandedToolHub + fake (DAEMON_SPLIT_SRS Phase 1) ─────────

// ExpandedToolHub is the target interface shape for Phase 1.
type ExpandedToolHub interface {
	List() []map[string]interface{}
	Create(cwd string, cols, rows uint16) (*toolhub.Tool, error)
	Get(id string) *toolhub.Tool
	Delete(id string)
	Restore(id, name, cwd string, cols, rows uint16) error
	IsLive(id string) bool
	SaveAll()
	LoadAll(map[string]struct{})
	Write(id string, data []byte) error
	Resize(id string, cols, rows uint16) error
	Cwd(id string) string
	Busy(id string) bool
	SnapshotTool(id string) (toolhub.ToolSnapshot, error)
}

// _ ensures *toolhub.ToolManager implements ExpandedToolHub.
var _ ExpandedToolHub = (*toolhub.ToolManager)(nil)

// _ ensures *expandedToolHubFake implements ExpandedToolHub.
var _ ExpandedToolHub = (*expandedToolHubFake)(nil)

type expandedToolHubFake struct {
	mu       sync.Mutex
	tools    map[string]*fakePaneEntry
	nextID   int
	created  []string
	deleted  []string
	restored []string
	written  map[string][]byte
}

type fakePaneEntry struct {
	ID       string
	Name     string
	Cwd      string
	PID      int
	Cols     uint16
	Rows     uint16
	Live     bool
	Busy     bool
	Snapshot toolhub.ToolSnapshot
}

func newExpandedPaneHubFake() *expandedToolHubFake {
	return &expandedToolHubFake{
		tools:   map[string]*fakePaneEntry{},
		written: map[string][]byte{},
	}
}

func (f *expandedToolHubFake) List() []map[string]interface{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]interface{}
	for _, e := range f.tools {
		if !e.Live {
			continue
		}
		out = append(out, map[string]interface{}{
			"id": e.ID, "name": e.Name, "pid": e.PID,
			"sizeCols": e.Cols, "sizeRows": e.Rows,
		})
	}
	return out
}

func (f *expandedToolHubFake) Create(_ string, cols, rows uint16) (*toolhub.Tool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	id := fakeID(f.nextID)
	e := &fakePaneEntry{ID: id, Name: "Fake " + id, Cols: cols, Rows: rows, Live: true, Snapshot: toolhub.ToolSnapshot{Data: []byte{}}}
	f.tools[id] = e
	f.created = append(f.created, id)
	return &toolhub.Tool{ID: id, Name: e.Name}, nil
}

func (f *expandedToolHubFake) Get(id string) *toolhub.Tool {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.tools[id]
	if e == nil || !e.Live {
		return nil
	}
	return &toolhub.Tool{ID: e.ID, Name: e.Name}
}

func (f *expandedToolHubFake) Delete(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.tools[id]; e != nil {
		e.Live = false
	}
	f.deleted = append(f.deleted, id)
}

func (f *expandedToolHubFake) Restore(id, name, cwd string, cols, rows uint16) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tools[id] = &fakePaneEntry{ID: id, Name: name, Cwd: cwd, Cols: cols, Rows: rows, Live: true, Snapshot: toolhub.ToolSnapshot{Data: []byte{}}}
	f.restored = append(f.restored, id)
	return nil
}

func (f *expandedToolHubFake) IsLive(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.tools[id]
	return e != nil && e.Live
}

func (f *expandedToolHubFake) SaveAll()                    {}
func (f *expandedToolHubFake) LoadAll(map[string]struct{}) {}

func (f *expandedToolHubFake) Write(id string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.written[id] = append(f.written[id], data...)
	return nil
}

func (f *expandedToolHubFake) Resize(id string, cols, rows uint16) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.tools[id]; e != nil {
		e.Cols = cols
		e.Rows = rows
	}
	return nil
}

func (f *expandedToolHubFake) Cwd(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.tools[id]; e != nil {
		return e.Cwd
	}
	return ""
}

func (f *expandedToolHubFake) Busy(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.tools[id]; e != nil {
		return e.Busy
	}
	return false
}

func (f *expandedToolHubFake) SnapshotTool(id string) (toolhub.ToolSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.tools[id]; e != nil {
		return e.Snapshot, nil
	}
	return toolhub.ToolSnapshot{}, nil
}

func (f *expandedToolHubFake) setCwd(id, cwd string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.tools[id]; e != nil {
		e.Cwd = cwd
	}
}

func (f *expandedToolHubFake) setBusy(id string, busy bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.tools[id]; e != nil {
		e.Busy = busy
	}
}

func (f *expandedToolHubFake) setSnapshot(id string, snap toolhub.ToolSnapshot) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.tools[id]; e != nil {
		e.Snapshot = snap
	}
}

func fakeID(n int) string {
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
