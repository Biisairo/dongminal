package httpapi

import (
	"dongminal/internal/shared/toolhub"

	"regexp"
	"testing"
)

// WORKSPACE_IDENTITY_SRS §4 묶음 U — toolId 는 uuid 다 (FR-UNI-7~9).
//
// 이전: toolId 가 서버 프로세스 카운터(m.nextID++)였고 영속되지 않아, 모든 도구가
// 닫힌 상태로 재기동하면 "1" 부터 재사용됐다 (SRS §2.7 (3)).

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// TC-UNI-5: 도구 2개의 toolId 가 모두 uuid 형식이고 서로 다르다.
func TestToolCreate_IDIsUUID(t *testing.T) {
	m := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(m.WaitSaves)
	defer closeAllTools(m)

	a, err := m.Create(t.TempDir(), 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	b, err := m.Create(t.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("create b: %v", err)
	}

	for _, id := range []string{a.ID, b.ID} {
		if !uuidRe.MatchString(id) {
			t.Errorf("toolId=%q 가 uuid 형식이 아니다", id)
		}
	}
	if a.ID == b.ID {
		t.Errorf("두 toolId 가 같다: %q", a.ID)
	}
}

// TC-UNI-6: 도구를 전부 닫고 새 toolhub.ToolManager 를 띄운 뒤 만든 toolId 가 이전 세션의
// 어떤 toolId 와도 같지 않다. 카운터 시절에는 둘 다 "1" 이었다.
func TestToolCreate_NoIDReuseAcrossRestart(t *testing.T) {
	dir := toolTempDir(t)

	first := toolhub.NewToolManager(dir, nil)
	t.Cleanup(first.WaitSaves)
	p, err := first.Create(t.TempDir(), 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	oldID := p.ID
	closeAllTools(first)

	// 도구가 하나도 복원되지 않는 재기동 (tools.json 이 비었거나 없는 상태).
	second := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(second.WaitSaves)
	defer closeAllTools(second)
	q, err := second.Create(t.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("create after restart: %v", err)
	}

	if q.ID == oldID {
		t.Errorf("재기동 후 toolId 가 재사용됐다: %q", q.ID)
	}
}

// TC-UNI-7: 표시명은 id 와 분리돼 있다 — "Shell" 고정 (FR-UNI-8).
func TestToolCreate_NameIsIndependentOfID(t *testing.T) {
	m := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(m.WaitSaves)
	defer closeAllTools(m)

	p, err := m.Create(t.TempDir(), 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	if p.Name != "Shell" {
		t.Errorf("Name=%q, want %q", p.Name, "Shell")
	}
}

// TC-UNI-8: 구 정수 toolId 를 복원한 뒤 새로 만들어도 구 id 는 보존되고 신규만
// uuid 다 — 혼재가 정상이다 (FR-UNI-9).
func TestToolRestore_LegacyIntegerIDCoexists(t *testing.T) {
	m := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(m.WaitSaves)
	defer closeAllTools(m)

	if err := m.Restore("267", "Shell #267", t.TempDir(), 80, 24); err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	if got := m.Get("267"); got == nil {
		t.Fatal("구 정수 id 로 복원한 도구를 찾을 수 없다")
	}

	fresh, err := m.Create(t.TempDir(), 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	if !uuidRe.MatchString(fresh.ID) {
		t.Errorf("신규 toolId=%q 가 uuid 형식이 아니다", fresh.ID)
	}
	if m.Get("267") == nil {
		t.Error("신규 생성 후 구 id 가 사라졌다")
	}
}

// closeAllTools 는 테스트 종료 시 PTY 를 회수한다. 누수는 kern.tty.ptmx_max(511)를
// 소진해 다른 테스트를 무너뜨린다 (ENTITY_MODEL_HANDOFF §6 함정 6).
func closeAllTools(m *toolhub.ToolManager) {
	for _, p := range m.Snapshot() {
		m.Delete(p.ID)
	}
}
