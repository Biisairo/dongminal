package run

import (
	"errors"
	"testing"
)

// ISSUE_TREE_OPS_SRS 묶음 A — 배정은 기록이다 (TC-ITA-1, 저장소 쪽).

func treeMember(t *testing.T, s *Store, runID, role, tool string, a *Assignment) Member {
	t.Helper()
	m, err := s.AddMember(runID, MemberSpec{Role: role, Agent: "claude", ToolID: tool, Assign: a})
	if err != nil {
		t.Fatalf("AddMember %s: %v", role, err)
	}
	return m
}

func TestAssign_StoredOnTreeMember(t *testing.T) {
	s := NewStore(t.TempDir(), "e")
	root, _ := startTree(t, s, "o/r#32", false)
	a := &Assignment{Issue: "o/r#32", Title: "루트", Goal: "33 35", CtxPct: 40, NoCommit: true}
	m := treeMember(t, s, root.ID, "ccr#32", "t1", a)
	if m.Assign == nil || *m.Assign != *a {
		t.Fatalf("assign=%+v", m.Assign)
	}
	a.Title = "바뀜"
	if _, got, _ := s.FindMember(m.ID); got.Assign.Title != "루트" {
		t.Fatalf("저장소가 호출자의 값을 공유한다: %+v", got.Assign)
	}
}

func TestAssign_Rejections(t *testing.T) {
	s := NewStore(t.TempDir(), "e")
	root, _ := startTree(t, s, "o/r#32", false)
	plain, _ := s.Start(StartOptions{Objective: "p", Projection: DedicatedWindow, Isolation: IsolationNone})
	cases := []struct {
		name string
		run  string
		spec MemberSpec
	}{
		{"트리 아닌 Run 에 배정", plain.ID, MemberSpec{Role: "x", Agent: "claude", ToolID: "a1", Assign: &Assignment{Issue: "o/r#1"}}},
		{"트리 멤버에 배정 없음", root.ID, MemberSpec{Role: "ccr#32", Agent: "claude", ToolID: "a2"}},
		{"트리 멤버에 이슈 없음", root.ID, MemberSpec{Role: "ccr#32", Agent: "claude", ToolID: "a3", Assign: &Assignment{Title: "t"}}},
		{"없는 부모", root.ID, MemberSpec{Role: "ccr#32›33", Agent: "claude", ToolID: "a4", Assign: &Assignment{Issue: "o/r#33", Parent: "nope"}}},
		{"맥락 기준 범위 밖", root.ID, MemberSpec{Role: "ccr#32", Agent: "claude", ToolID: "a5", Assign: &Assignment{Issue: "o/r#32", CtxPct: 101}}},
	}
	for _, c := range cases {
		if _, err := s.AddMember(c.run, c.spec); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("%s: err=%v", c.name, err)
		}
	}
}

func TestAssign_ParentInOtherRunOfSameTree(t *testing.T) {
	s := NewStore(t.TempDir(), "e")
	root, _ := startTree(t, s, "o/r#32", false)
	br, _ := startTree(t, s, "o/r#32", true)
	p := treeMember(t, s, root.ID, "ccr#32", "t1", &Assignment{Issue: "o/r#32"})
	treeMember(t, s, br.ID, "ccr#32›34", "t2", &Assignment{Issue: "o/r#34", Parent: p.ID, Parallel: true})
	other, _ := startTree(t, s, "o/r#90", false)
	if _, err := s.AddMember(other.ID, MemberSpec{Role: "x#90›91", Agent: "claude", ToolID: "t3", Assign: &Assignment{Issue: "o/r#91", Parent: p.ID}}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("다른 트리의 부모 err=%v", err)
	}
}

func TestAssign_InheritedBySuccession(t *testing.T) {
	s := NewStore(t.TempDir(), "e")
	root, _ := startTree(t, s, "o/r#32", false)
	m := treeMember(t, s, root.ID, "ccr#32", "t1", &Assignment{Issue: "o/r#32", CtxPct: 30})
	_, next, err := s.Succeed(SucceedSpec{PrevMemberID: m.ID, ToolID: "t2"})
	if err != nil {
		t.Fatal(err)
	}
	if next.Assign == nil || next.Assign.Issue != "o/r#32" || next.Assign.CtxPct != 30 {
		t.Fatalf("승계가 배정을 물려받지 않았다: %+v", next.Assign)
	}
}

func TestAssign_Update(t *testing.T) {
	s := NewStore(t.TempDir(), "e")
	root, _ := startTree(t, s, "o/r#32", false)
	p := treeMember(t, s, root.ID, "ccr#32", "tp", &Assignment{Issue: "o/r#32"})
	c := treeMember(t, s, root.ID, "ccr#32›33", "tc", &Assignment{Issue: "o/r#33", Parent: p.ID})
	ctx := 45
	// 자기 자신.
	got, err := s.UpdateAssign("tc", c.ID, AssignPatch{CtxPct: &ctx})
	if err != nil || got.Assign.CtxPct != 45 || got.Assign.Issue != "o/r#33" {
		t.Fatalf("자기 수정 got=%+v err=%v", got.Assign, err)
	}
	// 부모.
	goal := "40"
	if _, err := s.UpdateAssign("tp", c.ID, AssignPatch{Goal: &goal}); err != nil {
		t.Fatalf("부모 수정: %v", err)
	}
	// 남.
	if _, err := s.UpdateAssign("stranger", c.ID, AssignPatch{Goal: &goal}); !errors.Is(err, ErrSenderNotMember) {
		t.Fatalf("남의 수정 err=%v", err)
	}
	bad := 0
	if _, err := s.UpdateAssign("tc", c.ID, AssignPatch{CtxPct: &bad}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("범위 밖 err=%v", err)
	}
}

// ISSUE_TREE_OPS_SRS FR-ITC-4: 열린 배정 자식이 있는가. 끝난 자식·승계된 자식은 세지 않는다.
func TestHasOpenChild(t *testing.T) {
	s := NewStore(t.TempDir(), "e")
	root, _ := startTree(t, s, "o/r#32", false)
	p := treeMember(t, s, root.ID, "ccr#32", "tp", &Assignment{Issue: "o/r#32"})
	if s.HasOpenChild(p.ID) {
		t.Fatal("자식이 없는데 참")
	}
	c := treeMember(t, s, root.ID, "ccr#32›33", "tc", &Assignment{Issue: "o/r#33", Parent: p.ID})
	if !s.HasOpenChild(p.ID) {
		t.Fatal("열린 자식이 있는데 거짓")
	}
	_, next, _ := s.Succeed(SucceedSpec{PrevMemberID: c.ID, ToolID: "tc2"})
	if !s.HasOpenChild(p.ID) {
		t.Fatal("승계자는 여전히 열린 자식이다")
	}
	if _, err := s.Report("tc2", ReportSpec{RunID: root.ID, MemberID: next.ID, Outcome: OutcomeSucceeded, Summary: "a. b. c."}); err != nil {
		t.Fatal(err)
	}
	if s.HasOpenChild(p.ID) {
		t.Fatal("보고를 마친 자식을 열린 자식으로 셌다")
	}
}
