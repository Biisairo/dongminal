package hub

import (
	"sort"
	"testing"
)

// FR-OPT-9-5 (IPC-19): 허용·생성·단일실행자 판정은 한 표(cmdActions)에서 파생한다.
// 생성 명령은 결과 상관(reqId)을 쓰므로 반드시 한 곳에서만 돈다 — creating ⇒ single.
func TestCmdActions_CreatingImpliesSingleExecutor(t *testing.T) {
	for a, spec := range cmdActions {
		if spec.creating && !spec.single {
			t.Errorf("%q 는 생성 명령인데 단일 실행자가 아니다", a)
		}
	}
}

func TestCmdActions_DerivedPredicates(t *testing.T) {
	names := AllowedCmdActionNames()
	if !sort.StringsAreSorted(names) || len(names) != len(cmdActions) {
		t.Fatalf("AllowedCmdActionNames: sorted=%v len=%d want %d", sort.StringsAreSorted(names), len(names), len(cmdActions))
	}
	for _, a := range names {
		if !IsAllowedCmdAction(a) {
			t.Errorf("%q 가 허용되지 않는다", a)
		}
	}
	if IsAllowedCmdAction("invalid") || IsCreatingAction("invalid") || IsSingleExecutorAction("invalid") {
		t.Error("모르는 action 은 어느 판정도 참이 아니다")
	}
	// 이름 목록은 사본이다 — 호출자가 고쳐도 표가 바뀌지 않는다.
	names[0] = "mutated"
	if IsAllowedCmdAction("mutated") {
		t.Error("AllowedCmdActionNames 가 표를 노출한다")
	}
}
