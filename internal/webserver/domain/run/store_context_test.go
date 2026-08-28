package run

import (
	"errors"
	"strings"
	"testing"
)

// 묶음 C — 컨텍스트 예산과 승계 (ORCHESTRATION_V2_SRS §3.3, V-CBG-*).

// openRunWithMember 는 열린 Run 하나와 그 멤버 하나를 만든다.
func openRunWithMember(t *testing.T, s *Store, toolID string, tree *Worktree) (Record, Member) {
	t.Helper()
	rec, err := s.Start(StartOptions{
		Objective: "컨텍스트 관측", Projection: DedicatedWindow,
		Isolation: IsolationNone, CoordinatorToolID: "coord",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	m, err := s.AddMember(rec.ID, MemberSpec{
		Role: "작가", Agent: "claude", Brief: "1장을 쓴다", ToolID: toolID, TabID: "tab-1", Worktree: tree,
	})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	return rec, m
}

// bytesForRatio 는 원하는 사용률을 만드는 transcript 크기다. 임계가 설정값이므로
// 테스트도 상수를 박지 않고 정책에서 되짚어 계산한다.
func bytesForRatio(p ContextPolicy, ratio float64) int64 {
	return int64(ratio * p.LimitTokens * p.BytesPerToken)
}

// V-CBG-1 (FR-CBG-4): 크기를 단계적으로 키우면 등급이 ok→warn→critical 로 오른다.
func TestObserveContext_LevelClimbsWithSize(t *testing.T) {
	s := newTestStore(t, "e1")
	_, m := openRunWithMember(t, s, "tool-1", nil)
	p := DefaultContextPolicy()

	for _, tc := range []struct {
		ratio   float64
		level   string
		entered string
	}{
		{0.10, LevelOK, ""},                  // 관측의 시작은 전이가 아니다
		{0.75, LevelWarn, LevelWarn},         // ok → warn
		{0.80, LevelWarn, ""},                // 같은 등급 안의 이동은 전이가 아니다
		{0.90, LevelCritical, LevelCritical}, // warn → critical
	} {
		got, entered, found := s.ObserveContext("tool-1", ContextObservation{
			Bytes: bytesForRatio(p, tc.ratio), HasBytes: true,
		}, p)
		if !found {
			t.Fatalf("ratio=%.2f: 멤버를 찾지 못했다", tc.ratio)
		}
		if got.ContextLevel != tc.level {
			t.Fatalf("ratio=%.2f: 등급 %q, 기대 %q", tc.ratio, got.ContextLevel, tc.level)
		}
		if entered != tc.entered {
			t.Fatalf("ratio=%.2f: 진입 %q, 기대 %q", tc.ratio, entered, tc.entered)
		}
		if got.ContextRatio < tc.ratio-0.01 || got.ContextRatio > tc.ratio+0.01 {
			t.Fatalf("ratio=%.2f: 기록된 사용률이 어긋난다: %v", tc.ratio, got.ContextRatio)
		}
		if got.ContextAt == 0 {
			t.Fatal("관측 시각이 남지 않았다")
		}
	}
	if m.ContextLevel != "" {
		t.Fatal("갓 만든 멤버는 등급이 비어 있어야 한다")
	}
}

// V-CBG-2 (FR-CBG-4): PreCompact 한 번이면 크기가 작아도 즉시 critical 이고,
// 그 뒤로 transcript 가 **줄어들어도 내려가지 않는다.**
//
// **이 테스트가 검증하는 것은 FR-CBG-4 의 압축 규칙이다** (SRS §3.3.2 의 테스트
// 규약). 겹쳐 막는 두 규칙 중 이쪽만 본다 — 등급 추종은 위
// LevelTracksCurrentState 가 압축 없이 등급 추종을 따로 본다. 여기서 첫 관측부터
// critical 이 나오는 이유는 compactCount 가 남아 있는 한 policy.Level 이 크기를 보지 않기
// 때문이며, 그것은 **압축이 일어난 뒤에만** 참이다.
func TestObserveContext_CompactPinsCritical(t *testing.T) {
	s := newTestStore(t, "e1")
	openRunWithMember(t, s, "tool-1", nil)
	p := DefaultContextPolicy()

	got, entered, _ := s.ObserveContext("tool-1", ContextObservation{
		Bytes: bytesForRatio(p, 0.05), HasBytes: true, Compacted: true,
	}, p)
	if got.ContextLevel != LevelCritical || got.CompactCount != 1 {
		t.Fatalf("압축 1회는 즉시 critical 이다: level=%q compact=%d", got.ContextLevel, got.CompactCount)
	}
	if entered != LevelCritical {
		t.Fatalf("critical 진입이 보고되지 않았다: %q", entered)
	}

	// 압축 직후 transcript 는 오히려 작아진다. 등급이 도로 내려가면 안 된다.
	got, entered, _ = s.ObserveContext("tool-1", ContextObservation{
		Bytes: bytesForRatio(p, 0.02), HasBytes: true,
	}, p)
	if got.ContextLevel != LevelCritical {
		t.Fatalf("압축 이후 등급이 내려갔다: %q", got.ContextLevel)
	}
	if entered != "" {
		t.Fatalf("같은 등급에 머무는 것은 전이가 아니다: %q", entered)
	}
}

// V-CBG-3 (FR-CBG-5): 크기를 재지 못한 관측은 등급을 **비운 채로** 둔다.
// 0 도 ok 도 아니다 — 모르는 것을 안다고 적으면 안 된다.
func TestObserveContext_UnmeasuredStaysEmpty(t *testing.T) {
	s := newTestStore(t, "e1")
	openRunWithMember(t, s, "tool-1", nil)

	got, entered, found := s.ObserveContext("tool-1", ContextObservation{SessionID: "s-1"}, DefaultContextPolicy())
	if !found {
		t.Fatal("멤버를 찾지 못했다")
	}
	if got.ContextLevel != "" {
		t.Fatalf("근거 없는 등급이 매겨졌다: %q", got.ContextLevel)
	}
	if got.ContextBytes != 0 || got.ContextRatio != 0 {
		t.Fatalf("재지 못한 값이 채워졌다: %+v", got)
	}
	if entered != "" {
		t.Fatalf("전이가 없어야 한다: %q", entered)
	}
	// 세션 결속은 크기와 무관하게 기록된다 (FR-CBG-1).
	if got.SessionID != "s-1" {
		t.Fatalf("세션 결속이 유실됐다: %+v", got)
	}
}

// Run 과 무관한 도구의 훅은 **조용한 무동작**이다. `dmctl activity` 는 멤버가
// 아닌 claude 전부에서도 돌기 때문에, 이것이 정상 경로다.
func TestObserveContext_NonMemberIsSilent(t *testing.T) {
	s := newTestStore(t, "e1")
	openRunWithMember(t, s, "tool-1", nil)
	if _, _, found := s.ObserveContext("남의-도구", ContextObservation{Bytes: 1 << 20, HasBytes: true}, DefaultContextPolicy()); found {
		t.Fatal("멤버가 아닌 도구의 관측이 받아들여졌다")
	}
}

// FR-CBG-2: 임계와 공식은 설정값이다. 하드코딩돼 있으면 여기서 걸린다.
func TestContextPolicy_IsConfigurable(t *testing.T) {
	strict := ContextPolicy{BytesPerToken: 4, LimitTokens: 1000, WarnRatio: 0.1, CriticalRatio: 0.2}
	if lv := strict.Level(500, 0); lv != LevelWarn { // 125 토큰 / 1000 = 0.125
		t.Fatalf("설정된 임계가 쓰이지 않았다: %q", lv)
	}
	if lv := strict.Level(1000, 0); lv != LevelCritical { // 0.25
		t.Fatalf("설정된 critical 임계가 쓰이지 않았다: %q", lv)
	}

	// 빠진 값·뒤집힌 경계·0 은 기본값으로 되돌아간다. 설정 오타가 모든 멤버를
	// critical 로 만들거나 0 으로 나누게 두지 않는다.
	if lv := (ContextPolicy{}).Level(0, 0); lv != LevelOK {
		t.Fatalf("빈 정책이 기본값으로 돌아가지 않았다: %q", lv)
	}
	flipped := ContextPolicy{WarnRatio: 0.9, CriticalRatio: 0.5}.withDefaults()
	if flipped.WarnRatio > flipped.CriticalRatio {
		t.Fatalf("뒤집힌 경계가 교정되지 않았다: %+v", flipped)
	}
}

// V-CBG-6 (FR-CBG-9/11): 승계는 역할·brief·**작업 트리**를 그대로 물려주고,
// 이전 멤버를 succeeded 로 옮긴다. worktree 를 새로 만들지 않는다.
func TestSucceed_InheritsWorktreeAndSettlesPrev(t *testing.T) {
	s := newTestStore(t, "e1")
	tree := &Worktree{Path: "/tmp/wt/작가", Branch: "run/abc/작가", Base: "main"}
	_, m := openRunWithMember(t, s, "tool-1", tree)

	prev, next, err := s.Succeed(SucceedSpec{
		PrevMemberID: m.ID, ToolID: "tool-2", TabID: "tab-2", Summary: "1장 초고까지 했다",
	})
	if err != nil {
		t.Fatalf("Succeed: %v", err)
	}
	if next.Worktree == nil || next.Worktree.Path != tree.Path || next.Worktree.Branch != tree.Branch {
		t.Fatalf("작업 트리를 물려받지 못했다: %+v", next.Worktree)
	}
	if next.Role != m.Role || next.Brief != m.Brief || next.Agent != m.Agent || next.RunID != m.RunID {
		t.Fatalf("역할·brief 를 물려받지 못했다: %+v", next)
	}
	if next.SucceededFrom != m.ID || prev.SucceededBy != next.ID {
		t.Fatalf("승계 사슬이 양방향으로 이어지지 않았다: prev=%+v next=%+v", prev, next)
	}
	if prev.State != Succeeded {
		t.Fatalf("이전 멤버가 succeeded 가 아니다: %q", prev.State)
	}
	if prev.Outcome != "" || prev.Reported() {
		t.Fatalf("승계는 결말이 아니다 — outcome 을 건드리면 안 된다: %+v", prev)
	}
	if prev.HandoffSummary != "1장 초고까지 했다" {
		t.Fatalf("인수인계 요약이 남지 않았다: %q", prev.HandoffSummary)
	}
	// FR-CBG-11: 트리가 하나뿐이어야 한다. 두 멤버가 같은 경로를 가리키므로
	// 정리 대상도 하나다.
	rec, _ := s.Get(m.RunID)
	if targets := rec.WorktreeTargets(); len(targets) != 1 || targets[0].Path != tree.Path {
		t.Fatalf("정리 대상이 중복되거나 새로 생겼다: %+v", targets)
	}
}

// V-CBG-8 (FR-CBG-10): succeeded 멤버만 남은 Run 은 --force 없이 닫힌다.
// 일을 마친 것이 아니라 넘긴 것이므로 기다릴 보고가 없다.
func TestClose_SucceededCountsAsSettled(t *testing.T) {
	s := newTestStore(t, "e1")
	_, m := openRunWithMember(t, s, "tool-1", nil)
	_, next, err := s.Succeed(SucceedSpec{PrevMemberID: m.ID, ToolID: "tool-2"})
	if err != nil {
		t.Fatalf("Succeed: %v", err)
	}
	// 승계자는 아직 보고하지 않았으므로 이 단계에서는 거부돼야 한다.
	if _, pending, err := s.Close(m.RunID, false); !errors.Is(err, ErrUnreportedMembers) {
		t.Fatalf("승계자의 미보고는 그대로 걸려야 한다: err=%v pending=%d", err, len(pending))
	}
	if _, err := s.Report("tool-2", ReportSpec{Outcome: OutcomeSucceeded, Summary: "1장 마쳤다"}); err != nil {
		t.Fatalf("승계자 보고: %v", err)
	}
	rec, pending, err := s.Close(m.RunID, false)
	if err != nil {
		t.Fatalf("succeeded 멤버가 미보고로 걸렸다: %v (pending=%d)", err, len(pending))
	}
	if rec.State != Closed {
		t.Fatalf("Run 이 닫히지 않았다: %q", rec.State)
	}
	_ = next
}

// 승계는 한 번뿐이다. 같은 멤버를 두 번 승계하면 사슬이 갈라진다.
func TestSucceed_RefusesDoubleSuccession(t *testing.T) {
	s := newTestStore(t, "e1")
	_, m := openRunWithMember(t, s, "tool-1", nil)
	if _, _, err := s.Succeed(SucceedSpec{PrevMemberID: m.ID, ToolID: "tool-2"}); err != nil {
		t.Fatalf("첫 승계: %v", err)
	}
	_, _, err := s.Succeed(SucceedSpec{PrevMemberID: m.ID, ToolID: "tool-3"})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("두 번째 승계가 거부되지 않았다: %v", err)
	}
	// 열거된 사유들도 그대로 지켜야 한다.
	if _, _, err := s.Succeed(SucceedSpec{PrevMemberID: "없는-멤버", ToolID: "tool-4"}); !errors.Is(err, ErrUnknownMember) {
		t.Fatalf("없는 멤버: %v", err)
	}
	if _, _, err := s.Succeed(SucceedSpec{PrevMemberID: m.ID, ToolID: "tool-2"}); !errors.Is(err, ErrToolAlreadyMember) {
		t.Fatalf("이미 멤버인 도구: %v", err)
	}
}

// FR-PRE-5 와 같은 규칙: 인수인계의 권한은 **발신 도구의 정체**다. 남의
// memberId 를 아는 것은 권한이 아니다.
func TestHandoff_AuthorityIsTheSender(t *testing.T) {
	s := newTestStore(t, "e1")
	rec, m := openRunWithMember(t, s, "tool-1", nil)
	other, err := s.AddMember(rec.ID, MemberSpec{Role: "비평가", Agent: "claude", ToolID: "tool-9"})
	if err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	got, err := s.Handoff("tool-1", "", "여기까지 했다")
	if err != nil || got.HandoffSummary != "여기까지 했다" {
		t.Fatalf("자기 자신에 대한 인수인계가 실패했다: %v %+v", err, got)
	}
	// 남의 몫을 대신 쓸 수 없다.
	if _, err := s.Handoff("tool-1", other.ID, "남의 요약"); !errors.Is(err, ErrRunMemberMismatch) {
		t.Fatalf("남의 memberId 가 통과했다: %v", err)
	}
	if _, err := s.Handoff("멤버아님", "", "요약"); !errors.Is(err, ErrSenderNotMember) {
		t.Fatalf("멤버가 아닌 발신자가 통과했다: %v", err)
	}
	if _, err := s.Handoff("tool-1", m.ID, "  "); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("빈 요약이 통과했다: %v", err)
	}
	if !strings.Contains(m.ID, "-") {
		t.Fatalf("테스트 전제가 깨졌다: %q", m.ID)
	}
}

// FR-CBG-6/7 (SRS §3.3.2 "ContextLevel 은 단조가 아니다 — 닫힘"): 등급은 현재
// 상태의 표시이며 내려간다. 저장소가 내는 entered 는 "직전보다 올라갔다"는
// 감지일 뿐이고, **되오름도 전이로 잡는다** — FR-CBG-7 이 전제하는 경우가 그것이다.
// 같은 등급에 두 번 알리지 않는 것은 통지 계층의 몫이며, 그 분리를 여기서 고정한다.
//
// **이 테스트는 압축을 한 번도 일으키지 않는다** (SRS §3.3.2 의 테스트 규약).
// FR-CBG-4 의 압축 규칙에 기대어 통과하는 일이 없도록 CompactCount 를 단언한다.
func TestObserveContext_LevelTracksCurrentState(t *testing.T) {
	s := newTestStore(t, "e1")
	openRunWithMember(t, s, "tool-1", nil)
	p := DefaultContextPolicy()

	var entries []string
	observe := func(ratio float64) Member {
		m, entered, _ := s.ObserveContext("tool-1", ContextObservation{
			Bytes: bytesForRatio(p, ratio), HasBytes: true,
		}, p)
		if entered != "" {
			entries = append(entries, entered)
		}
		return m
	}
	observe(0.75) // warn 진입
	observe(0.90) // critical 진입
	m := observe(0.50)

	if m.CompactCount != 0 {
		t.Fatalf("이 테스트는 압축 없이 등급 추종만 봐야 한다: compact=%d", m.CompactCount)
	}
	// 압축 없이 크기가 줄었다면 여유가 실제로 생긴 것이다. 등급도 따라 내려간다.
	if m.ContextLevel != LevelOK {
		t.Fatalf("등급이 현재 상태를 따르지 않는다: %q", m.ContextLevel)
	}
	if m.ContextBytes != bytesForRatio(p, 0.50) {
		t.Fatalf("크기가 마지막 관측과 다르다: %d", m.ContextBytes)
	}
	// 내려가는 것은 전이가 아니다.
	if len(entries) != 2 || entries[0] != LevelWarn || entries[1] != LevelCritical {
		t.Fatalf("전이 감지가 어긋난다: %v", entries)
	}

	// 다시 올라가면 저장소는 **또** 전이로 본다. 재통지를 막는 것은 여기가
	// 아니라 통지 계층이다 (httpapi 의 contextNotices).
	observe(0.78)
	observe(0.90)
	if len(entries) != 4 || entries[2] != LevelWarn || entries[3] != LevelCritical {
		t.Fatalf("되오름을 전이로 감지해야 한다: %v", entries)
	}
}
