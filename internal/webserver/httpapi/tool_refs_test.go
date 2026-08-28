package httpapi

import (
	"dongminal/internal/shared/toolhub"

	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// FR-EM-14: tools.json 의 항목 중 어떤 탭도 참조하지 않는 것은 복원하지 않는다.
// 기존 LoadAll 은 전량을 무조건 Restore 해서, 도달 불가한 셸이 부팅마다
// 되살아났다 (실측 고아율 50%).

func seedTools(t *testing.T, dir string, ids ...string) {
	t.Helper()
	states := make([]toolhub.ToolState, 0, len(ids))
	for _, id := range ids {
		states = append(states, toolhub.ToolState{ID: id, Name: "Shell #" + id, Cwd: dir})
	}
	b, err := json.Marshal(states)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tools.json"), b, 0o644); err != nil {
		t.Fatalf("seed tools.json: %v", err)
	}
}

func TestLoadAll_SkipsUnreferencedTools(t *testing.T) {
	dir := toolTempDir(t)
	seedTools(t, dir, "1", "2", "3")

	m := toolhub.NewToolManager(dir, nil)
	defer func() {
		for _, p := range m.Snapshot() {
			m.Delete(p.ID)
		}
	}()

	m.LoadAll(map[string]struct{}{"2": {}})

	got := m.Snapshot()
	if len(got) != 1 {
		ids := []string{}
		for _, p := range got {
			ids = append(ids, p.ID)
		}
		t.Fatalf("복원된 도구 = %v, want [2] 하나만", ids)
	}
	if got[0].ID != "2" {
		t.Errorf("복원된 도구 = %s, want 2", got[0].ID)
	}
}

func TestLoadAll_NilRefsRestoresNothing(t *testing.T) {
	// 참조 집합을 얻지 못한 경우(빈 workspace) 도구를 되살릴 근거가 없다.
	dir := toolTempDir(t)
	seedTools(t, dir, "1", "2")

	m := toolhub.NewToolManager(dir, nil)
	m.LoadAll(map[string]struct{}{})
	if got := len(m.Snapshot()); got != 0 {
		t.Errorf("복원된 도구 = %d, want 0", got)
	}
}

func TestLoadAll_AllReferencedRestoresAll(t *testing.T) {
	dir := toolTempDir(t)
	seedTools(t, dir, "5", "6")

	m := toolhub.NewToolManager(dir, nil)
	defer func() {
		for _, p := range m.Snapshot() {
			m.Delete(p.ID)
		}
	}()

	m.LoadAll(map[string]struct{}{"5": {}, "6": {}})
	if got := len(m.Snapshot()); got != 2 {
		t.Errorf("복원된 도구 = %d, want 2", got)
	}
}

func TestLoadAll_MissingFileIsNoop(t *testing.T) {
	dir := toolTempDir(t)
	m := toolhub.NewToolManager(dir, nil)
	m.LoadAll(map[string]struct{}{"1": {}})
	if got := len(m.Snapshot()); got != 0 {
		t.Errorf("복원된 도구 = %d, want 0", got)
	}
}
