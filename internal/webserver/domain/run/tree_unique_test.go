package run

import (
	"errors"
	"testing"
)

// ISSUE_AGENT_TREE_SRS 묶음 U — 같은 트리·같은 이슈를 두 번 열지 않는다 (TC-ITU-1, 저장소 쪽).

func startTree(t *testing.T, s *Store, tree string, branch bool) (Record, error) {
	t.Helper()
	return s.Start(StartOptions{Objective: "o", Projection: DedicatedWindow, Isolation: IsolationNone, Tree: tree, TreeBranch: branch})
}

func TestTree_SecondRootRejected(t *testing.T) {
	s := NewStore(t.TempDir())
	root, err := startTree(t, s, "o/r#32", false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = startTree(t, s, "o/r#32", false)
	var te *TreeOpenError
	if !errors.As(err, &te) || !errors.Is(err, ErrTreeOpen) || te.RunID != root.ID {
		t.Fatalf("err=%v", err)
	}
	// 다른 트리는 막지 않는다.
	if _, err := startTree(t, s, "o/r#33", false); err != nil {
		t.Fatalf("다른 트리: %v", err)
	}
}

func TestTree_BranchNeedsOpenRoot(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := startTree(t, s, "o/r#32", true); !errors.Is(err, ErrTreeNotOpen) {
		t.Fatalf("루트 없는 가지 err=%v", err)
	}
	if _, err := startTree(t, s, "o/r#32", false); err != nil {
		t.Fatal(err)
	}
	if _, err := startTree(t, s, "o/r#32", true); err != nil {
		t.Fatalf("루트가 있는 가지: %v", err)
	}
}

func TestTree_NodeTakenAcrossRuns(t *testing.T) {
	s := NewStore(t.TempDir())
	root, _ := startTree(t, s, "o/r#32", false)
	br, _ := startTree(t, s, "o/r#32", true)
	if _, err := s.AddMember(root.ID, MemberSpec{Role: "ccr#32›33", Agent: "claude", ToolID: "t1", Assign: &Assignment{Issue: "o/r#33"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddMember(br.ID, MemberSpec{Role: "ccr#32›33", Agent: "claude", ToolID: "t2", Assign: &Assignment{Issue: "o/r#33"}}); !errors.Is(err, ErrNodeTaken) {
		t.Fatalf("같은 이슈 err=%v", err)
	}
	if _, err := s.AddMember(br.ID, MemberSpec{Role: "ccr#32›34", Agent: "claude", ToolID: "t3", Assign: &Assignment{Issue: "o/r#34"}}); err != nil {
		t.Fatalf("다른 이슈: %v", err)
	}
	// 트리 표지 없는 Run 은 이름 중복을 막지 않는다 (종전 동작).
	plain, _ := s.Start(StartOptions{Objective: "p", Projection: DedicatedWindow, Isolation: IsolationNone})
	s.AddMember(plain.ID, MemberSpec{Role: "x", Agent: "claude", ToolID: "t4"})
	if _, err := s.AddMember(plain.ID, MemberSpec{Role: "x", Agent: "claude", ToolID: "t5"}); err != nil {
		t.Fatalf("트리 아닌 Run: %v", err)
	}
}

func TestTree_ReportedNodeDoesNotBlock(t *testing.T) {
	s := NewStore(t.TempDir())
	root, _ := startTree(t, s, "o/r#32", false)
	m, _ := s.AddMember(root.ID, MemberSpec{Role: "ccr#32›33", Agent: "claude", ToolID: "t1", Assign: &Assignment{Issue: "o/r#33"}})
	if _, err := s.Report("t1", ReportSpec{RunID: root.ID, MemberID: m.ID, Outcome: OutcomeSucceeded, Summary: "a. b. c."}); err != nil {
		t.Fatalf("report: %v", err)
	}
	if _, err := s.AddMember(root.ID, MemberSpec{Role: "ccr#32›33", Agent: "claude", ToolID: "t2", Assign: &Assignment{Issue: "o/r#33"}}); err != nil {
		t.Fatalf("보고를 마친 노드가 막았다: %v", err)
	}
}

func TestTree_ClosedRunFreesTree(t *testing.T) {
	s := NewStore(t.TempDir())
	root, _ := startTree(t, s, "o/r#32", false)
	if _, _, err := s.Close(root.ID, true); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := startTree(t, s, "o/r#32", false); err != nil {
		t.Fatalf("닫은 뒤 다시 열기: %v", err)
	}
}
