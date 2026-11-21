package run

import "testing"

// REFACTOR3_DEFECTS_SRS TC-RD3-10: ReapTargets 가 돌려준 값을 고쳐도 저장소는 그대로다.
// 이전에는 얕은 복사라 Members 배열과 Worktree 포인터를 저장소와 함께 썼다.
func TestStore_ReapTargetsDoesNotShareInternals(t *testing.T) {
	s := newTestStore(t)
	r, err := s.Start(StartOptions{Objective: "x", Projection: DedicatedWindow, Isolation: IsolationNone, CoordinatorToolID: "t-dead",
		Worktree: &Worktree{Path: "/wt/run", Branch: "b"}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := s.AddMember(r.ID, MemberSpec{Role: "dev", Agent: "claude", ToolID: "t1",
		Worktree: &Worktree{Path: "/wt/m", Branch: "m"}}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	got := s.ReapTargets(func(id string) bool { return id == "t-dead" })
	if len(got) != 1 {
		t.Fatalf("대상 %d건", len(got))
	}
	got[0].Members[0].Role = "changed"
	got[0].Members[0].Worktree.Removed = true
	got[0].Worktree.Removed = true

	now, ok := s.Get(r.ID)
	if !ok {
		t.Fatal("Get")
	}
	if now.Members[0].Role != "dev" || now.Members[0].Worktree.Removed || now.Worktree.Removed {
		t.Fatalf("ReapTargets 의 결과가 저장소 내부를 공유한다: %+v", now)
	}
}
