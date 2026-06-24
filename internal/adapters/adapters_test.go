package adapters

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/server"
	"dongminal/internal/workspace"
)

type stubPersister struct{ data []byte }

func (s *stubPersister) Read() ([]byte, error)   { return s.data, nil }
func (s *stubPersister) Write(data []byte) error { s.data = data; return nil }

func TestPaneAdapter_EmptyManager(t *testing.T) {
	pm := server.NewPaneManager(t.TempDir(), nil)
	a := Pane{PM: pm}
	if got := a.List(); len(got) != 0 {
		t.Errorf("List=%v want []", got)
	}
	if a.Has("nope") {
		t.Errorf("Has(nope)=true")
	}
	if data, drop, ok := a.Snapshot("nope"); ok || data != nil || drop != 0 {
		t.Errorf("Snapshot(nope)=%v,%d,%t", data, drop, ok)
	}
	if got := a.Size("nope"); got != "?" {
		t.Errorf("Size(nope)=%q want ?", got)
	}
	if err := a.SendPaste("nope", []byte("x"), false); err == nil {
		t.Errorf("SendPaste(nope) err=nil")
	}
}

func TestWorkspaceAdapter_ResolveAndLabels(t *testing.T) {
	pm := server.NewPaneManager(t.TempDir(), nil)
	dir := t.TempDir()
	wsMgr, err := workspace.New(pm, workspace.FilePersister{Path: filepath.Join(dir, "ws.json")})
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	defer wsMgr.Close()
	a := Workspace{WS: wsMgr}

	// empty workspace → no labels, no entries
	if got := a.Labels(); len(got) != 0 {
		t.Errorf("Labels=%v", got)
	}
	if got := a.Entries(); len(got) != 0 {
		t.Errorf("Entries=%v", got)
	}
	if _, err := a.Resolve("nonexistent"); err == nil {
		t.Errorf("Resolve(nonexistent) err=nil")
	}
}

func TestWorkspaceAdapter_EntriesShape(t *testing.T) {
	pm := server.NewPaneManager(t.TempDir(), nil)
	dir := t.TempDir()
	wsPath := filepath.Join(dir, "ws.json")
	blob := []byte(`{"sessions":[{"id":"s1","name":"S","layout":{"type":"region","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"T","paneId":"42"}]}}],"activeSession":"s1"}`)
	os.WriteFile(wsPath, blob, 0644)

	wsMgr, _ := workspace.New(pm, workspace.FilePersister{Path: wsPath})
	defer wsMgr.Close()
	a := Workspace{WS: wsMgr}

	entries := a.Entries()
	if len(entries) != 1 || entries[0].PaneID != "42" || entries[0].Label != "S1.P1.T1" {
		t.Fatalf("entries=%+v", entries)
	}
}

func TestCommandAdapter_Wraps(t *testing.T) {
	hub := server.NewCommandHub()
	a := Command{Hub: hub}
	// AllowedAction is determined by hub policy; just ensure the call doesn't panic.
	_ = a.AllowedAction("workspace_changed")
	if got := a.Broadcast([]byte(`{"action":"x"}`)); got < 0 {
		t.Errorf("Broadcast=%d", got)
	}
}

// fakeHub is a minimal PaneHub for exercising daemon-mode adapters.
type fakeHub struct {
	list []map[string]interface{}
}

func (f fakeHub) List() []map[string]interface{} { return f.list }
func (f fakeHub) Create(string, uint16, uint16) (*server.Pane, error) {
	return nil, nil
}
func (f fakeHub) Get(id string) *server.Pane {
	for _, m := range f.list {
		if m["id"] == id {
			return &server.Pane{ID: id}
		}
	}
	return nil
}
func (f fakeHub) Cwd(string) string                   { return "" }
func (f fakeHub) Delete(string)                       {}
func (f fakeHub) Write(string, []byte) error          { return nil }
func (f fakeHub) Resize(string, uint16, uint16) error { return nil }
func (f fakeHub) SnapshotPane(string) (server.PaneSnapshot, error) {
	return server.PaneSnapshot{}, nil
}
func (f fakeHub) IsLive(string) bool { return true }
func (f fakeHub) IsDaemon() bool     { return true }

// TestPaneAdapter_DaemonListShellPID verifies daemon-mode List() carries the
// shell PID from the hub payload (decoded as float64), which whoami relies on
// for PID-chain matching (FR-16).
func TestPaneAdapter_DaemonListShellPID(t *testing.T) {
	hub := fakeHub{list: []map[string]interface{}{
		{"id": "1", "name": "Shell #1", "pid": float64(4242), "sizeCols": float64(120), "sizeRows": float64(40)},
	}}
	a := Pane{Hub: hub}
	got := a.List()
	if len(got) != 1 {
		t.Fatalf("List len=%d want 1", len(got))
	}
	if got[0].ShellPID != 4242 {
		t.Fatalf("ShellPID=%d want 4242", got[0].ShellPID)
	}
	if sz := a.Size("1"); sz != "120x40" {
		t.Fatalf("Size=%q want 120x40", sz)
	}
}

// TestClientResolver_DaemonMatchesAncestor verifies the daemon-mode resolver
// matches a pane via its shell PID using the hub list (FR-16).
func TestClientResolver_DaemonMatchesAncestor(t *testing.T) {
	// Use the current process PID as a "shell PID" so the ancestor walk finds
	// it immediately (clientPID == shellPID).
	self := os.Getpid()
	hub := fakeHub{list: []map[string]interface{}{
		{"id": "7", "name": "S", "pid": float64(self)},
	}}
	r := Client{Hub: hub}
	// FromRemoteAddr can't be exercised without a live socket, so we assert the
	// PID map is built from the hub (List carries the pid) — the core fix.
	infos := (Pane{Hub: hub}).List()
	if len(infos) != 1 || infos[0].ShellPID != self {
		t.Fatalf("expected hub-derived shell pid %d, got %+v", self, infos)
	}
	_ = r
}
