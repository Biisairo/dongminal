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

// withPortOf 는 포트 관측을 프로세스의 생사에 묶는다 — 살아 있으면 점유, 죽으면
// 빈 포트. 관측이 **폴링**이 된 뒤로(M8 D-A-15) 호출 횟수는 시간의 함수라 답을
// 순서로 줄 수 없다. 사실(살아 있는가)에서 파생하면 몇 번 물어도 같다.
func withPortOf(t *testing.T, f *fakeProc, occupied bool) {
	t.Helper()
	orig := pidsOnPort
	pidsOnPort = func(string) []int {
		if occupied && f.alive {
			return []int{111}
		}
		return nil
	}
	t.Cleanup(func() { pidsOnPort = orig })
}

func TestKillPortTable(t *testing.T) {
	cases := []struct {
		name      string
		occupied  bool
		dieOnTerm bool
		dieOnKill bool
		wantOK    bool
		wantTerm  int
		wantKill  int
	}{
		{
			name:   "빈 포트는 아무 신호도 보내지 않는다",
			wantOK: true,
		},
		{
			name:      "TERM 으로 비면 KILL 은 보내지 않는다",
			occupied:  true,
			dieOnTerm: true,
			wantOK:    true,
			wantTerm:  1,
		},
		{
			name:      "TERM 뒤에도 남으면 KILL 로 이어진다 — 순서가 계약이다",
			occupied:  true,
			dieOnKill: true,
			wantOK:    true,
			wantTerm:  1,
			wantKill:  1,
		},
		{
			name:     "끝까지 남으면 실패다 — 비었다고 답하지 않는다",
			occupied: true,
			wantOK:   false,
			wantTerm: 1,
			wantKill: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeProc{alive: true, dieOnTerm: tc.dieOnTerm, dieOnKill: tc.dieOnKill}
			withProc(t, f)
			withPortOf(t, f, tc.occupied)

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
