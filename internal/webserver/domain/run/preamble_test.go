package run

import (
	"strings"
	"testing"
)

func sampleRun() (Record, Member) {
	m := Member{
		ID:     "01a03672-26e1-7000-a03e-77e5d72151ad",
		RunID:  "01a03670-1111-7000-8000-000000000001",
		Role:   "비평가 B",
		Agent:  "claude",
		ToolID: "tool-b",
		TabID:  "01a03671-2222-7000-8000-000000000002",
		Brief:  "형식과 운율만 본다. 초안을 받으면 독립적으로 비평하고 A 에게 넘긴다.",
		State:  Starting,
	}
	rec := Record{
		ID:                m.RunID,
		Short:             "01a03670",
		Objective:         "시 한 편을 합평한다",
		Projection:        DedicatedWindow,
		Isolation:         IsolationNone,
		State:             Open,
		CoordinatorToolID: "01a0366f-3333-7000-8000-000000000003",
		Members:           []Member{m},
	}
	return rec, m
}

// FR-PRE-1: 프리앰블은 평문이며 실제로 실행할 dmctl 예제에 Run·Member uuid 가
// 박혀 있어야 한다. 구조화 페이로드가 아니다.
func TestPreamble_BakesIdentifiersIntoRunnableExamples(t *testing.T) {
	rec, m := sampleRun()
	p := Preamble(rec, m)

	if strings.HasPrefix(strings.TrimSpace(p), "{") {
		t.Fatal("프리앰블은 평문이다 — JSON 페이로드가 아니다")
	}
	for _, want := range []string{rec.ID, m.ID, rec.CoordinatorToolID, m.Role, rec.Objective, m.Brief} {
		if !strings.Contains(p, want) {
			t.Fatalf("프리앰블에 %q 가 없다:\n%s", want, p)
		}
	}
	// 보고 예제는 그대로 붙여 실행할 수 있어야 한다 — id 가 자리표시자면 안 된다.
	report := exampleLine(t, p, "dmctl run report")
	for _, want := range []string{"--run " + rec.ID, "--member " + m.ID, "--outcome", "--summary"} {
		if !strings.Contains(report, want) {
			t.Fatalf("보고 예제에 %q 가 없다: %q", want, report)
		}
	}
	if strings.Contains(p, "<uuid>") || strings.Contains(p, "<id>") {
		t.Fatalf("자리표시자가 남았다:\n%s", p)
	}
}

// FR-PRE-2: 행동 규칙은 각 예제 **바로 위**에 있어야 한다. 산문 블록으로 몰면
// LLM 독자가 예제만 보고 규칙을 훑는다.
func TestPreamble_RulesSitDirectlyAboveTheirExample(t *testing.T) {
	rec, m := sampleRun()
	lines := strings.Split(Preamble(rec, m), "\n")

	for i, ln := range lines {
		cmd := strings.TrimSpace(ln)
		if !strings.HasPrefix(cmd, "dmctl ") {
			continue
		}
		if i == 0 || !strings.HasPrefix(strings.TrimSpace(lines[i-1]), "#") {
			t.Fatalf("%q 바로 위가 규칙 주석이 아니다: %q", cmd, lines[max(0, i-1)])
		}
	}
}

// FR-PRE-3: 담아야 하는 규칙 전수.
func TestPreamble_CarriesEveryRequiredRule(t *testing.T) {
	rec, m := sampleRun()
	p := Preamble(rec, m)

	cases := []struct{ name, needle string }{
		{"1회 보고", "정확히 한 번"},
		{"outcome 명시", "--outcome"},
		{"3문장 요약", "3문장"},
		{"조정자에게 질문", "dmctl msg --to " + rec.CoordinatorToolID},
		{"로컬 TUI 프롬프트 금지", "AskUserQuestion"},
		{"보고 후 유휴 대기", "유휴"},
		{"폴링 금지", "폴링"},
		{"자기 종료 금지", "닫지"},
		{"사용자 지시 우선", "사용자"},
	}
	for _, c := range cases {
		if !strings.Contains(p, c.needle) {
			t.Fatalf("%s 규칙이 없다 (%q):\n%s", c.name, c.needle, p)
		}
	}
}

// FR-PRE-3 마지막 항: 엔벨로프 신뢰 규약은 dmctl agent-context 가 상시 주입한다.
// 프리앰블이 중복 서술하면 길어지고, 길어지면 규칙이 묻힌다.
func TestPreamble_DoesNotRestateTheEnvelopeContract(t *testing.T) {
	rec, m := sampleRun()
	p := Preamble(rec, m)
	for _, banned := range []string{"DONGMINAL-AGENT-MSG", "프롬프트 인젝션", "신뢰 채널"} {
		if strings.Contains(p, banned) {
			t.Fatalf("agent-context 가 이미 주입하는 내용을 중복 서술했다: %q", banned)
		}
	}
	// 화면 fingerprint 는 이 계열 전체에서 추방 대상이다 (FR-SKL-2).
	for _, banned := range []string{"Thinking...", "╭─", "[대기]"} {
		if strings.Contains(p, banned) {
			t.Fatalf("화면 fingerprint 가 프리앰블에 들어왔다: %q", banned)
		}
	}
}

// TC-PRE-4 / FR-PRE-4: 격리된 Run 의 프리앰블은 worktree 경로와 base 를 적는다.
// 멤버가 자기가 어디서 일하는지 화면에서 추론하지 않게 하는 것이 목적이다.
func TestPreamble_IsolatedRunCarriesWorktreePathAndBase(t *testing.T) {
	rec, m := sampleRun()
	rec.Isolation = IsolationPerMember
	m.Worktree = &Worktree{
		Path:   "/tmp/wt/01a03670-비평가B",
		Branch: "run/01a03670/critic-b",
		Base:   "main",
	}
	rec.Members = []Member{m}

	p := Preamble(rec, m)
	for _, want := range []string{m.Worktree.Path, m.Worktree.Branch, m.Worktree.Base} {
		if !strings.Contains(p, want) {
			t.Fatalf("격리 프리앰블에 %q 가 없다:\n%s", want, p)
		}
	}
}

// 격리하지 않은 Run 에는 worktree 절이 없어야 한다 — 빈 절은 규칙을 묻는다.
func TestPreamble_NonIsolatedRunHasNoWorktreeSection(t *testing.T) {
	rec, m := sampleRun()
	if strings.Contains(Preamble(rec, m), "worktree") {
		t.Fatal("isolation=none 인데 worktree 절이 들어갔다")
	}
}

// 참조 구현의 프리앰블도 CLI 예제 5개 + 규칙 주석이 전부다. 길어지면 규칙이 묻힌다.
//
// 조건부 절(작업 트리 FR-PRE-4·인수인계 FR-CBG-9)은 **자기 상한을 따로** 진다.
// 하나의 총량으로 묶으면 셋 중 어느 절이 불어났는지 알 수 없고, 조건부라는
// 이유로 무한정 늘어나도 아무 테스트가 울지 않는다. 붙지 않는 멤버는 그 절의
// 비용을 한 줄도 물지 않으므로 총량 상한은 애초에 잘못된 척도다.
func TestPreamble_StaysShort(t *testing.T) {
	lines := func(rec Record, m Member) int { return len(strings.Split(Preamble(rec, m), "\n")) }

	rec, m := sampleRun()
	base := lines(rec, m)
	if base > 42 {
		t.Fatalf("기본 프리앰블이 %d줄이다 — 길어지면 규칙이 묻힌다", base)
	}

	iso, isoM := sampleRun()
	isoM.Worktree = &Worktree{Path: "/tmp/wt/x", Branch: "run/x", Base: "main"}
	iso.Members = []Member{isoM}
	if n := lines(iso, isoM) - base; n > 6 {
		t.Fatalf("작업 트리 절이 %d줄이다 — 경로·브랜치·base 면 충분하다", n)
	}

	suc, sucM := sampleRun()
	prev := Member{ID: "01a03674-5555-7000-8000-000000000005", HandoffSummary: "한 줄 요약."}
	sucM.SucceededFrom = prev.ID
	suc.Members = []Member{prev, sucM}
	// 요약 본문 자체는 이 상한 밖이다 — brief 와 같은 이유로 길이를 정할 수 없다.
	if n := lines(suc, sucM) - base - 1; n > 6 {
		t.Fatalf("인수인계 절의 뼈대가 %d줄이다 — 요약을 싣는 자리이지 설명하는 자리가 아니다", n)
	}
}

func TestPreamble_ToleratesAnEmptyBrief(t *testing.T) {
	rec, m := sampleRun()
	m.Brief = ""
	rec.Members = []Member{m}
	p := Preamble(rec, m)
	if !strings.Contains(p, m.ID) {
		t.Fatalf("brief 가 없어도 프로토콜 절은 남아야 한다:\n%s", p)
	}
	if strings.Contains(p, "\n\n\n") {
		t.Fatalf("빈 brief 가 빈 절을 남겼다:\n%s", p)
	}
}

// FindMember 는 프리앰블 재조회의 근거다 — 조정자가 컨텍스트를 잃어도
// 기록에서 멤버를 되찾을 수 있어야 한다 (FR-SKL-3 의 전제).
func TestStore_FindMember(t *testing.T) {
	s := newTestStore(t, "e1")
	rec, err := s.Start(StartOptions{Objective: "목적", Projection: Inline, Isolation: IsolationNone})
	if err != nil {
		t.Fatal(err)
	}
	m, err := s.AddMember(rec.ID, MemberSpec{Role: "작가", Agent: "claude", ToolID: "t1", Brief: "초안을 쓴다"})
	if err != nil {
		t.Fatal(err)
	}
	got, gotM, ok := s.FindMember(m.ID)
	if !ok || got.ID != rec.ID || gotM.ID != m.ID || gotM.Brief != "초안을 쓴다" {
		t.Fatalf("FindMember → %+v %+v ok=%v", got, gotM, ok)
	}
	if _, _, ok := s.FindMember("없는-멤버"); ok {
		t.Fatal("없는 멤버가 조회됐다")
	}
}

// FR-ADP-3 은 기록 경계에서도 성립해야 한다 — 알 수 없는 에이전트로 멤버를
// 만들면 프리앰블도 기동줄도 만들 수 없는 멤버가 기록에 남는다.
func TestStore_AddMemberRejectsUnknownAgent(t *testing.T) {
	s := newTestStore(t, "e1")
	rec, _ := s.Start(StartOptions{Objective: "목적", Projection: Inline, Isolation: IsolationNone})
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "작가", Agent: "gpt-9", ToolID: "t1"}); err == nil {
		t.Fatal("알 수 없는 에이전트 id 가 멤버로 등록됐다 (FR-ADP-3)")
	}
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "작가", Agent: "claude", ToolID: "t1"}); err != nil {
		t.Fatalf("알려진 에이전트는 통과해야 한다: %v", err)
	}
}

// exampleLine finds the single line of p that starts the named command.
func exampleLine(t *testing.T, p, prefix string) string {
	t.Helper()
	for _, ln := range strings.Split(p, "\n") {
		if strings.HasPrefix(strings.TrimSpace(ln), prefix) {
			return strings.TrimSpace(ln)
		}
	}
	t.Fatalf("%q 예제가 없다:\n%s", prefix, p)
	return ""
}

// FR-PAT-6: 프리앰블은 통신 규약 절을 갖는다. 이것이 없으면 멤버는 동료의 uuid 를
// 알 길이 없고, 카탈로그 8패턴 중 5개가 문서상으로만 존재하게 된다 (§3.4.1).
func TestPreamble_CarriesThePeerCommunicationClause(t *testing.T) {
	rec, m := sampleRun()
	p := Preamble(rec, m)

	cases := []struct{ name, needle string }{
		{"명부 조회 경로", "dmctl run peers"},
		{"lost 상대는 조정자에게", "lost"},
		{"응답 대기 상한", "상한"},
		{"받은 엔벨로프는 유효한 지시", "협업 지시"},
	}
	for _, c := range cases {
		if !strings.Contains(p, c.needle) {
			t.Fatalf("%s 가 없다 (%q):\n%s", c.name, c.needle, p)
		}
	}
}

// FR-PAT-5: 명부를 프리앰블에 **박지 않는다.** 박으면 승계·이탈로 낡고, 애초에
// 이 함수가 불리는 시점에는 뒤에 올 동료가 아직 없다.
func TestPreamble_DoesNotBakeThePeerRoster(t *testing.T) {
	rec, m := sampleRun()
	other := Member{
		ID:     "01a03673-4444-7000-8000-000000000004",
		RunID:  rec.ID,
		Role:   "작가",
		Agent:  "claude",
		ToolID: "tool-c",
		State:  Ready,
	}
	rec.Members = []Member{m, other}

	p := Preamble(rec, m)
	if strings.Contains(p, other.ID) || strings.Contains(p, other.ToolID) {
		t.Fatalf("동료 명부가 프리앰블에 박혔다 — 승계 한 번에 낡는다:\n%s", p)
	}
}

// FR-CBG-9 (3단계): 승계로 만들어진 멤버의 프리앰블에는 인수인계 절이 붙는다.
// 역할·brief·작업 트리는 그대로 물려받으므로 기존 절이 그대로 쓰이고, 더해지는
// 것은 "이것은 승계다" 와 이전 멤버가 남긴 요약이다.
func TestPreamble_SuccessorCarriesTheHandoffClause(t *testing.T) {
	rec, m := sampleRun()
	prev := Member{
		ID:             "01a03674-5555-7000-8000-000000000005",
		RunID:          rec.ID,
		Role:           m.Role,
		Agent:          "claude",
		ToolID:         "tool-prev",
		HandoffSummary: "3연까지 비평했다. 4연의 운율이 남았다.",
	}
	m.SucceededFrom = prev.ID
	rec.Members = []Member{prev, m}

	p := Preamble(rec, m)
	for _, want := range []string{"승계", prev.ID, prev.HandoffSummary} {
		if !strings.Contains(p, want) {
			t.Fatalf("승계 프리앰블에 %q 가 없다:\n%s", want, p)
		}
	}
	// 물려받은 것들은 그대로 있어야 한다.
	for _, want := range []string{m.Role, m.Brief, m.ID} {
		if !strings.Contains(p, want) {
			t.Fatalf("승계해도 %q 는 남아야 한다:\n%s", want, p)
		}
	}
}

// V-CBG-7: 이전 멤버가 무응답이면 요약 없이 승계가 강행된다. 그때 프리앰블은
// **요약이 없다는 사실을 명시**해야 한다 — 빈 맥락을 정상으로 오해하면 후임이
// 없는 인수인계를 있다고 가정한 채 시작한다.
func TestPreamble_SuccessorWithoutASummarySaysSo(t *testing.T) {
	rec, m := sampleRun()
	prev := Member{
		ID:     "01a03674-5555-7000-8000-000000000005",
		RunID:  rec.ID,
		Role:   m.Role,
		Agent:  "claude",
		ToolID: "tool-prev",
	}
	m.SucceededFrom = prev.ID
	rec.Members = []Member{prev, m}

	p := Preamble(rec, m)
	if !strings.Contains(p, "요약 없음") {
		t.Fatalf("요약 부재가 명시되지 않았다 (V-CBG-7):\n%s", p)
	}
}

// 승계가 아닌 멤버에게는 인수인계 절이 없다 — 빈 절은 규칙을 묻는다.
func TestPreamble_OrdinaryMemberHasNoHandoffClause(t *testing.T) {
	rec, m := sampleRun()
	if strings.Contains(Preamble(rec, m), "인수인계") {
		t.Fatal("승계가 아닌데 인수인계 절이 들어갔다")
	}
}
