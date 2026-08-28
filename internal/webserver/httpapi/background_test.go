package httpapi

import "dongminal/internal/shared/toolhub"

import (
	"fmt"
	"os"
	"testing"
	"time"
)

// toolTempDir 는 t.TempDir() 을 내주되, **비동기 기록이 멎은 뒤에** 정리되도록
// 한다.
//
// ToolManager.Create/Delete 는 `go m.SaveAll()` 로 tools.json 을 비동기 기록한다
// (tool.go:928·1008). SaveAll 은 dirty 를 내리지 않으므로 **이미 뜬 goroutine 은
// 반드시 쓴다** — 동기 SaveAll 을 한 번 더 불러도 그것들을 무력화하지 못한다.
// 그 쓰기가 TempDir 정리보다 늦으면 정리가 `directory not empty` 로 실패하고,
// **본문이 통과한 뒤에 테스트가 깨진다.** 전량 병렬 실행에서만 드러나며
// 2026-08-28 에 8회 중 1회 관측했다 (단독 실행 12회는 전부 통과).
//
// 기다리는 수단은 **결과물의 안정**이다 — 디렉터리 목록이 두 번 연속 같으면 밀린
// 쓰기가 없다고 본다. WS-2 가 TestToolManager_DeleteDetachedToolDoesNotPanic 을
// 같은 방식으로 닫았다.
//
// t.TempDir() **뒤에** Cleanup 을 등록하므로 LIFO 로 정리보다 먼저 돈다. 테스트
// 본문의 defer(도구 삭제)는 그보다도 먼저 끝나 있다.
func toolTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() { settleToolWrites(t, dir) })
	return dir
}

func settleToolWrites(t *testing.T, dir string) {
	t.Helper()
	prev, stable := "", 0
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		cur := dirFingerprint(dir)
		if cur == prev {
			if stable++; stable >= 2 {
				return
			}
		} else {
			stable = 0
		}
		prev = cur
		time.Sleep(20 * time.Millisecond)
	}
	t.Logf("경고: %s 의 비동기 쓰기가 멎지 않았다 — TempDir 정리가 실패할 수 있다", dir)
}

func dirFingerprint(dir string) string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return "err:" + err.Error()
	}
	out := ""
	for _, e := range ents {
		info, err := e.Info()
		if err != nil {
			out += e.Name() + ":?;"
			continue
		}
		out += fmt.Sprintf("%s:%d:%d;", e.Name(), info.Size(), info.ModTime().UnixNano())
	}
	return out
}

// FR-BG: 백그라운드 전환은 도구를 탭 생명주기에서 떼어낸다. 상태는 데몬
// 런타임에만 보관하고 tools.json 에는 기재하지 않는다 (FR-BG-9/10 — 재시작을
// 넘겨 복원하면 빈 셸만 되살아나고 고아가 누적된다).

func TestSetBackground_MarksAndLists(t *testing.T) {
	dir := toolTempDir(t)
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
	dir := toolTempDir(t)
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
	dir := toolTempDir(t)
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
	dir := toolTempDir(t)
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
	// Create 가 도구마다 띄운 `go m.SaveAll()`(tool.go:928)을 먼저 배수한다.
	// 그것들이 아래 동기 SaveAll **뒤에** 착지하면 그 시점의 상태를 덮어쓰고,
	// os.WriteFile 은 원자적이지 않아 m2 의 읽기와 겹치면 부분 파일을 읽는다.
	// 둘 다 본문 통과 뒤가 아니라 **단정 실패**로 나타난다.
	settleToolWrites(t, dir)
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

// FR-HLM-3: 위 규칙의 **예외 하나**. background 이면서 상위 도메인이 소유하는
// 도구는 기재된다.
//
// 이 테스트는 TestSaveAll_ExcludesBackgroundTools 와 **짝**이다. 둘이 함께
// 있어야 예외의 경계가 동작으로 고정된다 — 한쪽만 있으면 다음 사람이 규칙을
// 통째로 지워도(또는 예외를 통째로 지워도) 테스트가 울지 않는다.
//
// FR-EM-12/FR-BG-9 의 근거는 "소유자가 없어 되살아나도 아무도 거둘 수 없다" 이고,
// 헤드리스 멤버의 도구에는 Run 이라는 소유자가 있다. 그 차이가 예외의 전부다.
func TestSaveAll_KeepsOwnedBackgroundTools(t *testing.T) {
	dir := toolTempDir(t)
	m := toolhub.NewToolManager(dir, nil)
	defer func() {
		for _, p := range m.Snapshot() {
			m.Delete(p.ID)
		}
	}()

	plain, err := m.Create(dir, 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	owned, err := m.Create(dir, 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	// 둘 다 백그라운드다. 다른 것은 소유자뿐이다.
	m.SetBackground(plain.ID, true)
	m.SetBackground(owned.ID, true)
	m.SetOwnedTools(func() map[string]struct{} {
		return map[string]struct{}{owned.ID: {}}
	})
	// Create 가 도구마다 띄운 `go m.SaveAll()`(tool.go:928)을 먼저 배수한다.
	// 그것들이 아래 동기 SaveAll **뒤에** 착지하면 그 시점의 상태를 덮어쓰고,
	// os.WriteFile 은 원자적이지 않아 m2 의 읽기와 겹치면 부분 파일을 읽는다.
	// 둘 다 본문 통과 뒤가 아니라 **단정 실패**로 나타난다.
	settleToolWrites(t, dir)
	m.SaveAll()

	refs := map[string]struct{}{plain.ID: {}, owned.ID: {}}
	m2 := toolhub.NewToolManager(dir, nil)
	m2.LoadAll(refs)
	defer func() {
		for _, p := range m2.Snapshot() {
			m2.Delete(p.ID)
		}
	}()
	got := m2.Snapshot()
	if len(got) != 1 || got[0].ID != owned.ID {
		ids := []string{}
		for _, p := range got {
			ids = append(ids, p.ID)
		}
		t.Fatalf("복원된 도구 = %v, want [%s] — 소유된 도구만 살아남아야 한다", ids, owned.ID)
	}
}

// 소유 판별을 꽂지 않으면 동작은 이 기능이 없던 때와 **완전히 같다**. 배선을
// 빠뜨린 경로(테스트·데몬 초기화 등)가 조용히 다르게 동작하지 않아야 한다.
func TestSaveAll_NoOwnerProbeKeepsLegacyBehavior(t *testing.T) {
	dir := toolTempDir(t)
	m := toolhub.NewToolManager(dir, nil)
	defer func() {
		for _, p := range m.Snapshot() {
			m.Delete(p.ID)
		}
	}()

	bg, err := m.Create(dir, 80, 24)
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	m.SetBackground(bg.ID, true)
	settleToolWrites(t, dir) // Create 가 띄운 비동기 저장을 먼저 배수한다
	m.SaveAll()              // SetOwnedTools 를 부르지 않는다

	m2 := toolhub.NewToolManager(dir, nil)
	m2.LoadAll(map[string]struct{}{bg.ID: {}})
	defer func() {
		for _, p := range m2.Snapshot() {
			m2.Delete(p.ID)
		}
	}()
	if got := m2.Snapshot(); len(got) != 0 {
		t.Fatalf("소유 판별 없이 백그라운드 도구가 기재됐다: %d개", len(got))
	}
}
