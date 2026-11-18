package toolhub

import (
	"testing"

	"dongminal/internal/shared/platform"
)

// RUN_RECOVERY_SRS TC-RRC-3: 셸 판정은 프로세스 표 위의 순수 함수다.
//
//	1(launchd) ─ 10(셸) ─ 11(shim) ─ 12(claude)
//	           └ 20(다른 셸) ─ 21(claude)
//	30(빈 셸)
func TestJudgeShell(t *testing.T) {
	parents := map[int]int{1: 0, 10: 1, 11: 10, 12: 11, 20: 1, 21: 20, 30: 1}
	cases := []struct {
		name  string
		ok    bool
		shell int
		cands []int
		want  ShellState
	}{
		{"표를 못 읽음", false, 10, []int{12}, ShellUnknown},
		{"셸 pid 모름", true, 0, nil, ShellUnknown},
		{"세션이 손자로 돈다", true, 10, []int{12}, ShellHere},
		{"셸이 세션 자신(exec)", true, 12, []int{12}, ShellHere},
		{"세션이 다른 가지에서 돈다", true, 30, []int{21}, ShellElsewhere},
		{"살아 있는 것 중 하나라도 여기면 here", true, 10, []int{21, 12}, ShellHere},
		{"후보가 표에 없음, 셸 자식 있음", true, 10, []int{99}, ShellBusy},
		{"후보 없음, 자식 없음", true, 30, nil, ShellIdle},
		// 리뷰 지적 2: 표에 셸 자신이 없으면 표가 비었거나 일부다 — 빈 셸이 아니라 모름이다.
		{"표에 셸이 없음", true, 77, nil, ShellUnknown},
		{"빈 표", true, 10, nil, ShellUnknown},
	}
	for _, c := range cases {
		table := parents
		if c.name == "빈 표" {
			table = map[int]int{}
		}
		if got := judgeShell(table, c.ok, c.shell, c.cands); got != c.want {
			t.Errorf("%s: got %s want %s", c.name, got, c.want)
		}
	}
	// 부모 고리가 있어도 끝난다.
	loop := map[int]int{5: 6, 6: 5, 40: 1}
	if got := judgeShell(loop, true, 40, []int{5}); got != ShellElsewhere {
		t.Fatalf("고리: got %s", got)
	}
}

type parentsInfo struct {
	platform.ProcInfo
	parents map[int]int
	ok      bool
}

func (p parentsInfo) Parents() (map[int]int, bool) { return p.parents, p.ok }

func TestShellProbe_UsesToolShell(t *testing.T) {
	withProcInfo(t, parentsInfo{parents: map[int]int{1001: 1, 1500: 1001}, ok: true})
	m := batchManager(t, 1)
	if got := m.ShellProbe("a", []int{1500}); got != ShellHere {
		t.Fatalf("got %s want here", got)
	}
	if got := m.ShellProbe("a", nil); got != ShellBusy {
		t.Fatalf("got %s want busy", got)
	}
	if got := m.ShellProbe("없음", nil); got != ShellUnknown {
		t.Fatalf("없는 도구: got %s want unknown", got)
	}
}
