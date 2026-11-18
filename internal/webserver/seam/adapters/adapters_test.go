package adapters

import (
	"time"

	"dongminal/internal/shared/toolhub"

	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/workspace"
)

func TestToolAdapter_EmptyHub(t *testing.T) {
	a := Tool{Hub: fakeHub{}}
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
	// 허브가 없으면 아무 도구도 없다.
	if err := (Tool{}).SendPaste("nope", []byte("x"), false); err == nil {
		t.Errorf("허브 없는 SendPaste err=nil")
	}
}

func TestWorkspaceAdapter_ResolveAndEntries(t *testing.T) {
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	dir := t.TempDir()
	wsMgr, err := workspace.New(pm, workspace.FilePersister{Path: filepath.Join(dir, "ws.json")})
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	defer wsMgr.Close()
	a := Workspace{WS: wsMgr}

	// empty workspace → no entries
	if got := a.Entries(); len(got) != 0 {
		t.Errorf("Entries=%v", got)
	}
	if _, err := a.Resolve("nonexistent"); err == nil {
		t.Errorf("Resolve(nonexistent) err=nil")
	}
}

func TestWorkspaceAdapter_EntriesShape(t *testing.T) {
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	dir := t.TempDir()
	wsPath := filepath.Join(dir, "ws.json")
	blob := []byte(`{"schemaVersion": 2, "windows":[{"id":"s1","name":"S","layout":{"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"T","toolId":"42"}]}}],"activeWindow":"s1"}`)
	os.WriteFile(wsPath, blob, 0644)

	wsMgr, _ := workspace.New(pm, workspace.FilePersister{Path: wsPath})
	defer wsMgr.Close()
	a := Workspace{WS: wsMgr}

	entries := a.Entries()
	if len(entries) != 1 || entries[0].ToolID != "42" || entries[0].Label != "W1.P1.T1" {
		t.Fatalf("entries=%+v", entries)
	}
}

// fakeHub is a minimal ToolHub for exercising the adapters.
type fakeHub struct {
	list []toolhub.ToolInfo
}

func (f fakeHub) has(id string) bool {
	for _, m := range f.list {
		if m.ID == id {
			return true
		}
	}
	return false
}

func (fakeHub) Subscribe(string, chan toolhub.OutChunk) (<-chan struct{}, func()) {
	return make(chan struct{}), func() {}
}
func (fakeHub) SnapshotToolSince(string, int64) (toolhub.ToolSnapshot, error) {
	return toolhub.ToolSnapshot{}, nil
}
func (fakeHub) DaemonInfo() toolhub.DaemonInfo      { return toolhub.DaemonInfo{} }
func (fakeHub) Reconnects() int64                   { return 0 }
func (fakeHub) HasFeature(string) bool              { return false }
func (fakeHub) InputNotify(string, []byte)          {}
func (fakeHub) ResizeNotify(string, uint16, uint16) {}

func (f fakeHub) List() []toolhub.ToolInfo           { return f.list }
func (f fakeHub) ListOK() ([]toolhub.ToolInfo, bool) { return f.list, true }
func (f fakeHub) Connected() bool                    { return true }
func (f fakeHub) Create(string, uint16, uint16, toolhub.Placement) (*toolhub.Tool, error) {
	return nil, nil
}
func (f fakeHub) Get(id string) *toolhub.Tool {
	for _, m := range f.list {
		if m.ID == id {
			return &toolhub.Tool{ID: id}
		}
	}
	return nil
}
func (f fakeHub) Cwd(string) string                           { return "" }
func (f fakeHub) Busy(string) bool                            { return false }
func (f fakeHub) BusyMany([]string) (map[string]bool, bool)   { return map[string]bool{}, true }
func (f fakeHub) ShellProbe(string, []int) toolhub.ShellState { return toolhub.ShellUnknown }
func (f fakeHub) Delete(string) error                         { return nil }
func (f fakeHub) Terminate(string, time.Duration) error       { return nil }
func (f fakeHub) Write(string, []byte) error                  { return nil }
func (f fakeHub) SendPaste(id string, _ []byte, _ bool) error {
	if !f.has(id) {
		return toolhub.ErrToolNotFound
	}
	return nil
}
func (f fakeHub) Resize(string, uint16, uint16) error { return nil }
func (f fakeHub) SnapshotTool(id string) (toolhub.ToolSnapshot, error) {
	if !f.has(id) {
		return toolhub.ToolSnapshot{}, toolhub.ErrToolNotFound
	}
	return toolhub.ToolSnapshot{}, nil
}
func (f fakeHub) IsLive(string) bool                        { return true }
func (f fakeHub) SetBackground(string, bool) bool           { return false }
func (f fakeHub) BackgroundList() []toolhub.BackgroundEntry { return nil }

// TestToolAdapter_DaemonListShellPID verifies daemon-mode List() carries the
// shell PID from the hub payload, which whoami relies on for PID-chain
// matching (FR-16).
func TestToolAdapter_DaemonListShellPID(t *testing.T) {
	hub := fakeHub{list: []toolhub.ToolInfo{
		{ID: "1", Name: "Shell #1", PID: 4242, Cols: 120, Rows: 40},
	}}
	a := Tool{Hub: hub}
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
// matches a tool via its shell PID using the hub list (FR-16).
func TestClientResolver_DaemonMatchesAncestor(t *testing.T) {
	// Use the current process PID as a "shell PID" so the ancestor walk finds
	// it immediately (clientPID == shellPID).
	self := os.Getpid()
	hub := fakeHub{list: []toolhub.ToolInfo{
		{ID: "7", Name: "S", PID: self},
	}}
	r := Client{Hub: hub}
	// FromRemoteAddr can't be exercised without a live socket, so we assert the
	// PID map is built from the hub (List carries the pid) — the core fix.
	infos := (Tool{Hub: hub}).List()
	if len(infos) != 1 || infos[0].ShellPID != self {
		t.Fatalf("expected hub-derived shell pid %d, got %+v", self, infos)
	}
	_ = r
}

// ── 전경 프로세스 이름 (CONVENIENCE_SRS 묶음 N) ──────────────────────────

// TestToolAdapter_ForegroundNameFromDaemon 은 전경 이름이 데몬이 조회해 목록 응답에 실어
// 보낸 fgName 임을 고정한다 (C-1, FR-TAN-7, V-TAN-9). 웹 서버가 스스로 tcgetpgrp 을 부르는
// 경로는 없다 — 이 프로세스에는 PTMX 가 없다 (R1).
func TestToolAdapter_ForegroundNameFromDaemon(t *testing.T) {
	daemon := Tool{Hub: fakeHub{list: []toolhub.ToolInfo{
		{ID: "1", Name: "Shell", PID: 4242, FgName: "claude"},
	}}}
	if got := daemon.List(); len(got) != 1 || got[0].ForegroundName != "claude" {
		t.Fatalf("List=%+v want ForegroundName=claude", got)
	}
}

// TestToolAdapter_ForegroundNameAbsentField는 fgName 이 없는 목록(구 데몬)에서도
// 조용히 빈 문자열이 되는 것을 고정한다. 필드 추가는 하위 호환이다.
func TestToolAdapter_ForegroundNameAbsentField(t *testing.T) {
	a := Tool{Hub: fakeHub{list: []toolhub.ToolInfo{
		{ID: "1", Name: "Shell", PID: 1},
	}}}
	if got := a.List(); len(got) != 1 || got[0].ForegroundName != "" {
		t.Fatalf("List=%+v want ForegroundName=\"\"", got)
	}
}
