package server

import "sync"

// ── Phase 1: ExpandedPaneHub + fake (DAEMON_SPLIT_SRS Phase 1) ─────────

// ExpandedPaneHub is the target interface shape for Phase 1.
type ExpandedPaneHub interface {
	List() []map[string]interface{}
	Create(cwd string, cols, rows uint16) (*Pane, error)
	Get(id string) *Pane
	Delete(id string)
	Restore(id, name, cwd string, cols, rows uint16) error
	IsLive(id string) bool
	SaveAll()
	LoadAll()
	Write(id string, data []byte) error
	Resize(id string, cols, rows uint16) error
	Cwd(id string) string
	Busy(id string) bool
	SnapshotPane(id string) (PaneSnapshot, error)
}

// _ ensures *PaneManager implements ExpandedPaneHub.
var _ ExpandedPaneHub = (*PaneManager)(nil)

// _ ensures *expandedPaneHubFake implements ExpandedPaneHub.
var _ ExpandedPaneHub = (*expandedPaneHubFake)(nil)

type expandedPaneHubFake struct {
	mu       sync.Mutex
	panes    map[string]*fakePaneEntry
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
	Snapshot PaneSnapshot
}

func newExpandedPaneHubFake() *expandedPaneHubFake {
	return &expandedPaneHubFake{
		panes:   map[string]*fakePaneEntry{},
		written: map[string][]byte{},
	}
}

func (f *expandedPaneHubFake) List() []map[string]interface{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]interface{}
	for _, e := range f.panes {
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

func (f *expandedPaneHubFake) Create(_ string, cols, rows uint16) (*Pane, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	id := fakeID(f.nextID)
	e := &fakePaneEntry{ID: id, Name: "Fake " + id, Cols: cols, Rows: rows, Live: true, Snapshot: PaneSnapshot{Data: []byte{}}}
	f.panes[id] = e
	f.created = append(f.created, id)
	return &Pane{ID: id, Name: e.Name}, nil
}

func (f *expandedPaneHubFake) Get(id string) *Pane {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.panes[id]
	if e == nil || !e.Live {
		return nil
	}
	return &Pane{ID: e.ID, Name: e.Name}
}

func (f *expandedPaneHubFake) Delete(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.panes[id]; e != nil {
		e.Live = false
	}
	f.deleted = append(f.deleted, id)
}

func (f *expandedPaneHubFake) Restore(id, name, cwd string, cols, rows uint16) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.panes[id] = &fakePaneEntry{ID: id, Name: name, Cwd: cwd, Cols: cols, Rows: rows, Live: true, Snapshot: PaneSnapshot{Data: []byte{}}}
	f.restored = append(f.restored, id)
	return nil
}

func (f *expandedPaneHubFake) IsLive(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.panes[id]
	return e != nil && e.Live
}

func (f *expandedPaneHubFake) SaveAll() {}
func (f *expandedPaneHubFake) LoadAll() {}

func (f *expandedPaneHubFake) Write(id string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.written[id] = append(f.written[id], data...)
	return nil
}

func (f *expandedPaneHubFake) Resize(id string, cols, rows uint16) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.panes[id]; e != nil {
		e.Cols = cols
		e.Rows = rows
	}
	return nil
}

func (f *expandedPaneHubFake) Cwd(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.panes[id]; e != nil {
		return e.Cwd
	}
	return ""
}

func (f *expandedPaneHubFake) Busy(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.panes[id]; e != nil {
		return e.Busy
	}
	return false
}

func (f *expandedPaneHubFake) SnapshotPane(id string) (PaneSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.panes[id]; e != nil {
		return e.Snapshot, nil
	}
	return PaneSnapshot{}, nil
}

func (f *expandedPaneHubFake) setCwd(id, cwd string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.panes[id]; e != nil {
		e.Cwd = cwd
	}
}

func (f *expandedPaneHubFake) setBusy(id string, busy bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.panes[id]; e != nil {
		e.Busy = busy
	}
}

func (f *expandedPaneHubFake) setSnapshot(id string, snap PaneSnapshot) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.panes[id]; e != nil {
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
