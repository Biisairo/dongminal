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

// ISSUE_TREE_CLOSE_SRS TC-ITX-1·2: 루트의 부모는 조율 에이전트이고, 모든 트리
// 프리앰블은 종료를 스스로 하지 않고 부모에게 요청하라고 말한다.
func TestTreePreamble_RootReportsToCoordinator(t *testing.T) {
	rec, m, tc := treeFixture()
	m.Assign.Parent = ""
	tc.ParentToolID = "tool-coord"
	p := TreePreamble(rec, m, tc)
	for _, want := range []string{"부모: tool-coord — 조율 에이전트", "dmctl msg --to tool-coord"} {
		if !strings.Contains(p, want) {
			t.Errorf("%q 가 없다:\n%s", want, p)
		}
	}
}

func TestTreePreamble_CloseGoesThroughParent(t *testing.T) {
	rec, m, tc := treeFixture()
	if p := TreePreamble(rec, m, tc); !strings.Contains(p, "종료 요청") {
		t.Errorf("비루트 프리앰블에 종료 요청 규칙이 없다:\n%s", p)
	}
	m.Assign.Parent = ""
	tc.ParentToolID = ""
	if p := TreePreamble(rec, m, tc); !strings.Contains(p, "종료 요청") {
		t.Errorf("루트 프리앰블에 종료 요청 규칙이 없다:\n%s", p)
	}
}

// ISSUE_TREE_OPS_SRS FR-ITA-20: 세션을 시작할 때마다(부모가 연 세션·승계한 세션) 자기 이슈의
// 상태와 보드의 필수 필드를 확인한다. 보드 이름과 필드는 프로젝트 지시 문서가 정한다.
func TestTreePreamble_SessionStartCheck(t *testing.T) {
	rec, m, tc := treeFixture()
	p := TreePreamble(rec, m, tc)
	for _, want := range []string{
		"세션을 시작할 때마다",
		"이슈의 상태를 확인한다",
		"필수 필드가 모두 채워졌는지 확인하고, 빠진 것은 채운다",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("세션 시작 점검 %q 가 없다", want)
		}
	}
}

// FR-ITA-61~69 (TC-ITA-6): 이슈 운영 줄이 접근 규칙(권한 · 거절 시 멈춤 · 설정 기준)을 요약한다.
// 계정을 고정하지 않는다 — 어떤 이슈를 할지는 사용자가 정하고, 보는 것은 권한이다.
func TestTreePreamble_IssueAccessRules(t *testing.T) {
	rec, m, tc := treeFixture()
	p := TreePreamble(rec, m, tc)
	for _, want := range []string{
		"「이슈 접근 규칙」",
		"viewerPermission",
		"우회하지 않고 멈추고",
		"gh api user -q .login",
		"부모 이슈와 같게",
		"어사인은 그 일을 하는 사람이다",
		"나를 더할지 묻는다",
		"모르면 자기 탭에서 사용자에게 묻는다",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("프리앰블에 %q 가 없다:\n%s", want, p)
		}
	}
	if strings.Contains(p, "GitHub 계정:") {
		t.Errorf("프리앰블이 계정을 고정한다:\n%s", p)
	}
}
