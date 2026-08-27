package cli

import "testing"

// FR-ACT-3a/3b (TC-ACT-6): 재시작 위임 판정.
//
// 위임해야 하는 경우는 하나뿐이다 — 데몬을 내리는 실행이(플래그 있음),
// 도구 안에서 돌고 있고(도구 id 있음), 아직 대리가 아닐 때(런너 표시 없음).
// 나머지는 자기 종료가 일어나지 않으므로 종전대로 그 자리에서 수행한다.
func TestShouldHandOffRestart(t *testing.T) {
	cases := []struct {
		name          string
		restartDaemon bool
		runner        string
		toolID        string
		want          bool
	}{
		{"도구 안·비대리·플래그 있음 → 위임", true, "", "tool-1", true},
		{"대리 자신은 다시 넘기지 않는다", true, "1", "tool-1", false},
		{"도구 밖은 자기 종료가 없다", true, "", "", false},
		{"데몬을 내리지 않으면 세션이 안 끊긴다", false, "", "tool-1", false},
		{"플래그도 도구도 없음", false, "", "", false},
		{"대리이고 도구 밖", true, "1", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := shouldHandOffRestart(c.restartDaemon, c.runner, c.toolID)
			if got != c.want {
				t.Fatalf("shouldHandOffRestart(%v, %q, %q) = %v, want %v",
					c.restartDaemon, c.runner, c.toolID, got, c.want)
			}
		})
	}
}
