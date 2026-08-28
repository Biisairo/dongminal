// 묶음 C 의 도메인 절반이다 (ORCHESTRATION_V2_SRS §3.3).
//
// **store.go 와 물리적으로 분리한다.** 묶음 C·H·V 가 같은 시기에 같은 저장소를
// 고치므로, 새 메서드를 store.go 본문에 끼워 넣으면 세 워크스트림이 같은 줄에서
// 만난다. 여기 있는 것은 전부 덧붙임이며 기존 함수를 고치지 않는다.
//
// 설계 원칙은 하나다 — **서버는 감지하고, 에이전트는 판단한다** (C-1). 이 파일은
// 등급을 매기고 사슬을 잇지만, 멤버를 죽이거나 갈아치우지 않는다. 그것은 조정자가
// 부르는 것이다.
package run

import (
	"fmt"
	"strings"
)

// 컨텍스트 등급 (FR-CBG-4). 빈 문자열은 **모른다**이며 LevelOK 가 아니다 —
// "모른다" 와 "괜찮다" 를 같은 값으로 쓰면 관측되지 않는 에이전트가 영원히
// 건강해 보인다 (FR-CBG-5).
const (
	LevelOK       = "ok"
	LevelWarn     = "warn"
	LevelCritical = "critical"
)

// ContextPolicy 는 추정 공식과 임계다 (FR-CBG-2). **하드코딩하지 않는다** —
// 호출자가 설정에서 읽어 넘기고, 비거나 말이 안 되는 값은 기본값으로 되돌아간다.
//
// 이 값들이 추정임을 잊지 마라. transcript 바이트는 토큰이 아니고, 우리는 모델의
// 실제 컨텍스트 잔량을 볼 수 없다. 그래서 표시는 전부 `~` 를 달고 나간다 (NFR-CBG-3).
type ContextPolicy struct {
	// BytesPerToken 은 transcript 바이트를 토큰으로 환산하는 제수다.
	BytesPerToken float64
	// LimitTokens 는 모델의 컨텍스트 한계다. 멤버 레코드에 모델이 없으므로
	// (기록되는 것은 agent 이지 model 이 아니다) 실제로는 늘 이 기본값이 쓰인다.
	// 모델별 표는 그것을 키로 삼을 입력이 생긴 뒤에 연다.
	LimitTokens float64
	// WarnRatio·CriticalRatio 는 등급 경계다.
	WarnRatio     float64
	CriticalRatio float64
}

// DefaultContextPolicy 는 SRS §3.3.1 이 적은 기본값이다.
func DefaultContextPolicy() ContextPolicy {
	return ContextPolicy{BytesPerToken: 3.6, LimitTokens: 200000, WarnRatio: 0.70, CriticalRatio: 0.85}
}

// withDefaults 는 빠지거나 무의미한 값을 기본값으로 되돌린다. 설정 파일 한 줄의
// 오타가 모든 멤버를 critical 로 만들거나 0 으로 나누게 두지 않는다.
func (p ContextPolicy) withDefaults() ContextPolicy {
	d := DefaultContextPolicy()
	if p.BytesPerToken <= 0 {
		p.BytesPerToken = d.BytesPerToken
	}
	if p.LimitTokens <= 0 {
		p.LimitTokens = d.LimitTokens
	}
	if p.WarnRatio <= 0 {
		p.WarnRatio = d.WarnRatio
	}
	if p.CriticalRatio <= 0 {
		p.CriticalRatio = d.CriticalRatio
	}
	// 경계가 뒤집혀 있으면 warn 이 영영 나오지 않는다. 순서를 강제한다.
	if p.CriticalRatio < p.WarnRatio {
		p.WarnRatio, p.CriticalRatio = p.CriticalRatio, p.WarnRatio
	}
	return p
}

// Ratio 는 transcript 크기에서 추정 사용률을 낸다 (FR-CBG-2).
func (p ContextPolicy) Ratio(bytes int64) float64 {
	p = p.withDefaults()
	return (float64(bytes) / p.BytesPerToken) / p.LimitTokens
}

// Level 은 등급을 판정한다 (FR-CBG-4).
//
// 압축이 **한 번이라도** 일어났으면 크기와 무관하게 critical 이다. 압축은 정보가
// 이미 유실됐다는 뜻이고, 압축 직후 transcript 는 오히려 작아지므로 크기만 보면
// 등급이 도로 내려간다 — 그 자리가 이 규칙이 막는 곳이다.
func (p ContextPolicy) Level(bytes int64, compactCount int) string {
	if compactCount > 0 {
		return LevelCritical
	}
	switch r := p.Ratio(bytes); {
	case r >= p.withDefaults().CriticalRatio:
		return LevelCritical
	case r >= p.withDefaults().WarnRatio:
		return LevelWarn
	}
	return LevelOK
}

// ContextObservation 은 훅 하나가 실어 온 신호다 (FR-CBG-1).
//
// **transcript 의 내용은 여기 없다.** 크기와 사실뿐이며, 그것이 이 구조체가
// 문자열 본문 필드를 갖지 않는 이유다 (NFR-4).
type ContextObservation struct {
	// Bytes 는 transcript 크기다. HasBytes 가 거짓이면 재지 못한 것이며,
	// 0 바이트와 구분된다 — "모른다"를 0 으로 적으면 안 된다 (FR-CBG-5).
	Bytes     int64
	HasBytes  bool
	SessionID string
	// Compacted 는 PreCompact 훅이 왔다는 뜻이다. 추정이 아니라 확정이다.
	Compacted bool
}

// ObserveContext 는 관측 하나를 멤버에 반영한다 (FR-CBG-3).
//
// 발신 도구가 열린 Run 의 멤버가 아니면 **조용한 무동작**이다. `dmctl activity`
// 훅은 Run 과 무관한 claude 전부에서 돌기 때문에, 멤버가 아닌 것은 오류가 아니라
// 정상이다 (found=false).
//
// entered 는 이 관측이 만든 **등급 전이**다 (FR-CBG-6). 직전보다 올라갔고 그
// 등급이 warn·critical 일 때 채워진다. 하락은 전이가 아니고, **되오름은 전이로
// 감지한다** — FR-CBG-7 이 전제하는 경우가 그것이다.
//
// 전이는 감지이고 통지는 판단이다. 같은 등급에 두 번 알릴지는 호출자가 정한다 —
// 저장소는 통지를 모른다 (C-1: 서버가 감지하고 에이전트가 판단한다).
func (s *Store) ObserveContext(toolID string, obs ContextObservation, policy ContextPolicy) (m Member, entered string, found bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	ri, mi, ok := s.findByTool(toolID)
	if !ok {
		return Member{}, "", false
	}
	cur := &s.runs[ri].Members[mi]
	if obs.Compacted {
		cur.CompactCount++
	}
	if obs.SessionID != "" {
		cur.SessionID = obs.SessionID
	}
	if obs.HasBytes {
		cur.ContextBytes = obs.Bytes
		cur.ContextRatio = policy.Ratio(obs.Bytes)
	}
	// 크기를 한 번도 재지 못했고 압축 신호도 없으면 등급을 매길 근거가 없다 —
	// 빈 채로 둔다 (FR-CBG-5).
	//
	// **등급은 단조가 아니다.** 현재 상태의 표시이며 내려간다 (SRS §3.3.2
	// "ContextLevel 은 단조가 아니다 — 닫힘"). 단조인 것은 통지뿐이고, 그 기억은
	// 통지 계층이 갖는다 (handlers_runs_context.go 의 contextNotices).
	//
	// 근거 셋. ① FR-CBG-7 이 되돌아감을 **전제한다** — "되돌아갔다가 다시
	// 올라와도"는 그런 일이 일어날 수 있음을 규정하는 문장이다. ② "등급 = 현재
	// 상태"가 더 단순한 의미론이고, 이력은 CompactCount 가 따로 든다.
	// ③ 회복 불가능성은 FR-CBG-4 가 이미 담당하므로 등급 단조는 **중복**이다.
	//
	// 그래서 압축 뒤에 등급이 안 내려가는 것은 단조성 때문이 아니다. compactCount
	// 가 남아 있는 한 policy.Level 이 크기를 보지 않기 때문이며(FR-CBG-4), 그것은
	// **압축이 일어난 뒤에만** 참이다. 둘을 섞어 읽으면 없는 불변을 믿게 된다.
	if cur.ContextBytes > 0 || cur.CompactCount > 0 {
		level := policy.Level(cur.ContextBytes, cur.CompactCount)
		if levelRank(level) > levelRank(cur.ContextLevel) && level != LevelOK {
			entered = level
		}
		cur.ContextLevel = level
	}
	cur.ContextAt = s.now()
	out := *cur
	if err := s.save(); err != nil {
		// 영속 실패로 관측을 잃어도 훅과 activity 는 살아 있어야 한다
		// (NFR-CBG-2). 저장소가 못 쓰게 된 사실은 save 가 이미 로그로 남긴다.
		return out, entered, true
	}
	return out, entered, true
}

// levelRank 는 등급의 서열이다. 빈 값("모른다")은 ok 보다도 아래다 — 모르는
// 상태에서 ok 로 가는 것은 전이가 아니라 관측의 시작이다.
func levelRank(level string) int {
	switch level {
	case LevelOK:
		return 1
	case LevelWarn:
		return 2
	case LevelCritical:
		return 3
	}
	return 0
}

// SucceedSpec 은 Succeed 의 입력이다. 새 멤버의 도구만 새것이고 나머지는 전부
// 이전 멤버에게서 온다.
type SucceedSpec struct {
	// ID 는 새 멤버의 uuid 다. 비우면 저장소가 발급한다.
	ID string
	// PrevMemberID 는 승계당하는 멤버다.
	PrevMemberID string
	// ToolID·TabID 는 새 멤버가 들어앉을 도구다.
	ToolID string
	TabID  string
	// Headless 는 새 멤버가 탭을 점유하지 않는가다 (묶음 H).
	Headless bool
	// Summary 는 인수인계 요약이다. 비어 있으면 요약 없는 승계이며, 그 사실이
	// 프리앰블에 명시된다 (V-CBG-7).
	Summary string
}

// Succeed 는 멤버 하나를 새 멤버로 교체한다 (FR-CBG-9).
//
// **worktree 를 새로 만들지 않는다** (FR-CBG-11). 이전 멤버의 트리를 그대로
// 가리키게 하며, 그래서 정리(WorktreeTargets)가 같은 경로를 두 번 세지 않도록
// 포인터가 아니라 값을 복사해 둘 다 같은 Path 를 갖게 한다 — 정리는 Path 로
// 중복을 지우므로 트리 하나가 두 번 지워지지 않는다.
//
// 이전 멤버의 Tool 은 **건드리지 않는다** (FR-CBG-12). 인수인계가 불완전할 때
// 조정자가 되돌아가 읽을 수 있어야 하므로, 종료는 조정자의 몫이다.
func (s *Store) Succeed(spec SucceedSpec) (prev Member, next Member, err error) {
	if strings.TrimSpace(spec.PrevMemberID) == "" {
		return Member{}, Member{}, fmt.Errorf("%w: 승계 대상 멤버가 필요하다", ErrInvalidArgument)
	}
	if strings.TrimSpace(spec.ToolID) == "" {
		return Member{}, Member{}, fmt.Errorf("%w: 새 멤버가 들어앉을 도구가 필요하다", ErrInvalidArgument)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	ri, mi := s.indexOfMember(spec.PrevMemberID)
	if ri < 0 {
		return Member{}, Member{}, ErrUnknownMember
	}
	if s.runs[ri].State != Open {
		return Member{}, Member{}, ErrRunClosed
	}
	if _, _, ok := s.findByTool(spec.ToolID); ok {
		return Member{}, Member{}, ErrToolAlreadyMember
	}
	old := &s.runs[ri].Members[mi]
	if old.SucceededBy != "" {
		return Member{}, Member{}, fmt.Errorf("%w: 이미 승계된 멤버다 (승계자 %s)", ErrInvalidArgument, old.SucceededBy)
	}

	id := strings.TrimSpace(spec.ID)
	if id == "" {
		id = s.newID()
	}
	// 역할·brief·작업 트리를 그대로 물려받는다. 같은 일을 이어서 하는 것이므로
	// 새 brief 를 지어내지 않는다 (FR-CBG-9).
	var tree *Worktree
	if old.Worktree != nil {
		inherited := *old.Worktree
		tree = &inherited
	}
	next = Member{
		ID:            id,
		RunID:         s.runs[ri].ID,
		Role:          old.Role,
		Agent:         old.Agent,
		Brief:         old.Brief,
		ToolID:        spec.ToolID,
		TabID:         spec.TabID,
		Headless:      spec.Headless,
		Worktree:      tree,
		State:         Starting,
		SucceededFrom: old.ID,
		CreatedAt:     s.now(),
	}

	old.State = Succeeded
	old.SucceededBy = id
	if sum := strings.TrimSpace(spec.Summary); sum != "" {
		old.HandoffSummary = sum
	}
	// Outcome 은 건드리지 않는다 (FR-CBG-9). 승계는 결말이 아니다.

	prev = *old
	s.runs[ri].Members = append(s.runs[ri].Members, next)
	if err := s.save(); err != nil {
		return Member{}, Member{}, err
	}
	return prev, next, nil
}

// Handoff 는 멤버가 후임에게 남기는 인수인계 요약을 받는다 (FR-CBG-9 의 1단계).
//
// 권한은 **발신 도구의 정체**다 (FR-PRE-5 와 같은 규칙). 페이로드의 memberId 를
// 아는 것은 권한이 아니며, 멤버는 자기 자신에 대해서만 쓸 수 있다.
//
// 승계 호출보다 먼저 도착하므로 여기서는 요약만 적어 두고, Succeed 가 그것을
// 읽어 새 멤버의 프리앰블로 옮긴다.
func (s *Store) Handoff(senderToolID, claimedMemberID, summary string) (Member, error) {
	if strings.TrimSpace(summary) == "" {
		return Member{}, fmt.Errorf("%w: summary 는 비어 있을 수 없다 — 후임이 먼저 읽는 것이다", ErrInvalidArgument)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	ri, mi, ok := s.findByTool(senderToolID)
	if !ok {
		if s.wasMemberOfClosedRun(senderToolID) {
			return Member{}, ErrRunClosed
		}
		return Member{}, ErrSenderNotMember
	}
	m := &s.runs[ri].Members[mi]
	if claimedMemberID != "" && claimedMemberID != m.ID {
		return Member{}, ErrRunMemberMismatch
	}
	m.HandoffSummary = strings.TrimSpace(summary)
	out := *m
	if err := s.save(); err != nil {
		return Member{}, err
	}
	return out, nil
}

// indexOfMember 는 열린 Run 에서 멤버 하나를 찾는다. 호출자가 s.mu 를 쥔다.
func (s *Store) indexOfMember(memberID string) (runIdx, memberIdx int) {
	for ri := range s.runs {
		for mi := range s.runs[ri].Members {
			if s.runs[ri].Members[mi].ID == memberID {
				return ri, mi
			}
		}
	}
	return -1, -1
}

// HandoffClause 는 승계로 만들어진 멤버의 프리앰블에 들어가는 인수인계 절이다
// (FR-CBG-9 의 3단계). 승계가 아니면 빈 문자열이다.
//
// **요약이 없으면 없다고 적는다** (V-CBG-7). 이전 멤버가 무응답이어서 요약 없이
// 승계된 경우, 그 사실을 숨기면 후임이 "인수인계가 있었는데 내가 못 읽었나" 로
// 헤매거나, 없는 맥락을 있다고 가정한 채 일을 시작한다. 모르는 것을 모른다고
// 말하는 것은 여기서도 같은 규칙이다.
func HandoffClause(rec Record, m Member) string {
	if m.SucceededFrom == "" {
		return ""
	}
	summary := ""
	for _, c := range rec.Members {
		if c.ID == m.SucceededFrom {
			summary = strings.TrimSpace(c.HandoffSummary)
			break
		}
	}

	var b strings.Builder
	w := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }
	w("[인수인계] 이것은 **승계**다. 너는 앞선 멤버가 하던 일을 이어받는다.")
	w("  이전 멤버 %s", m.SucceededFrom)
	if summary == "" {
		w("  요약 없음 — 이전 멤버가 인수인계를 남기지 못했다. 작업 트리와 저장소")
		w("  기록에서 현재 상태를 직접 확인하고 시작해라. 진행 상황을 추측하지 마라.")
	} else {
		w("")
		w("%s", summary)
	}
	if m.Worktree != nil && m.Worktree.Path != "" {
		w("")
		w("  작업 트리는 새로 만들지 않았다 — 이전 멤버가 쓰던 그 트리다.")
		w("  진행 중이던 변경이 그대로 있으니 먼저 읽어라.")
	}
	return b.String()
}
