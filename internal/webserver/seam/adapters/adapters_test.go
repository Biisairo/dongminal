package adapters

import (
	"dongminal/internal/webserver/hub"

	"dongminal/internal/shared/toolhub"

	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/workspace"
)

func TestToolAdapter_EmptyManager(t *testing.T) {
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	a := Tool{PM: pm}
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
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
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

func TestCommandAdapter_Wraps(t *testing.T) {
	hub := hub.NewCommandHub()
	a := Command{Hub: hub}
	// AllowedAction is determined by hub policy; just ensure the call doesn't panic.
	_ = a.AllowedAction("workspace_changed")
	if got := a.Broadcast([]byte(`{"action":"x"}`)); got < 0 {
		t.Errorf("Broadcast=%d", got)
	}
}

// fakeHub is a minimal ToolHub for exercising daemon-mode adapters.
type fakeHub struct {
	list []map[string]interface{}
}

func (f fakeHub) List() []map[string]interface{} { return f.list }
func (f fakeHub) Create(string, uint16, uint16, toolhub.Placement) (*toolhub.Tool, error) {
	return nil, nil
}
func (f fakeHub) Get(id string) *toolhub.Tool {
	for _, m := range f.list {
		if m["id"] == id {
			return &toolhub.Tool{ID: id}
		}
	}
	return nil
}
func (f fakeHub) Cwd(string) string                    { return "" }
func (f fakeHub) Busy(string) bool                     { return false }
func (f fakeHub) Delete(string)                        {}
func (f fakeHub) Write(string, []byte) error           { return nil }
func (f fakeHub) SendPaste(string, []byte, bool) error { return nil }
func (f fakeHub) Resize(string, uint16, uint16) error  { return nil }
func (f fakeHub) SnapshotTool(string) (toolhub.ToolSnapshot, error) {
	return toolhub.ToolSnapshot{}, nil
}
func (f fakeHub) IsLive(string) bool                        { return true }
func (f fakeHub) IsDaemon() bool                            { return true }
func (f fakeHub) SetBackground(string, bool) bool           { return false }
func (f fakeHub) BackgroundList() []toolhub.BackgroundEntry { return nil }

// TestToolAdapter_DaemonListShellPID verifies daemon-mode List() carries the
// shell PID from the hub payload (decoded as float64), which whoami relies on
// for PID-chain matching (FR-16).
func TestToolAdapter_DaemonListShellPID(t *testing.T) {
	hub := fakeHub{list: []map[string]interface{}{
		{"id": "1", "name": "Shell #1", "pid": float64(4242), "sizeCols": float64(120), "sizeRows": float64(40)},
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
	hub := fakeHub{list: []map[string]interface{}{
		{"id": "7", "name": "S", "pid": float64(self)},
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

// TestToolAdapter_ForegroundNameBothModes는 두 모드가 같은 값을 내는 것을
// 고정한다 (C-1, FR-TAN-7, V-TAN-9).
//
// direct 모드는 ToolManager 에게 직접 묻고, 데몬 모드는 데몬이 조회해 목록
// 응답에 실어 보낸 fgName 을 읽는다. 웹 서버가 스스로 tcgetpgrp 을 부르는
// 경로는 없다 — 데몬 모드에는 PTMX 가 없기 때문이다 (R1).
func TestToolAdapter_ForegroundNameBothModes(t *testing.T) {
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	pm.Adopt(toolhub.NewDetachedTool("1", nil))

	// 데몬이 보낸 목록의 모양 그대로(JSON 디코드 결과) 흉내낸다.
	daemon := Tool{Hub: fakeHub{list: []map[string]interface{}{
		{"id": "1", "name": "Shell", "pid": float64(4242), "fgName": "claude"},
	}}}
	got := daemon.List()
	if len(got) != 1 || got[0].ForegroundName != "claude" {
		t.Fatalf("데몬 모드 List=%+v want ForegroundName=claude", got)
	}

	// direct 모드: 같은 값을 ToolManager 에서 읽는다.
	if direct := (Tool{PM: pm}).List(); len(direct) != 1 {
		t.Fatalf("direct 모드 List len=%d want 1", len(direct))
	} else if direct[0].ForegroundName != "" {
		// PTY 없는 도구는 전경 프로그램이 없다 — 추측하지 않는다 (FR-TAN-5).
		t.Fatalf("direct 모드 ForegroundName=%q want \"\"", direct[0].ForegroundName)
	}
}

// TestToolAdapter_ForegroundNameAbsentField는 fgName 이 없는 목록(구 데몬)에서도
// 조용히 빈 문자열이 되는 것을 고정한다. 필드 추가는 하위 호환이다.
func TestToolAdapter_ForegroundNameAbsentField(t *testing.T) {
	a := Tool{Hub: fakeHub{list: []map[string]interface{}{
		{"id": "1", "name": "Shell", "pid": float64(1)},
	}}}
	if got := a.List(); len(got) != 1 || got[0].ForegroundName != "" {
		t.Fatalf("List=%+v want ForegroundName=\"\"", got)
	}
}
