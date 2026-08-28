package run

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// 묶음 H — 저장소 절반의 검증 (ORCHESTRATION_V2_SRS §3.2.2).
//
// 여기서 고정하는 것은 FR-HLM-8 이다: 부착·분리는 TabID·Headless 말고는 아무것도
// 건드리지 않는다. 관찰 행위가 관찰 대상을 바꾸지 않는다.

func headlessStore(t *testing.T) (*Store, string) {
	t.Helper()
	s := NewStore(t.TempDir(), "epoch-h")
	if err := s.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	rec, err := s.Start(StartOptions{Objective: "팬아웃", Projection: Inline, Isolation: IsolationNone})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	return s, rec.ID
}

func addHeadlessMember(t *testing.T, s *Store, runID, toolID string) Member {
	t.Helper()
	m, err := s.AddMember(runID, MemberSpec{
		Role: "writer", Agent: "claude", ToolID: toolID, Headless: true,
	})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	return m
}

// FR-HLM-2: Headless 는 MemberSpec 에서 기록으로 그대로 옮겨진다.
func TestAddMember_CarriesHeadless(t *testing.T) {
	s, runID := headlessStore(t)
	m := addHeadlessMember(t, s, runID, "tool-h")
	if !m.Headless || m.TabID != "" {
		t.Fatalf("헤드리스 멤버가 아니다: %+v", m)
	}
}

// FR-HLM-6/7/8: 왕복해도 관측은 그대로다.
func TestAttachDetach_TouchesOnlyTabBinding(t *testing.T) {
	s, runID := headlessStore(t)
	m := addHeadlessMember(t, s, runID, "tool-h")

	// 관측을 채워 둔다 — 부착이 이것들을 건드리면 안 된다.
	if _, err := s.Report("tool-h", ReportSpec{
		RunID: runID, MemberID: m.ID, Outcome: OutcomeSucceeded, Summary: "했다. 봤다. 남았다.",
	}); err != nil {
		t.Fatalf("Report: %v", err)
	}
	_, before, ok := s.FindMember(m.ID)
	if !ok {
		t.Fatal("멤버가 사라졌다")
	}

	_, attached, err := s.Attach(m.ID, "tab-x")
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if attached.TabID != "tab-x" || attached.Headless {
		t.Fatalf("부착 결과가 어긋난다: %+v", attached)
	}
	assertOnlyBindingChanged(t, "attach", before, attached)

	_, detached, err := s.Detach(m.ID)
	if err != nil {
		t.Fatalf("Detach: %v", err)
	}
	if detached.TabID != "" || !detached.Headless {
		t.Fatalf("분리 결과가 어긋난다: %+v", detached)
	}
	assertOnlyBindingChanged(t, "detach", before, detached)

	// 왕복하면 처음과 완전히 같다.
	if !reflect.DeepEqual(detached, before) {
		t.Fatalf("왕복 후 멤버가 달라졌다\n  전: %+v\n  후: %+v", before, detached)
	}
}

// assertOnlyBindingChanged 는 TabID·Headless 를 맞춘 뒤 나머지 전 필드를 비교한다.
// 필드를 하나씩 세지 않는 이유는 묶음 C·V 가 앞으로 더 넣을 것이기 때문이다 —
// 구조체 비교는 새 필드를 자동으로 지킨다.
func assertOnlyBindingChanged(t *testing.T, verb string, before, after Member) {
	t.Helper()
	normalized := after
	normalized.TabID, normalized.Headless = before.TabID, before.Headless
	if !reflect.DeepEqual(normalized, before) {
		t.Fatalf("%s 가 탭 결속 밖을 바꿨다 (FR-HLM-8)\n  전: %+v\n  후: %+v", verb, before, after)
	}
}

// 거부는 열거된다.
func TestAttachDetach_Refusals(t *testing.T) {
	s, runID := headlessStore(t)
	m := addHeadlessMember(t, s, runID, "tool-h")

	if _, _, err := s.Attach("no-such", "tab-x"); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("없는 멤버 want unknown_member, got %v", err)
	}
	if _, _, err := s.Detach("no-such"); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("없는 멤버 want unknown_member, got %v", err)
	}
	if _, _, err := s.Attach(m.ID, ""); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("빈 tabID want invalid_argument, got %v", err)
	}
	if _, _, err := s.Detach(m.ID); !errors.Is(err, ErrMemberNotAttached) {
		t.Fatalf("헤드리스 분리 want member_not_attached, got %v", err)
	}
	if _, _, err := s.Attach(m.ID, "tab-x"); err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if _, _, err := s.Attach(m.ID, "tab-y"); !errors.Is(err, ErrMemberAttached) {
		t.Fatalf("재부착 want member_attached, got %v", err)
	}
	// 거부된 부착은 기록을 고치지 않는다.
	if _, got, _ := s.FindMember(m.ID); got.TabID != "tab-x" {
		t.Fatalf("거부된 부착이 결속을 바꿨다: %+v", got)
	}
}

// 부착·분리는 영속된다 — 데몬을 다시 읽어도 같은 사실이 남는다.
func TestAttachDetach_Persists(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-h")
	if err := s.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	rec, err := s.Start(StartOptions{Objective: "o", Projection: Inline, Isolation: IsolationNone})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	m := addHeadlessMember(t, s, rec.ID, "tool-h")
	if _, _, err := s.Attach(m.ID, "tab-x"); err != nil {
		t.Fatalf("Attach: %v", err)
	}

	reopened := NewStore(dir, "epoch-h")
	if err := reopened.Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	_, got, ok := reopened.FindMember(m.ID)
	if !ok {
		t.Fatal("다시 읽은 저장소에 멤버가 없다")
	}
	if got.TabID != "tab-x" || got.Headless {
		t.Fatalf("부착이 영속되지 않았다: %+v", got)
	}
}

// FR-HLM-4/5: 탭을 가진 멤버는 헤드리스 도구가 아니다 — 화면에 있는 것을
// 서버가 말없이 죽이지 않는다.
func TestHeadlessTool_ExcludesAttachedMembers(t *testing.T) {
	s, runID := headlessStore(t)
	h := addHeadlessMember(t, s, runID, "tool-h")
	tabbed, err := s.AddMember(runID, MemberSpec{
		Role: "reader", Agent: "claude", ToolID: "tool-t", TabID: "tab-t",
	})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	if !h.HeadlessTool() {
		t.Fatalf("헤드리스 멤버가 헤드리스 도구를 갖지 않는다: %+v", h)
	}
	if tabbed.HeadlessTool() {
		t.Fatalf("탭 부착 멤버가 헤드리스 도구로 세어졌다: %+v", tabbed)
	}

	// 부착하면 빠진다.
	_, attached, err := s.Attach(h.ID, "tab-h")
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if attached.HeadlessTool() {
		t.Fatalf("부착한 멤버가 여전히 헤드리스 도구다: %+v", attached)
	}
}

// 끝난 Run 의 멤버도 부착할 수 있다 — 고아를 진단할 유일한 길이다 (FR-HLM-5).
func TestAttach_WorksOnClosedRun(t *testing.T) {
	s, runID := headlessStore(t)
	m := addHeadlessMember(t, s, runID, "tool-h")
	if _, _, err := s.Close(runID, true); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, _, err := s.Attach(m.ID, "tab-x"); err != nil {
		t.Fatalf("끝난 Run 의 고아를 부착할 수 없다: %v", err)
	}
}

// ── FR-HLM-3: 재시작을 넘길 도구를 고르는 규칙 ──

// 열린 Run 의 헤드리스 도구만 고른다. 끝난 Run 의 도구는 FR-HLM-5 의 고아이며,
// 고아를 부팅마다 되살리면 영원히 쌓인다.
func TestHeadlessToolIDs_OnlyOpenRuns(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-h")
	if err := s.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}

	open, err := s.Start(StartOptions{Objective: "열린", Projection: Inline, Isolation: IsolationNone})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	addHeadlessMember(t, s, open.ID, "tool-open")

	closed, err := s.Start(StartOptions{Objective: "닫힌", Projection: Inline, Isolation: IsolationNone})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	addHeadlessMember(t, s, closed.ID, "tool-closed")
	if _, _, err := s.Close(closed.ID, true); err != nil {
		t.Fatalf("close: %v", err)
	}

	got := HeadlessToolIDs(dir)
	if _, ok := got["tool-open"]; !ok {
		t.Fatalf("열린 Run 의 도구가 빠졌다: %v", got)
	}
	if _, ok := got["tool-closed"]; ok {
		t.Fatalf("끝난 Run 의 고아가 부활 대상에 들어갔다: %v", got)
	}
}

// 탭에 붙은 멤버는 되살릴 대상이 아니다 — 그 도구는 워크스페이스 참조가 이미
// 책임진다 (FR-EM-14). 양쪽이 다 세면 근거가 둘이 된다.
func TestHeadlessToolIDs_SkipsTabbedMembers(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-h")
	if err := s.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	rec, err := s.Start(StartOptions{Objective: "o", Projection: Inline, Isolation: IsolationNone})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	h := addHeadlessMember(t, s, rec.ID, "tool-h")
	if _, err := s.AddMember(rec.ID, MemberSpec{
		Role: "작가", Agent: "claude", ToolID: "tool-t", TabID: "tab-t",
	}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	got := HeadlessToolIDs(dir)
	if len(got) != 1 {
		t.Fatalf("대상 = %v, want [tool-h] 하나", got)
	}
	if _, ok := got["tool-h"]; !ok {
		t.Fatalf("헤드리스 도구가 빠졌다: %v", got)
	}

	// 부착하면 대상에서 빠진다 — 화면에 있는 것은 워크스페이스가 책임진다.
	if _, _, err := s.Attach(h.ID, "tab-h"); err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if got := HeadlessToolIDs(dir); len(got) != 0 {
		t.Fatalf("부착한 멤버가 부활 대상에 남았다: %v", got)
	}
}

// **펜싱 전에 물어야 한다.** Load 는 이전 세대가 열어 둔 Run 을 aborted 로
// 확정하므로(FR-RUN-5), 그 뒤에 물으면 되살릴 대상이 하나도 없다. 이 테스트가
// 부팅 배선의 호출 순서를 고정한다.
func TestHeadlessToolIDs_MustBeReadBeforeFencing(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-1")
	if err := s.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	rec, err := s.Start(StartOptions{Objective: "o", Projection: Inline, Isolation: IsolationNone})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	addHeadlessMember(t, s, rec.ID, "tool-h")

	// 재기동 직전 — 아직 열려 있다.
	before := HeadlessToolIDs(dir)
	if _, ok := before["tool-h"]; !ok {
		t.Fatalf("펜싱 전에 대상이 아니다: %v", before)
	}

	// 새 세대가 Load 하면 펜싱이 돈다.
	next := NewStore(dir, "epoch-2")
	if err := next.Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got, _ := next.Get(rec.ID); got.State != Aborted {
		t.Fatalf("재기동이 Run 을 aborted 로 만들지 않았다: %s", got.State)
	}
	// 그 뒤에 물으면 비어 있다 — 배선이 순서를 지켜야 하는 이유가 이것이다.
	if after := HeadlessToolIDs(dir); len(after) != 0 {
		t.Fatalf("펜싱 후에도 대상이 남았다 — 이 테스트의 전제가 깨졌다: %v", after)
	}
}

// 파일이 없거나 깨졌으면 빈 집합이다. 되살리지 못하는 것보다 닿을 수 없는 셸을
// 늘리는 쪽이 나쁘다 (FR-EM-14 와 같은 판단).
func TestHeadlessToolIDs_FailuresAreEmpty(t *testing.T) {
	if got := HeadlessToolIDs(t.TempDir()); len(got) != 0 {
		t.Fatalf("파일 없음 = %v, want 빈 집합", got)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte("{깨진"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := HeadlessToolIDs(dir); len(got) != 0 {
		t.Fatalf("깨진 파일 = %v, want 빈 집합", got)
	}
}
