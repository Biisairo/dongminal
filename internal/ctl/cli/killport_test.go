package cli

import (
	"bytes"
	"testing"
)

// `TEST-3`(PRODUCTION_ROADMAP §M3) — 포트킬 경로의 검사.
//
// 이 경로에는 검사가 하나도 없었다. 그런데 하는 일은 **남의 프로세스에 신호를
// 보내는 것**이다 — 이 저장소에서 가장 되돌릴 수 없는 조작이고, `FBE-07` 이
// 같은 부류의 결함을 이미 하나 보여 줬다.

// withPorts 는 포트 관측을 갈아 끼운다. 호출마다 다음 답을 준다 — TERM 뒤에도
// 남아 있는 상황을 만들려면 관측이 시간에 따라 달라져야 한다.
func withPorts(t *testing.T, answers [][]int) {
	t.Helper()
	orig := pidsOnPort
	i := 0
	pidsOnPort = func(string) []int {
		if i >= len(answers) {
			return nil
		}
		v := answers[i]
		i++
		return v
	}
	t.Cleanup(func() { pidsOnPort = orig })
}

func TestKillPortTable(t *testing.T) {
	cases := []struct {
		name      string
		answers   [][]int
		dieOnTerm bool
		wantOK    bool
		wantTerm  int
		wantKill  int
	}{
		{
			name:    "빈 포트는 아무 신호도 보내지 않는다",
			answers: [][]int{nil},
			wantOK:  true,
		},
		{
			name:      "TERM 으로 비면 KILL 은 보내지 않는다",
			answers:   [][]int{{111}, nil},
			dieOnTerm: true,
			wantOK:    true,
			wantTerm:  1,
		},
		{
			name:     "TERM 뒤에도 남으면 KILL 로 이어진다 — 순서가 계약이다",
			answers:  [][]int{{111}, {111}, nil},
			wantOK:   true,
			wantTerm: 1,
			wantKill: 1,
		},
		{
			name:     "끝까지 남으면 실패다 — 비었다고 답하지 않는다",
			answers:  [][]int{{111}, {111}, {111}},
			wantOK:   false,
			wantTerm: 1,
			wantKill: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeProc{alive: true, dieOnTerm: tc.dieOnTerm}
			withProc(t, f)
			withPorts(t, tc.answers)

			var out bytes.Buffer
			if got := killPort("54321", &out, "테스트"); got != tc.wantOK {
				t.Errorf("killPort=%v want %v", got, tc.wantOK)
			}
			if f.terms != tc.wantTerm {
				t.Errorf("Terminate=%d want %d", f.terms, tc.wantTerm)
			}
			if f.kills != tc.wantKill {
				t.Errorf("Kill=%d want %d", f.kills, tc.wantKill)
			}
		})
	}
}
