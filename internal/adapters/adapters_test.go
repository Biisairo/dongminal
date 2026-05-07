package adapters

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/server"
	"dongminal/internal/workspace"
)

type stubPersister struct{ data []byte }

func (s *stubPersister) Read() ([]byte, error)        { return s.data, nil }
func (s *stubPersister) Write(data []byte) error      { s.data = data; return nil }

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
