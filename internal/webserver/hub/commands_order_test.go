package hub

import "testing"

// ISSUE_AGENT_TREE_SRS 묶음 G·O — 그룹·순서 명령의 판정 (FR-WGR-36 · FR-ORD-6).
//
// 이동 명령은 최종 위치나 오류를 돌려준다. 결과를 기다리는 명령은 한 곳에서만 돌아야
// 한다 — 여러 브라우저가 `--next` 를 각자 적용하면 두 칸 움직인다.
func TestCmdActions_GroupAndOrder(t *testing.T) {
	awaits := []string{"newGroup", "moveTab", "moveWindow", "moveGroup"}
	for _, a := range awaits {
		if !IsAllowedCmdAction(a) {
			t.Errorf("%q 가 허용 표에 없다", a)
		}
		if !AwaitsResult(a) {
			t.Errorf("%q 는 결과를 기다려야 한다", a)
		}
		if !IsSingleExecutorAction(a) {
			t.Errorf("%q 는 단일 실행자여야 한다", a)
		}
	}
	for _, a := range []string{"renameGroup", "deleteGroup"} {
		if !IsAllowedCmdAction(a) {
			t.Errorf("%q 가 허용 표에 없다", a)
		}
	}
}

func TestCmdActions_AwaitsImpliesSingle(t *testing.T) {
	for a := range cmdActions {
		if AwaitsResult(a) && !IsSingleExecutorAction(a) {
			t.Errorf("%q 는 결과를 기다리는데 단일 실행자가 아니다", a)
		}
	}
	if !AwaitsResult("newWindow") {
		t.Error("생성 명령은 결과를 기다린다")
	}
	if AwaitsResult("tabNext") || AwaitsResult("invalid") {
		t.Error("결과를 기다리지 않는 명령이 참이다")
	}
}
