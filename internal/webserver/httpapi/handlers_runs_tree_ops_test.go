package httpapi

import (
	"net/http"
	"testing"

	"dongminal/internal/shared/activity"
	"dongminal/internal/webserver/domain/run"
)

// ISSUE_TREE_OPS_SRS 묶음 C — 배정으로 세운 트리 · 끝난 노드 · waiting-children (TC-ITC-1·2).

func treeNodesBy(t *testing.T, s *Server) ([]map[string]any, map[string]map[string]any) {
	t.Helper()
	code, out := getRun(t, s, "/api/runs/tree?ref=o/r%2332")
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	var list []map[string]any
	by := map[string]map[string]any{}
	for _, n := range out["nodes"].([]any) {
		m := n.(map[string]any)
		list = append(list, m)
		by[m["role"].(string)] = m
	}
	return list, by
}

func TestRunsTree_AssignParentsEndedNodesAndOrder(t *testing.T) {
	f := treeSucceedServer(t) // ccr#32(p) › ccr#32›33(n) › ccr#32›33›35(k)
	rec, _ := f.store.Get(f.node.RunID)
	// 형제 하나를 더하고 보고로 끝낸다 — 흔적으로 남아야 한다 (FR-ITC-3).
	f.io.setHas("tool-d", true)
	done, err := f.store.AddMember(rec.ID, run.MemberSpec{Role: "ccr#32›36", Agent: "claude", ToolID: "tool-d", Assign: &run.Assignment{Issue: "o/r#36", Title: "끝난 형제", Parent: f.parent.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.Report("tool-d", run.ReportSpec{RunID: rec.ID, MemberID: done.ID, Outcome: run.OutcomeSucceeded, Summary: "a. b. c."}); err != nil {
		t.Fatal(err)
	}
	// 중간 노드를 승계한다 — 사슬은 한 노드다 (FR-ITC-2).
	f.who.toolID = "tool-n"
	postRun(t, f.s, "/api/runs/succeed", `{"self":true,"at":"tab-c","summary":"s"}`)

	list, by := treeNodesBy(t, f.s)
	if len(list) != 4 {
		t.Fatalf("노드 수=%d %v", len(list), list)
	}
	mid := by["ccr#32›33"]
	if mid["toolId"] != "tool-c" || mid["parent"] != "ccr#32" || mid["issue"] != "o/r#33" {
		t.Fatalf("승계된 중간 노드=%v", mid)
	}
	if by["ccr#32›33›35"]["parent"] != "ccr#32›33" {
		t.Fatalf("자식이 승계자 아래에 서지 않았다: %v", by["ccr#32›33›35"])
	}
	ended := by["ccr#32›36"]
	if ended["state"] != "done" || ended["title"] != "끝난 형제" || ended["endedAt"] == nil || ended["leaf"] != false {
		t.Fatalf("끝난 노드=%v", ended)
	}
	// 깊이 우선, 같은 부모의 자식은 등록 순서 (FR-ITC-3·8).
	var order []string
	for _, n := range list {
		order = append(order, n["role"].(string))
	}
	want := []string{"ccr#32", "ccr#32›33", "ccr#32›33›35", "ccr#32›36"}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("순서=%v want %v", order, want)
		}
	}
}

// FR-ITC-4: 상태 판정은 순수 함수다 — 훅 상태·생존·열린 자식에서 정한다.
func TestMemberStateFrom(t *testing.T) {
	cases := []struct {
		name     string
		recorded run.MemberState
		live     bool
		hook     string
		children bool
		want     run.MemberState
	}{
		{"쉬는 중간 노드", "", true, activity.Idle, true, run.WaitingChildren},
		{"턴을 끝낸 중간 노드", "", true, activity.Done, true, run.WaitingChildren},
		{"일하는 중간 노드", "", true, activity.Working, true, run.Working},
		{"묻는 중간 노드", "", true, activity.Waiting, true, run.Waiting},
		{"쉬는 잎", "", true, activity.Idle, false, run.Ready},
		{"죽은 중간 노드", "", false, activity.Idle, true, run.Lost},
		{"보고한 노드", run.Done, true, activity.Idle, true, run.Done},
		{"보고 없음", "", true, "", true, run.Starting},
	}
	for _, c := range cases {
		if got := memberStateFrom(c.recorded, c.live, c.hook, c.children); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
}

func TestToolStatus_CarriesMemberState(t *testing.T) {
	f := treeSucceedServer(t)
	writer, _ := f.store.MemberByTool("tool-b") // ctxServer 의 실제 도구
	code, out := getRun(t, f.s, "/api/tools/activity/get?id=tool-b")
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	m, _ := out["member"].(map[string]any)
	if m == nil || m["id"] != writer.ID || m["state"] != string(f.s.deriveMemberState(writer)) {
		t.Fatalf("member=%v", out["member"])
	}
	if _, out := getRun(t, f.s, "/api/tools/activity/get?id=tool-a"); out["member"] != nil {
		t.Fatalf("멤버 아닌 도구에 member=%v", out["member"])
	}
}
