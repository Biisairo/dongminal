package runtimebin

import (
	"io"
	"strings"
	"testing"
	"time"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-5 (SHR-10) — 훅 계열 보고는 짧은 예산으로 부른다. 공용
// 10초 클라이언트로 부르면 서버가 받아 놓고 멈췄을 때 에이전트 턴이 그만큼 선다.
func TestHookReports_UseHookBudget(t *testing.T) {
	if hookBudget <= 0 || hookBudget > 3*time.Second {
		t.Fatalf("hookBudget = %s — 훅은 에이전트의 핫패스다", hookBudget)
	}
	cap := startCapture(t, "tool-1")
	var seen []time.Duration
	restore := recordBudgets(&seen)
	defer restore()

	path := writeTranscript(t, "{}\n")
	runDmctlActivity([]string{"claude"}, hookJSON(t, map[string]any{
		"hook_event_name": "PostToolUse", "tool_name": "Bash",
		"session_id": "s-1", "transcript_path": path,
	}), io.Discard, io.Discard)
	runDmctlAgentContext([]string{"claude"}, strings.NewReader(`{"session_id":"s-1"}`), io.Discard, io.Discard)
	runDmctlNotify([]string{"attention"}, io.Discard, io.Discard)

	a, c := cap.paths()
	// activity/set · runs/context · runs/context(SessionStart) · attention/set
	if a+c != 4 {
		t.Fatalf("보고 수 = %d (activity 계열 %d, context %d)", a+c, a, c)
	}
	if len(seen) != 4 {
		t.Fatalf("예산 있는 호출 = %v — 훅 보고가 공용 10초 클라이언트로 나갔다", seen)
	}
	for _, d := range seen {
		if d != hookBudget {
			t.Fatalf("예산 = %v, want %s", seen, hookBudget)
		}
	}
}
