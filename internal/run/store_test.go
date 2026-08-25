package run

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 묶음 R — Run 레코드 (RUN_ORCHESTRATION_SRS §3.1, TC-RUN-1~11).

// newTestStore builds a store over a temp dir with deterministic id/clock so
// assertions can name exact values.
func newTestStore(t *testing.T, epoch string) *Store {
	t.Helper()
	n := 0
	var clock int64 = 1000
	s := NewStore(t.TempDir(), epoch,
		WithIDGen(func() string {
			n++
			// canonical uuid 형태 — FR-UNI-1 을 흉내내되 결정적이다.
			return "00000000-0000-7000-8000-" + strings.Repeat("0", 11) + string(rune('0'+n))
		}),
		WithClock(func() int64 { clock++; return clock }),
	)
	if err := s.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	return s
}

// TC-RUN-1 (FR-RUN-1/3): 시작한 Run 이 프로토타입 필드 이름 그대로 영속된다.
func TestStore_StartPersists(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-1")
	if err := s.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	rec, err := s.Start(StartOptions{Objective: "리서치 팬아웃", Projection: DedicatedWindow, Isolation: IsolationNone, CoordinatorToolID: "t1"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if rec.State != Open || rec.Epoch != "epoch-1" {
		t.Fatalf("새 Run 은 현재 epoch 의 open 이어야 한다: %+v", rec)
	}
	if len(rec.Short) != 8 || !strings.HasPrefix(rec.ID, rec.Short) {
		t.Fatalf("short 는 id 앞 8자 파생값이다: %+v", rec)
	}

	blob, err := os.ReadFile(filepath.Join(dir, "runs.json"))
	if err != nil {
		t.Fatalf("runs.json 이 없다: %v", err)
	}
	var f struct {
		SchemaVersion int              `json:"schemaVersion"`
		Runs          []map[string]any `json:"runs"`
	}
	if err := json.Unmarshal(blob, &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if f.SchemaVersion != 1 {
		t.Fatalf("schemaVersion 은 1 을 유지한다, got %d", f.SchemaVersion)
	}
	// 기존 프로토타입이 쓰던 키 이름을 보존해야 한다 (§2.1).
	for _, k := range []string{"id", "short", "objective", "projection", "isolation", "state", "createdAt"} {
		if _, ok := f.Runs[0][k]; !ok {
			t.Fatalf("프로토타입 필드 %q 가 사라졌다: %+v", k, f.Runs[0])
		}
	}
}

// FR-RUN-1: 투영·격리 값은 검증한다. 알 수 없는 값이 조용히 저장되면 안 된다.
func TestStore_StartValidates(t *testing.T) {
	s := newTestStore(t, "e")
	if _, err := s.Start(StartOptions{Objective: "x", Projection: "sideways", Isolation: IsolationNone}); err == nil {
		t.Fatal("알 수 없는 projection 이 통과했다")
	}
	if _, err := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: "sandbox"}); err == nil {
		t.Fatal("알 수 없는 isolation 이 통과했다")
	}
	if _, err := s.Start(StartOptions{Objective: "  ", Projection: Inline, Isolation: IsolationNone}); err == nil {
		t.Fatal("빈 objective 가 통과했다")
	}
}

// TC-RUN-1: 재로드하면 같은 내용이 돌아온다.
func TestStore_Reload(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "e1")
	_ = s.Load()
	rec, _ := s.Start(StartOptions{Objective: "obj", Projection: Inline, Isolation: IsolationNone})
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "writer", Agent: "claude", ToolID: "tool-1", TabID: "tab-1"}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	s2 := NewStore(dir, "e1")
	if err := s2.Load(); err != nil {
		t.Fatalf("reload: %v", err)
	}
	got, ok := s2.Get(rec.ID)
	if !ok || got.Objective != "obj" || len(got.Members) != 1 || got.Members[0].Role != "writer" {
		t.Fatalf("재로드 결과가 다르다: %+v", got)
	}
}

// TC-RUN-3 (FR-RUN-4): 손상된 파일은 빈 상태로 시작하고 부팅을 막지 않는다.
func TestStore_CorruptFileStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "runs.json"), []byte("{ this is not json"), 0644); err != nil {
		t.Fatal(err)
	}
	s := NewStore(dir, "e1")
	if err := s.Load(); err != nil {
		t.Fatalf("손상된 파일이 Load 를 실패시켰다: %v", err)
	}
	if len(s.List()) != 0 {
		t.Fatalf("손상된 파일에서 Run 이 나왔다: %+v", s.List())
	}
	// 그리고 계속 쓸 수 있어야 한다.
	if _, err := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone}); err != nil {
		t.Fatalf("손상 복구 후 Start 실패: %v", err)
	}
}

// FR-RUN-4: 파일이 없는 것은 정상이다 (NFR-RUN-1/2).
func TestStore_MissingFileIsNormal(t *testing.T) {
	s := NewStore(t.TempDir(), "e1")
	if err := s.Load(); err != nil {
		t.Fatalf("파일 부재가 오류가 됐다: %v", err)
	}
	if len(s.List()) != 0 {
		t.Fatal("빈 목록이어야 한다")
	}
}

// TC-RUN-2 (FR-RUN-4): 쓰기는 원자적이다 — 임시 파일을 남기지 않는다.
func TestStore_AtomicWriteLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "e1")
	_ = s.Load()
	if _, err := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone}); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if e.Name() != "runs.json" {
			t.Fatalf("잔여 파일이 남았다: %s", e.Name())
		}
	}
}

// TC-RUN-4 (FR-RUN-5): 이전 epoch 의 open Run 은 로드 시 aborted 로 확정된다.
func TestStore_EpochFencing(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-1")
	_ = s.Load()
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})

	s2 := NewStore(dir, "epoch-2")
	if err := s2.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	got, _ := s2.Get(rec.ID)
	if got.State != Aborted {
		t.Fatalf("이전 세대 Run 은 aborted 여야 한다: %+v", got)
	}
	if got.AbortReason != AbortDaemonRestart {
		t.Fatalf("abortReason 이 없다: %+v", got)
	}
	if got.ClosedAt == 0 {
		t.Fatal("aborted 는 종료 시각을 가져야 한다")
	}
	// 펜싱은 영속돼야 한다 — 다음 로드에서 되살아나면 안 된다.
	s3 := NewStore(dir, "epoch-2")
	_ = s3.Load()
	if g, _ := s3.Get(rec.ID); g.State != Aborted {
		t.Fatalf("펜싱이 저장되지 않았다: %+v", g)
	}
}

// FR-RUN-5: 같은 epoch 의 Run 은 건드리지 않는다 (재로드는 펜싱이 아니다).
func TestStore_SameEpochSurvivesReload(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-1")
	_ = s.Load()
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})

	s2 := NewStore(dir, "epoch-1")
	_ = s2.Load()
	if got, _ := s2.Get(rec.ID); got.State != Open {
		t.Fatalf("같은 epoch 의 Run 이 닫혔다: %+v", got)
	}
}

// FR-RUN-5: 이미 닫힌 Run 은 펜싱 대상이 아니다 (종료 사유를 덮지 않는다).
func TestStore_FencingLeavesClosedRunsAlone(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "epoch-1")
	_ = s.Load()
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})
	if _, _, err := s.Close(rec.ID, false); err != nil {
		t.Fatalf("Close: %v", err)
	}

	s2 := NewStore(dir, "epoch-2")
	_ = s2.Load()
	got, _ := s2.Get(rec.ID)
	if got.State != Closed || got.AbortReason != "" {
		t.Fatalf("닫힌 Run 이 펜싱에 걸렸다: %+v", got)
	}
}

// FR-RUN-2: 멤버는 uuid 를 받고 도구와 1:1 이다.
func TestStore_AddMember(t *testing.T) {
	s := newTestStore(t, "e")
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})

	m, err := s.AddMember(rec.ID, MemberSpec{Role: "writer", Agent: "claude", ToolID: "tool-1", TabID: "tab-1"})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if m.ID == "" || m.State != Starting {
		t.Fatalf("새 멤버는 id 와 starting 상태를 가져야 한다: %+v", m)
	}

	// 같은 도구를 두 번 등록하면 1:1 이 깨진다.
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "other", Agent: "claude", ToolID: "tool-1"}); !errors.Is(err, ErrToolAlreadyMember) {
		t.Fatalf("도구 중복 등록이 통과했다: %v", err)
	}
	// 닫힌 Run 에는 붙일 수 없다.
	_, _, _ = s.Close(rec.ID, true)
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "late", Agent: "claude", ToolID: "tool-2"}); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("닫힌 Run 에 멤버가 붙었다: %v", err)
	}
	if _, err := s.AddMember("no-such-run", MemberSpec{Role: "r", Agent: "claude", ToolID: "tool-3"}); !errors.Is(err, ErrUnknownRun) {
		t.Fatalf("없는 Run 이 통과했다: %v", err)
	}
}

// FR-RUN-2: 역할·에이전트·도구는 필수다.
func TestStore_AddMemberValidates(t *testing.T) {
	s := newTestStore(t, "e")
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})
	for _, spec := range []MemberSpec{
		{Role: "", Agent: "claude", ToolID: "t"},
		{Role: "r", Agent: "", ToolID: "t"},
		{Role: "r", Agent: "claude", ToolID: ""},
	} {
		if _, err := s.AddMember(rec.ID, spec); err == nil {
			t.Fatalf("불완전한 멤버가 통과했다: %+v", spec)
		}
	}
}

// FR-PRE-5: 보고의 권한은 발신 도구의 정체다. 페이로드를 아는 것은 권한이 아니다.
func TestStore_ReportAuthorityIsTheSender(t *testing.T) {
	s := newTestStore(t, "e")
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})
	mine, _ := s.AddMember(rec.ID, MemberSpec{Role: "a", Agent: "claude", ToolID: "tool-a"})
	other, _ := s.AddMember(rec.ID, MemberSpec{Role: "b", Agent: "claude", ToolID: "tool-b"})

	// 남의 memberId 를 알고 있어도 자기 도구로만 보고할 수 있다.
	if _, err := s.Report("tool-a", ReportSpec{RunID: rec.ID, MemberID: other.ID, Outcome: OutcomeSucceeded, Summary: "s"}); !errors.Is(err, ErrRunMemberMismatch) {
		t.Fatalf("남의 memberId 로 보고가 통과했다: %v", err)
	}
	// 멤버가 아닌 도구는 거부된다.
	if _, err := s.Report("tool-zzz", ReportSpec{Outcome: OutcomeSucceeded, Summary: "s"}); !errors.Is(err, ErrSenderNotMember) {
		t.Fatalf("비멤버 보고가 통과했다: %v", err)
	}
	// 자기 도구 + 자기 memberId 는 통과한다.
	got, err := s.Report("tool-a", ReportSpec{RunID: rec.ID, MemberID: mine.ID, Outcome: OutcomeSucceeded, Summary: "했다. 봤다. 남았다."})
	if err != nil {
		t.Fatalf("정당한 보고가 거부됐다: %v", err)
	}
	if got.State != Done || got.Outcome != OutcomeSucceeded || got.ReportedAt == 0 {
		t.Fatalf("보고 결과가 기록되지 않았다: %+v", got)
	}
	// id 를 생략해도 발신자로 결정된다 — 대조용일 뿐이다.
	if _, err := s.Report("tool-b", ReportSpec{Outcome: OutcomeFailed, Summary: "막혔다"}); err != nil {
		t.Fatalf("id 생략 보고가 실패했다: %v", err)
	}
	if m, _ := s.MemberByTool("tool-b"); m.State != Failed || m.Outcome != OutcomeFailed {
		t.Fatalf("failed 보고가 기록되지 않았다: %+v", m)
	}
}

// FR-PRE-3/7: outcome 은 명시해야 하고, 보고는 정확히 한 번이다.
func TestStore_ReportRules(t *testing.T) {
	s := newTestStore(t, "e")
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})
	_, _ = s.AddMember(rec.ID, MemberSpec{Role: "a", Agent: "claude", ToolID: "tool-a"})

	if _, err := s.Report("tool-a", ReportSpec{Outcome: "", Summary: "s"}); err == nil {
		t.Fatal("outcome 없는 보고가 통과했다")
	}
	if _, err := s.Report("tool-a", ReportSpec{Outcome: "kinda", Summary: "s"}); err == nil {
		t.Fatal("알 수 없는 outcome 이 통과했다")
	}
	if _, err := s.Report("tool-a", ReportSpec{Outcome: OutcomeSucceeded, Summary: ""}); err == nil {
		t.Fatal("빈 요약이 통과했다 — 조정자가 먼저 읽는 것이다")
	}
	if _, err := s.Report("tool-a", ReportSpec{Outcome: OutcomeSucceeded, Summary: "ok"}); err != nil {
		t.Fatalf("첫 보고가 실패했다: %v", err)
	}
	if _, err := s.Report("tool-a", ReportSpec{Outcome: OutcomeSucceeded, Summary: "또"}); !errors.Is(err, ErrAlreadyReported) {
		t.Fatalf("재보고가 통과했다: %v", err)
	}
}

// FR-RUN-11: 미보고 멤버가 있으면 close 는 거부하고 목록을 낸다. --force 로만 넘어간다.
func TestStore_CloseGuard(t *testing.T) {
	s := newTestStore(t, "e")
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})
	_, _ = s.AddMember(rec.ID, MemberSpec{Role: "a", Agent: "claude", ToolID: "tool-a"})
	_, _ = s.AddMember(rec.ID, MemberSpec{Role: "b", Agent: "claude", ToolID: "tool-b"})
	_, _ = s.Report("tool-a", ReportSpec{Outcome: OutcomeSucceeded, Summary: "ok"})

	_, pending, err := s.Close(rec.ID, false)
	if !errors.Is(err, ErrUnreportedMembers) {
		t.Fatalf("미보고 멤버가 있는데 close 가 통과했다: %v", err)
	}
	if len(pending) != 1 || pending[0].Role != "b" {
		t.Fatalf("거부는 미보고 멤버 목록을 내야 한다: %+v", pending)
	}
	if got, _ := s.Get(rec.ID); got.State != Open {
		t.Fatalf("거부된 close 가 상태를 바꿨다: %+v", got)
	}

	closed, _, err := s.Close(rec.ID, true)
	if err != nil {
		t.Fatalf("force close 실패: %v", err)
	}
	if closed.State != Closed || closed.ClosedAt == 0 {
		t.Fatalf("close 결과가 기록되지 않았다: %+v", closed)
	}
	if _, _, err := s.Close(rec.ID, true); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("이미 닫힌 Run 을 다시 닫았다: %v", err)
	}
}

// FR-PRE-6: 늦은 보고는 "멤버가 아니다"가 아니라 "Run 이 닫혔다"다 — 조정자가
// 다르게 대응해야 하는 다른 문제다.
func TestStore_ReportAfterCloseSaysRunClosed(t *testing.T) {
	s := newTestStore(t, "e")
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})
	_, _ = s.AddMember(rec.ID, MemberSpec{Role: "a", Agent: "claude", ToolID: "tool-a"})
	_, _, _ = s.Close(rec.ID, true)

	if _, err := s.Report("tool-a", ReportSpec{Outcome: OutcomeSucceeded, Summary: "늦었다"}); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("늦은 보고는 run_closed 여야 한다: %v", err)
	}
	// 애초에 멤버였던 적이 없는 도구는 여전히 sender_not_member 다.
	if _, err := s.Report("tool-zzz", ReportSpec{Outcome: OutcomeSucceeded, Summary: "x"}); !errors.Is(err, ErrSenderNotMember) {
		t.Fatalf("비멤버는 sender_not_member 여야 한다: %v", err)
	}
}

// FR-RUN-11: 실패 보고도 보고다 — close 를 막지 않는다.
func TestStore_FailedReportSatisfiesCloseGuard(t *testing.T) {
	s := newTestStore(t, "e")
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})
	_, _ = s.AddMember(rec.ID, MemberSpec{Role: "a", Agent: "claude", ToolID: "tool-a"})
	_, _ = s.Report("tool-a", ReportSpec{Outcome: OutcomeFailed, Summary: "막혔다"})
	if _, _, err := s.Close(rec.ID, false); err != nil {
		t.Fatalf("실패 보고가 close 를 막았다: %v", err)
	}
}

// FR-RUN-8: 목록은 최근 것이 앞이다 (uuid v7 은 시간 정렬이지만 계약을 고정한다).
func TestStore_ListNewestFirst(t *testing.T) {
	s := newTestStore(t, "e")
	first, _ := s.Start(StartOptions{Objective: "1", Projection: Inline, Isolation: IsolationNone})
	second, _ := s.Start(StartOptions{Objective: "2", Projection: Inline, Isolation: IsolationNone})
	list := s.List()
	if len(list) != 2 || list[0].ID != second.ID || list[1].ID != first.ID {
		t.Fatalf("최근 Run 이 앞이어야 한다: %+v", list)
	}
}

// FR-RUN-2: 멤버 조회는 도구로 한다 (보고 권한 판정의 기반).
func TestStore_MemberByTool(t *testing.T) {
	s := newTestStore(t, "e")
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone})
	_, _ = s.AddMember(rec.ID, MemberSpec{Role: "a", Agent: "claude", ToolID: "tool-a"})

	m, ok := s.MemberByTool("tool-a")
	if !ok || m.RunID != rec.ID || m.Role != "a" {
		t.Fatalf("도구로 멤버를 찾지 못했다: %+v ok=%v", m, ok)
	}
	if _, ok := s.MemberByTool("tool-zzz"); ok {
		t.Fatal("없는 도구가 멤버로 나왔다")
	}
	// 닫힌 Run 의 멤버는 더 이상 활성 멤버가 아니다.
	_, _, _ = s.Close(rec.ID, true)
	if _, ok := s.MemberByTool("tool-a"); ok {
		t.Fatal("닫힌 Run 의 멤버가 활성으로 나왔다")
	}
}

// FR-RUN-10: 정리 판단의 근거는 Run 레코드다 — 등록되지 않은 자원은 목록에 없다.
func TestStore_CloseReportsOwnedResourcesOnly(t *testing.T) {
	s := newTestStore(t, "e")
	rec, _ := s.Start(StartOptions{Objective: "x", Projection: Inline, Isolation: IsolationNone, WindowID: "win-1"})
	_, _ = s.AddMember(rec.ID, MemberSpec{Role: "a", Agent: "claude", ToolID: "tool-a", TabID: "tab-a"})
	_, _ = s.Report("tool-a", ReportSpec{Outcome: OutcomeSucceeded, Summary: "ok"})

	closed, _, err := s.Close(rec.ID, false)
	if err != nil {
		t.Fatalf("Close: %v", err)
	}
	if closed.WindowID != "win-1" || len(closed.Members) != 1 || closed.Members[0].TabID != "tab-a" {
		t.Fatalf("정리 대상은 등록된 것만이다: %+v", closed)
	}
}
