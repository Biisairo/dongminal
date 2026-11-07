package run

import (
	"fmt"
	"strings"
)

// Assignment 는 이슈 트리 노드의 배정이다 (ISSUE_TREE_OPS_SRS FR-ITA-1·2).
//
// 기동 뒤 엔벨로프로 따로 보내던 값을 기록으로 옮겼다 (D-ITO-1). 기록에 있으므로
// 프리앰블·승계·migration 이 같은 값을 쓴다 — 세션의 기억에 기대지 않는다.
type Assignment struct {
	Issue    string `json:"issue"`
	Title    string `json:"title,omitempty"`
	Parent   string `json:"parent,omitempty"` // 부모 노드의 member id. 루트는 비어 있다
	Goal     string `json:"goal,omitempty"`   // 남은 목표 경로(번호 목록)
	Parallel bool   `json:"parallel,omitempty"`
	CtxPct   int    `json:"ctxPct,omitempty"` // 0 이면 설정을 따른다 (FR-ITM-3)
	NoCommit bool   `json:"noCommit,omitempty"`
}

// AssignPatch 는 배정의 일부를 고친다 (FR-ITA-4). nil 인 필드는 그대로 둔다.
type AssignPatch struct {
	Title    *string
	Goal     *string
	Parallel *bool
	CtxPct   *int
	NoCommit *bool
}

const (
	ctxPctMin = 1
	ctxPctMax = 100
)

func cloneAssign(a *Assignment) *Assignment {
	if a == nil {
		return nil
	}
	c := *a
	return &c
}

func validCtxPct(v int) bool { return v >= ctxPctMin && v <= ctxPctMax }

// checkAssign 은 AddMember 의 배정 검사다. 호출자는 잠금을 쥐고 있다.
func (s *Store) checkAssign(rec *Record, a *Assignment) error {
	if rec.Tree == "" {
		if a != nil {
			return fmt.Errorf("%w: 배정은 트리 Run 의 멤버만 받는다", ErrInvalidArgument)
		}
		return nil
	}
	if a == nil || strings.TrimSpace(a.Issue) == "" {
		return fmt.Errorf("%w: 트리 Run 의 멤버는 --issue 가 필요하다", ErrInvalidArgument)
	}
	if a.CtxPct != 0 && !validCtxPct(a.CtxPct) {
		return fmt.Errorf("%w: --ctx 는 %d~%d 이다", ErrInvalidArgument, ctxPctMin, ctxPctMax)
	}
	if a.Parent != "" && !s.treeHasMember(rec.Tree, a.Parent) {
		return fmt.Errorf("%w: 부모 멤버 %s 가 같은 트리의 열린 Run 에 없다", ErrInvalidArgument, a.Parent)
	}
	return nil
}

func (s *Store) treeHasMember(tree, memberID string) bool {
	for _, r := range s.openTreeRuns(tree) {
		for _, m := range r.Members {
			if m.ID == memberID {
				return true
			}
		}
	}
	return false
}

// UpdateAssign 은 배정을 고친다 (FR-ITA-4). 고칠 수 있는 것은 그 멤버의 도구와
// 부모 멤버의 도구뿐이다 — 맥락 기준 정정은 부모가, 목표 경로는 자기가 고친다.
func (s *Store) UpdateAssign(callerToolID, memberID string, p AssignPatch) (Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ri, mi := s.indexOfMember(memberID)
	if ri < 0 {
		return Member{}, ErrUnknownMember
	}
	if s.runs[ri].State != Open {
		return Member{}, ErrRunClosed
	}
	m := &s.runs[ri].Members[mi]
	if m.Assign == nil {
		return Member{}, fmt.Errorf("%w: 배정이 없는 멤버다", ErrInvalidArgument)
	}
	if !s.mayAssign(callerToolID, m) {
		return Member{}, ErrSenderNotMember
	}
	if p.CtxPct != nil && !validCtxPct(*p.CtxPct) {
		return Member{}, fmt.Errorf("%w: --ctx 는 %d~%d 이다", ErrInvalidArgument, ctxPctMin, ctxPctMax)
	}
	next := *m.Assign
	if p.Title != nil {
		next.Title = strings.TrimSpace(*p.Title)
	}
	if p.Goal != nil {
		next.Goal = strings.TrimSpace(*p.Goal)
	}
	if p.Parallel != nil {
		next.Parallel = *p.Parallel
	}
	if p.CtxPct != nil {
		next.CtxPct = *p.CtxPct
	}
	if p.NoCommit != nil {
		next.NoCommit = *p.NoCommit
	}
	m.Assign = &next
	out := cloneMember(*m)
	if err := s.save(); err != nil {
		return Member{}, err
	}
	return out, nil
}

func (s *Store) mayAssign(callerToolID string, m *Member) bool {
	if callerToolID == "" {
		return false
	}
	if m.ToolID == callerToolID {
		return true
	}
	if m.Assign.Parent == "" {
		return false
	}
	pri, pmi := s.indexOfMember(m.Assign.Parent)
	return pri >= 0 && s.runs[pri].Members[pmi].ToolID == callerToolID
}
