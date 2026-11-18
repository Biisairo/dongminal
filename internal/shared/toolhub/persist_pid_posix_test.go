//go:build !windows

package toolhub

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// DAEMON_SESSION_KEEP_SRS FR-DSK-27: tools.json 은 셸 pid 를 함께 적는다 — 인계 상태를 잃은
// 새 데몬이 자식 셸의 pid 로 도구 id 를 찾는다.
func TestSaveAll_RecordsShellPID(t *testing.T) {
	m := newTestManager(t)
	p, err := m.Create(t.TempDir(), 80, 24, Placement{Command: "cat"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Delete(p.ID) })
	m.SaveAll()
	blob, err := os.ReadFile(filepath.Join(m.DataDir(), dmenv.ToolsFile))
	if err != nil {
		t.Fatal(err)
	}
	var states []ToolState
	if err := json.Unmarshal(blob, &states); err != nil {
		t.Fatal(err)
	}
	if len(states) != 1 || states[0].PID != p.CmdProcessPID() || states[0].PID == 0 {
		t.Fatalf("states = %+v, want pid %d", states, p.CmdProcessPID())
	}
}
