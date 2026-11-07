package run

import (
	"strings"
	"testing"
)

// ISSUE_TREE_OPS_SRS 묶음 A — 트리 프리앰블 (TC-ITA-2).

func treeFixture() (Record, Member, TreeContext) {
	rec := Record{ID: "run-1", Short: "r1", Objective: "ccr#32 이슈 트리", Tree: "o/ccr#32", CoordinatorToolID: "launcher"}
	m := Member{ID: "mem-1", Role: "ccr#32›33", Agent: "claude", ToolID: "tool-1", Brief: "피킹을 고친다",
		Assign: &Assignment{Issue: "o/ccr#33", Title: "3D 피킹", Parent: "mem-0", Goal: "35 37", CtxPct: 0}}
	tc := TreeContext{ParentToolID: "tool-0", GroupID: "grp-1", DocPath: "/home/u/.dongminal/bin/agent-plugin/commands/issue-tree.md", CtxPct: 50}
	return rec, m, tc
}

func TestTreePreamble_CarriesAssignment(t *testing.T) {
	rec, m, tc := treeFixture()
	p := TreePreamble(rec, m, tc)
	for _, want := range []string{
		"[ISSUE-TREE 배정]", "[/ISSUE-TREE]",
		"노드: o/ccr#33 — 3D 피킹",
		"사슬 이름: ccr#32›33",
		"목표 경로: 35 37",
		"부모: tool-0",
		"그룹: grp-1",
		"Run: run-1",
		"member: mem-1",
		"병렬 가지: 아니오",
		"맥락 기준: 50%",
		"커밋: 허용",
		tc.DocPath,
		"dmctl run report --run run-1 --member mem-1",
		"dmctl msg --to tool-0",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("프리앰블에 %q 가 없다:\n%s", want, p)
		}
	}
	// 배정 블록이 brief 보다 앞이다 (FR-ITA-19).
	if strings.Index(p, "[ISSUE-TREE 배정]") > strings.Index(p, "피킹을 고친다") {
		t.Error("배정이 brief 뒤에 있다")
	}
}

func TestTreePreamble_RulesReplaceCoordinatorRules(t *testing.T) {
	rec, m, tc := treeFixture()
	p := TreePreamble(rec, m, tc)
	for _, banned := range []string{"조정자", "AskUserQuestion 류의 로컬 TUI 프롬프트를", "launcher"} {
		if strings.Contains(p, banned) {
			t.Errorf("트리 프리앰블에 %q 가 있다", banned)
		}
	}
	for _, want := range []string{
		"자기 탭에서 사용자에게",               // FR-ITA-15·30
		"결정:",                        // FR-ITA-31
		"탭은 부모가 닫는다",                 // FR-ITA-16
		"이 member id 로 보고한다",         // FR-ITA-17
		"진행 중", "코멘트", "하위 이슈", "완료", // FR-ITA-18
	} {
		if !strings.Contains(p, want) {
			t.Errorf("규칙 %q 가 없다", want)
		}
	}
}

func TestTreePreamble_RootAndOptions(t *testing.T) {
	rec, m, tc := treeFixture()
	m.Assign.Parent = ""
	m.Assign.Parallel = true
	m.Assign.NoCommit = true
	m.Assign.Goal = ""
	tc.ParentToolID = ""
	tc.CtxPct = 0
	p := TreePreamble(rec, m, tc)
	for _, want := range []string{"부모: 없음", "병렬 가지: 예", "커밋: 금지", "맥락 기준: 끔", "목표 경로: 없음"} {
		if !strings.Contains(p, want) {
			t.Errorf("%q 가 없다:\n%s", want, p)
		}
	}
	if strings.Contains(p, "dmctl msg --to  ") || strings.Contains(p, "dmctl msg --to -") {
		t.Error("루트에게 빈 부모 주소를 준다")
	}
}

func TestTreePreamble_HandoffClauseKept(t *testing.T) {
	rec, m, tc := treeFixture()
	prev := Member{ID: "mem-old", HandoffSummary: "여기까지 했다"}
	m.SucceededFrom = prev.ID
	rec.Members = []Member{prev, m}
	if p := TreePreamble(rec, m, tc); !strings.Contains(p, "여기까지 했다") {
		t.Errorf("승계 인수인계 절이 없다:\n%s", p)
	}
}
