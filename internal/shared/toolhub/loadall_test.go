package toolhub

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// `TEST-2`(PRODUCTION_ROADMAP §M3) — **데몬 재기동 복원 경로.**
//
// 이 경로에는 검사가 없었다. 그런데 여기가 틀리면 두 가지가 일어난다:
// 사용자의 탭이 빈 채로 돌아오거나(복원 실패), 부팅마다 셸이 누적된다
// (미참조 도구를 되살림 — FR-EM-14).
//
// **진짜 PTY 를 띄우지 않는다.** `Restore` 를 갈아 끼워 "무엇을 되살리려 했는가"
// 만 잰다 — 이 검사가 묻는 것은 셸이 뜨는가가 아니라 **고르는 규칙**이다.

func seedTools(t *testing.T, dir string, states []ToolState) {
	t.Helper()
	blob, err := json.Marshal(states)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tools.json"), blob, 0o644); err != nil {
		t.Fatal(err)
	}
}

// 참조된 것만 되살린다 (FR-EM-14).
func TestLoadAllRestoresOnlyReferenced(t *testing.T) {
	dir := t.TempDir()
	seedTools(t, dir, []ToolState{
		{ID: "keep", Name: "a", Cwd: dir},
		{ID: "orphan", Name: "b", Cwd: dir},
	})
	m := NewToolManager(dir, nil)
	t.Cleanup(m.StopSaving)

	var tried []string
	restore := func(id, name, cwd string, cols, rows uint16) error {
		tried = append(tried, id)
		return nil
	}
	m.LoadAllWith(map[string]struct{}{"keep": {}}, restore)

	if len(tried) != 1 || tried[0] != "keep" {
		t.Fatalf("되살리려 한 것=%v want [keep] — 미참조를 되살리면 부팅마다 셸이 쌓인다", tried)
	}
}

// 하나가 실패해도 **나머지는 되살린다.** 첫 실패에서 멈추면 그 뒤의 탭이 전부
// 빈 채로 돌아온다.
func TestLoadAllContinuesAfterFailure(t *testing.T) {
	dir := t.TempDir()
	seedTools(t, dir, []ToolState{
		{ID: "bad", Name: "a", Cwd: dir},
		{ID: "good", Name: "b", Cwd: dir},
	})
	m := NewToolManager(dir, nil)
	t.Cleanup(m.StopSaving)

	var tried []string
	restore := func(id, name, cwd string, cols, rows uint16) error {
		tried = append(tried, id)
		if id == "bad" {
			return os.ErrPermission
		}
		return nil
	}
	m.LoadAllWith(map[string]struct{}{"bad": {}, "good": {}}, restore)

	if len(tried) != 2 {
		t.Fatalf("시도=%v — 하나가 실패하자 멈췄다", tried)
	}
}

// 파일이 없으면 조용히 지나간다 — 첫 기동의 정상 상태다.
func TestLoadAllWithoutFile(t *testing.T) {
	dir := t.TempDir()
	m := NewToolManager(dir, nil)
	t.Cleanup(m.StopSaving)
	m.LoadAllWith(map[string]struct{}{"x": {}}, func(string, string, string, uint16, uint16) error {
		t.Fatal("파일이 없는데 되살리려 했다")
		return nil
	})
}

// 깨진 파일도 기동을 막지 않는다 — 되살릴 것이 없을 뿐이다.
func TestLoadAllWithCorruptFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tools.json"), []byte("{ broken"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := NewToolManager(dir, nil)
	t.Cleanup(m.StopSaving)
	m.LoadAllWith(map[string]struct{}{"x": {}}, func(string, string, string, uint16, uint16) error {
		t.Fatal("깨진 파일에서 되살리려 했다")
		return nil
	})
}
