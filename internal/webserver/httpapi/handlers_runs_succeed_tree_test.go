package httpapi

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/run"
)

// ISSUE_TREE_OPS_SRS 묶음 B — 자기 승계와 트리 알림 (TC-ITB-1~3).

type treeSucceedFix struct {
	s                   *Server
	store               *run.Store
	io                  *fakeToolIO
	who                 *fakeWhoAmI
	parent, node, child run.Member
}

func treeSucceedServer(t *testing.T) treeSucceedFix {
	t.Helper()
	s, store, io, _, _ := ctxServer(t)
	wi := s.WorkIndex.(*fakeWorkIndex)
	for _, id := range []string{"tool-p", "tool-k"} {
		io.setHas(id, true)
		wi.resolve[id] = id
	}
	rec, err := store.Start(run.StartOptions{Objective: "트리", Projection: run.DedicatedWindow, Isolation: run.IsolationNone, Tree: "o/r#32"})
	if err != nil {
		t.Fatal(err)
	}
	add := func(role, tool string, a *run.Assignment) run.Member {
		m, err := store.AddMember(rec.ID, run.MemberSpec{Role: role, Agent: "claude", ToolID: tool, TabID: "tab-" + tool, Assign: a})
		if err != nil {
			t.Fatalf("AddMember %s: %v", role, err)
		}
		return m
	}
	p := add("ccr#32", "tool-p", &run.Assignment{Issue: "o/r#32"})
	n := add("ccr#32›33", "tool-n", &run.Assignment{Issue: "o/r#33", Parent: p.ID})
	k := add("ccr#32›33›35", "tool-k", &run.Assignment{Issue: "o/r#35", Parent: n.ID})
	io.setHas("tool-n", true)
	who := s.WhoAmI.(*fakeWhoAmI)
	return treeSucceedFix{s: s, store: store, io: io, who: who, parent: p, node: n, child: k}
}

func TestRunSucceed_SelfDoesNotAskAndCarriesSummary(t *testing.T) {
	f := treeSucceedServer(t)
	f.who.toolID = "tool-n"
	start := time.Now()
	code, out := postRun(t, f.s, "/api/runs/succeed", `{"self":true,"at":"tab-c","summary":"여기까지 했다"}`)
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("자기 승계가 인수인계를 기다렸다: %s", d)
	}
	if out["hasSummary"] != true || out["prevMemberId"] != f.node.ID {
		t.Fatalf("out=%v", out)
	}
	for _, p := range f.io.pastes {
		if p.ToolID == "tool-n" && strings.Contains(p.Text, "HANDOFF-REQUEST") {
			t.Fatalf("자기에게 인수인계를 청했다")
		}
	}
	m := out["member"].(map[string]any)
	pre, _ := m["preamble"].(string)
	if !strings.Contains(pre, "여기까지 했다") || !strings.Contains(pre, "[ISSUE-TREE 배정]") || !strings.Contains(pre, "부모: tool-p") {
		t.Fatalf("프리앰블:\n%s", pre)
	}
	newID := m["id"].(string)
	// FR-ITB-3: 부모·자식에게 알리고, 자식의 배정 부모를 새 멤버로 바꾼다.
	told := map[string]bool{}
	for _, p := range f.io.pastes {
		if strings.Contains(p.Text, "[ISSUE-TREE 승계] ccr#32›33") && strings.Contains(p.Text, "tool-c") && strings.Contains(p.Text, newID) {
			told[p.ToolID] = true
		}
	}
	if !told["tool-p"] || !told["tool-k"] {
		t.Fatalf("알림 대상=%v", told)
	}
	if _, k, _ := f.store.FindMember(f.child.ID); k.Assign.Parent != newID {
		t.Fatalf("자식의 부모가 바뀌지 않았다: %+v", k.Assign)
	}
}

func TestRunSucceed_SelfRefusals(t *testing.T) {
	f := treeSucceedServer(t)
	f.who.toolID = "tool-x"
	if code, out := postRun(t, f.s, "/api/runs/succeed", `{"self":true,"at":"tab-c","summary":"s"}`); code == http.StatusOK || out["error"] != "sender_not_member" {
		t.Fatalf("멤버 아닌 도구의 자기 승계 code=%d %v", code, out)
	}
	f.who.toolID = "tool-n"
	body := fmt.Sprintf(`{"self":true,"memberId":%q,"at":"tab-c","summary":"s"}`, f.parent.ID)
	if code, out := postRun(t, f.s, "/api/runs/succeed", body); code == http.StatusOK || out["error"] != "sender_not_member" {
		t.Fatalf("남을 --self 로 승계 code=%d %v", code, out)
	}
}

func TestRunMember_NodeTakenCarriesHolder(t *testing.T) {
	f := treeSucceedServer(t)
	f.io.setHas("tool-n", false) // 옛 탭이 닫혔다 → lost
	code, out := postRun(t, f.s, "/api/runs/members", fmt.Sprintf(
		`{"runId":%q,"role":"ccr#32›33","agent":"claude","id":"tab-c","assign":{"issue":"o/r#33"}}`, f.node.RunID))
	if code != http.StatusConflict || out["error"] != "node_taken" || out["memberId"] != f.node.ID || out["state"] != "lost" {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if hint, _ := out["hint"].(string); !strings.Contains(hint, "dmctl run succeed --member "+f.node.ID) {
		t.Fatalf("lost 멤버의 이어받기 안내가 없다: %v", out)
	}
}

// TC-ITB-4 (FR-ITB-6): who-am-i 가 Run 멤버이면 member 를 싣는다.
func TestWhoAmI_CarriesMember(t *testing.T) {
	f := treeSucceedServer(t)
	f.who.toolID = "tool-n"
	code, out := getRun(t, f.s, "/api/whoami")
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	m, _ := out["member"].(map[string]any)
	if m == nil || m["id"] != f.node.ID || m["runId"] != f.node.RunID || m["role"] != "ccr#32›33" || m["tree"] != "o/r#32" {
		t.Fatalf("member=%v", out["member"])
	}
	f.who.toolID = "tool-x"
	if _, out := getRun(t, f.s, "/api/whoami"); out["member"] != nil {
		t.Fatalf("멤버 아닌 도구에 member=%v", out["member"])
	}
}
