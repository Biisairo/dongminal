package httpapi

import "dongminal/internal/shared/toolhub"

import "testing"

// FR-BG: 백그라운드 전환은 도구를 탭 생명주기에서 떼어낸다. 상태는 데몬
// 런타임에만 보관하고 tools.json 에는 기재하지 않는다 (FR-BG-9/10 — 재시작을
// 넘겨 복원하면 빈 셸만 되살아나고 고아가 누적된다).

func TestSetBackground_MarksAndLists(t *testing.T) {
	dir := t.TempDir()
	m := toolhub.NewToolManager(dir, nil)
	defer func() {
		for _, p := range m.Snapshot() {
			m.Delete(p.ID)
		}
	}()

	tl, err := m.Create(dir, 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	if got := m.BackgroundList(); len(got) != 0 {
		t.Fatalf("초기 백그라운드 목록 = %v, want 없음", got)
	}
	if !m.SetBackground(tl.ID, true) {
		t.Fatal("SetBackground 가 false 반환")
	}
	got := m.BackgroundList()
	if len(got) != 1 || got[0].ToolID != tl.ID {
		t.Fatalf("백그라운드 목록 = %+v, want [%s]", got, tl.ID)
	}
	if got[0].Since == 0 {
		t.Error("전환 시각이 기록되지 않음")
	}
	if !m.IsBackground(tl.ID) {
		t.Error("IsBackground = false")
	}
}

func TestSetBackground_RestoreClearsFlag(t *testing.T) {
	dir := t.TempDir()
	m := toolhub.NewToolManager(dir, nil)
	defer func() {
		for _, p := range m.Snapshot() {
			m.Delete(p.ID)
		}
	}()

	tl, err := m.Create(dir, 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	m.SetBackground(tl.ID, true)
	if !m.SetBackground(tl.ID, false) {
		t.Fatal("복귀 전환 실패")
	}
	if m.IsBackground(tl.ID) {
		t.Error("복귀 후에도 IsBackground = true")
	}
	if got := m.BackgroundList(); len(got) != 0 {
		t.Errorf("복귀 후 목록 = %+v, want 없음", got)
	}
}

func TestSetBackground_UnknownToolIsNoop(t *testing.T) {
	m := toolhub.NewToolManager(t.TempDir(), nil)
	if m.SetBackground("nope", true) {
		t.Error("존재하지 않는 도구에 true 반환")
	}
	if m.IsBackground("nope") {
		t.Error("존재하지 않는 도구가 백그라운드로 보고됨")
	}
}

func TestSetBackground_DeleteRemovesFromList(t *testing.T) {
	dir := t.TempDir()
	m := toolhub.NewToolManager(dir, nil)
	tl, err := m.Create(dir, 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	m.SetBackground(tl.ID, true)
	m.Delete(tl.ID)
	if got := m.BackgroundList(); len(got) != 0 {
		t.Errorf("종료 후 목록 = %+v, want 없음", got)
	}
}

// FR-BG-9/FR-EM-12: 백그라운드 도구는 tools.json 에 기재되지 않는다.
func TestSaveAll_ExcludesBackgroundTools(t *testing.T) {
	dir := t.TempDir()
	m := toolhub.NewToolManager(dir, nil)
	defer func() {
		for _, p := range m.Snapshot() {
			m.Delete(p.ID)
		}
	}()

	keep, err := m.Create(dir, 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	bg, err := m.Create(dir, 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	m.SetBackground(bg.ID, true)
	m.SaveAll()

	refs := map[string]struct{}{keep.ID: {}, bg.ID: {}}
	m2 := toolhub.NewToolManager(dir, nil)
	m2.LoadAll(refs)
	defer func() {
		for _, p := range m2.Snapshot() {
			m2.Delete(p.ID)
		}
	}()
	got := m2.Snapshot()
	if len(got) != 1 || got[0].ID != keep.ID {
		ids := []string{}
		for _, p := range got {
			ids = append(ids, p.ID)
		}
		t.Errorf("복원된 도구 = %v, want [%s] — 백그라운드 도구가 기재됨", ids, keep.ID)
	}
}
