package run

import (
	"fmt"
	"strings"

	"dongminal/internal/shared/agentadapter"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `store.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **Run 을 바꾸는 일**이다 — 시작·멤버 추가·보고·닫기·쓸기·삭제.
// `store.go` 에 남은 것은 파일을 읽고 쓰는 일과 조회이며, 수명 규칙이 바뀌어도
// 그 저장 방식은 바뀌지 않는다.

// StartOptions is the input of Start.
type StartOptions struct {
	// ID 를 호출자가 미리 정할 수 있다. 격리 Run 이 그렇게 한다 — worktree 경로가
	// run.short 에서 파생되므로(FR-WKT-3) 레코드가 생기기 **전에** id 가 필요하고,
	// 생성이 실패하면 레코드가 아예 없어야 고아 Run 이 남지 않는다. 비우면 저장소가
	// 발급한다.
	ID                string
	Objective         string
	Projection        Projection
	Isolation         Isolation
	CoordinatorToolID string
	WindowID          string
	Repo              string
	Base              string
	Worktree          *Worktree
}

// Start opens a Run.
func (s *Store) Start(opt StartOptions) (Record, error) {
	if strings.TrimSpace(opt.Objective) == "" {
		return Record{}, fmt.Errorf("%w: objective 는 비어 있을 수 없다", ErrInvalidArgument)
	}
	if !opt.Projection.Valid() {
		return Record{}, fmt.Errorf("%w: 알 수 없는 projection: %q", ErrInvalidArgument, opt.Projection)
	}
	if !opt.Isolation.Valid() {
		return Record{}, fmt.Errorf("%w: 알 수 없는 isolation: %q", ErrInvalidArgument, opt.Isolation)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	id := strings.TrimSpace(opt.ID)
	if id == "" {
		id = s.newID()
	}
	rec := Record{
		ID:                id,
		Short:             Short(id),
		Objective:         strings.TrimSpace(opt.Objective),
		Projection:        opt.Projection,
		Isolation:         opt.Isolation,
		State:             Open,
		Epoch:             s.epoch,
		CoordinatorToolID: opt.CoordinatorToolID,
		WindowID:          opt.WindowID,
		Repo:              opt.Repo,
		Base:              opt.Base,
		Worktree:          opt.Worktree,
		CreatedAt:         s.now(),
	}
	s.runs = append([]Record{rec}, s.runs...)
	if err := s.save(); err != nil {
		return Record{}, err
	}
	// FR-SAF-4: rec.Worktree 는 호출자가 준 포인터이고 s.runs 가 같은 것을 든다.
	return cloneRun(rec), nil
}

// MemberSpec is the input of AddMember.
type MemberSpec struct {
	// ID 는 StartOptions.ID 와 같은 이유로 미리 정할 수 있다 — worktree 경로가
	// member.short 에서 파생된다 (FR-WKT-3).
	ID    string
	Role  string
	Agent string
	// Brief 는 이 멤버가 할 일의 본문이다. 프리앰블에 그대로 실리며, 기록에
	// 남기는 이유는 조정자가 컨텍스트를 잃어도 프리앰블을 다시 만들 수 있어야
	// 하기 때문이다 (FR-PRE-1).
	Brief    string
	ToolID   string
	TabID    string
	Worktree *Worktree
	// Headless 는 이 멤버가 어떤 탭에도 붙지 않음을 뜻한다 (FR-HLM-2). TabID 가
	// 비는 것과 짝이며, 부착(FR-HLM-6)되면 TabID 가 채워지고 이 값은 false 가
	// 된다 — 둘을 함께 보아야 "지금 화면에 있나" 를 알 수 있다.
	Headless bool
}

// AddMember binds a tool to a Run. The binding is 1:1 — a tool that already
// belongs to an open Run cannot be claimed by another (FR-RUN-2).
func (s *Store) AddMember(runID string, spec MemberSpec) (Member, error) {
	if strings.TrimSpace(spec.Role) == "" || strings.TrimSpace(spec.Agent) == "" || strings.TrimSpace(spec.ToolID) == "" {
		return Member{}, fmt.Errorf("%w: role·agent·toolId 는 모두 필요하다", ErrInvalidArgument)
	}
	// FR-ADP-3: 알 수 없는 에이전트 id 를 기록에 들이지 않는다. 들어오면 훅도
	// 프리앰블도 기동줄도 만들 수 없는 멤버가 남고, 그 사실이 한참 뒤에야 드러난다.
	if _, err := agentadapter.Get(strings.TrimSpace(spec.Agent)); err != nil {
		return Member{}, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return Member{}, ErrUnknownRun
	}
	if s.runs[idx].State != Open {
		return Member{}, ErrRunClosed
	}
	if _, _, ok := s.findByTool(spec.ToolID); ok {
		return Member{}, ErrToolAlreadyMember
	}
	memberID := strings.TrimSpace(spec.ID)
	if memberID == "" {
		memberID = s.newID()
	}
	m := Member{
		ID:        memberID,
		RunID:     runID,
		Role:      strings.TrimSpace(spec.Role),
		Agent:     strings.TrimSpace(spec.Agent),
		Brief:     strings.TrimSpace(spec.Brief),
		ToolID:    spec.ToolID,
		TabID:     spec.TabID,
		Worktree:  spec.Worktree,
		Headless:  spec.Headless,
		State:     Starting,
		CreatedAt: s.now(),
	}
	s.runs[idx].Members = append(s.runs[idx].Members, m)
	if err := s.save(); err != nil {
		return Member{}, err
	}
	return cloneMember(m), nil
}

// ReportSpec is the input of Report. RunID/MemberID are corroboration only —
// the sender's identity decides which member is reporting (FR-PRE-5).
type ReportSpec struct {
	RunID         string
	MemberID      string
	Outcome       Outcome
	Summary       string
	FilesModified []string
}

// Report records a member's one terminal report.
func (s *Store) Report(senderToolID string, spec ReportSpec) (Member, error) {
	switch spec.Outcome {
	case OutcomeSucceeded, OutcomeFailed:
	default:
		return Member{}, fmt.Errorf("%w: outcome 은 succeeded 또는 failed 여야 한다: %q", ErrInvalidArgument, spec.Outcome)
	}
	if strings.TrimSpace(spec.Summary) == "" {
		return Member{}, fmt.Errorf("%w: summary 는 비어 있을 수 없다 — 조정자가 먼저 읽는 것이다", ErrInvalidArgument)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	ri, mi, ok := s.findByTool(senderToolID)
	if !ok {
		// 닫힌 Run 의 멤버였다면 "멤버가 아니다"는 오진이다 — 늦은 보고와
		// 남의 보고는 다른 문제이고, 조정자가 다르게 대응해야 한다.
		if s.wasMemberOfClosedRun(senderToolID) {
			return Member{}, ErrRunClosed
		}
		return Member{}, ErrSenderNotMember
	}
	rec := &s.runs[ri]
	m := &rec.Members[mi]
	// 페이로드를 아는 것은 권한이 아니다 — 실려 온 id 는 발신자와 일치해야 한다.
	if (spec.RunID != "" && spec.RunID != rec.ID) || (spec.MemberID != "" && spec.MemberID != m.ID) {
		return Member{}, ErrRunMemberMismatch
	}
	if m.Reported() {
		return Member{}, ErrAlreadyReported
	}
	m.Outcome = spec.Outcome
	m.Summary = strings.TrimSpace(spec.Summary)
	m.FilesModified = spec.FilesModified
	m.ReportedAt = s.now()
	if spec.Outcome == OutcomeSucceeded {
		m.State = Done
	} else {
		m.State = Failed
	}
	out := cloneMember(*m)
	if err := s.save(); err != nil {
		return Member{}, err
	}
	return out, nil
}

// Close ends a Run. Without force it refuses while any member has not reported
// and returns that list (FR-RUN-11) — a worker that never reported is not
// proof of completion, and closing would drop the only record of it.
func (s *Store) Close(runID string, force bool) (Record, []Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return Record{}, nil, ErrUnknownRun
	}
	rec := &s.runs[idx]
	if rec.State != Open {
		return Record{}, nil, ErrRunClosed
	}
	var pending []Member
	for _, m := range rec.Members {
		if !m.settled() {
			pending = append(pending, cloneMember(m))
		}
	}
	if len(pending) > 0 && !force {
		return Record{}, pending, ErrUnreportedMembers
	}
	rec.State = Closed
	rec.ClosedAt = s.now()
	out := cloneRun(*rec)
	if err := s.save(); err != nil {
		return Record{}, nil, err
	}
	return out, pending, nil
}

// Sweep 는 이미 끝난 Run(closed·aborted)의 **정리 재진입**이다 (FR-WKT-8a).
//
// 상태를 바꾸지 않는다. 끝난 사실은 기록이고 정리가 그것을 고쳐 쓰지 않는다 —
// aborted 가 closed 로 둔갑하면 왜 끝났는지 아는 유일한 근거가 사라진다. 미보고
// 멤버 검사도 하지 않는다(FR-RUN-11): 기다릴 보고가 남아 있지 않다.
func (s *Store) Sweep(runID string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return Record{}, ErrUnknownRun
	}
	if s.runs[idx].State == Open {
		return Record{}, ErrRunOpen
	}
	return cloneRun(s.runs[idx]), nil
}

// Delete 는 레코드를 지운다 (UX_REVISION_SRS FR-DEL-7).
//
// **여기서는 worktree 를 보지 않는다.** 정리의 근거(WorktreeTargets)는 레코드에
// 있으므로 호출자가 먼저 거두고 나서 지워야 한다 (FR-DEL-8) — 순서가 뒤집히면
// 트리를 지울 근거가 사라져 영원히 남는다. 저장소는 파일시스템을 모르므로 그
// 순서를 강제할 수 없고, 대신 여기 적어 둔다.
func (s *Store) Delete(runID string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return Record{}, ErrUnknownRun
	}
	rec := cloneRun(s.runs[idx])
	s.runs = append(s.runs[:idx], s.runs[idx+1:]...)
	if err := s.save(); err != nil {
		return Record{}, err
	}
	return rec, nil
}

// ReapTargets 는 자동 제거 대상을 고른다 (FR-DEL-12/13/15).
//
// 둘이다: ① 이미 끝난 Run(closed·aborted) ② 조정자 도구가 살아 있지 않은 열린 Run.
// 조정자를 모르는 Run(CoordinatorToolID 가 빈 값)은 **대상이 아니다** — 판정할
// 근거가 없는 것을 죽음으로 읽으면, 근거가 없다는 이유로 남의 Run 을 지운다.
//
// alive 는 호출자가 준다. 저장소는 도구의 생존을 모른다.
func (s *Store) ReapTargets(alive func(toolID string) bool) []Record {
	s.mu.Lock()
	defer s.mu.Unlock()

	var out []Record
	for _, r := range s.runs {
		if r.State != Open {
			out = append(out, r)
			continue
		}
		if r.CoordinatorToolID == "" {
			continue
		}
		if alive == nil || !alive(r.CoordinatorToolID) {
			out = append(out, r)
		}
	}
	return out
}

// WorktreeMark 는 정리 한 건의 결과다. Path 로 대상을 지목한다.
type WorktreeMark struct {
	Path    string
	Removed bool
	Residue string
	Detail  string
}

// MarkWorktrees 는 정리 결과를 기록에 반영한다 (FR-WKT-12).
//
// Path 로 지목하는 이유는 per-run 의 공유 트리가 레코드와 멤버 양쪽에 걸려 있기
// 때문이다 — 같은 경로를 가리키는 모든 자리에 같은 결과가 적혀야 조회가 엇갈리지
// 않는다.
func (s *Store) MarkWorktrees(runID string, marks []WorktreeMark) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return ErrUnknownRun
	}
	rec := &s.runs[idx]
	for _, mk := range marks {
		if mk.Path == "" {
			continue
		}
		apply := func(w *Worktree) {
			if w == nil || w.Path != mk.Path {
				return
			}
			w.Removed, w.Residue, w.Detail = mk.Removed, mk.Residue, mk.Detail
		}
		apply(rec.Worktree)
		for mi := range rec.Members {
			apply(rec.Members[mi].Worktree)
		}
	}
	return s.save()
}

// WorktreeTargets 는 이 Run 이 **만든** worktree 만 돌려준다 (FR-WKT-9).
//
// 정리의 유일한 근거다. 파일시스템을 훑어 "worktree 처럼 보이는 것"을 지우지
// 않는다 — 사용자가 만든 트리가 그 안에 있어도 알 방법이 없기 때문이다.
func (r Record) WorktreeTargets() []Worktree {
	seen := map[string]bool{}
	var out []Worktree
	add := func(w *Worktree) {
		// 이미 제거된 트리는 대상이 아니다 — 정리 재진입(FR-WKT-8a)이 사라진
		// 경로를 다시 지우려 들면 없던 잔여물을 만들어 낸다.
		if w == nil || w.Path == "" || w.Removed || seen[w.Path] {
			return
		}
		seen[w.Path] = true
		out = append(out, *w)
	}
	add(r.Worktree)
	for _, m := range r.Members {
		add(m.Worktree)
	}
	return out
}
