package hub

import (
	"bytes"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// ATTENTION_FIRING_SRS 묶음 F 의 데몬 모드 검증. 직접 모드와 **같은 항목**을
// 같은 순서로 잰다 (FR-ATF-12·NFR-4) — 한쪽에만 있는 판정을 만들지 않기 위해서다.

// firingTracker 는 무장까지 세운 상태의 추적기를 만든다. 출력 한 조각이 곧
// 무장이므로, 잠금이 없는 한 FeedOutput 이 그 일을 한다.
func firingTracker(idleMS int) (*AttnTracker, *fakeBroker) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, idleMS)
	tr.SetBusyProbe(func(string) bool { return true })
	return tr, fb
}

func firedIdle(fb *fakeBroker, toolID string) int {
	n := 0
	for _, p := range fb.sent {
		if bytes.Contains(p, []byte(`"action":"tool_attention"`)) &&
			bytes.Contains(p, []byte(`"toolId":"`+toolID+`"`)) &&
			bytes.Contains(p, []byte(`"reason":"idle"`)) {
			n++
		}
	}
	return n
}

// V-ATF-1: 활동을 보고한 적 없는 도구는 울지 않는다.
func TestAttnTracker_Idle_OnlyAgentTools(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	tr.FeedOutput("plain", []byte("x"))

	tr.SweepIdleAt(int64(2_000) * 1e6)

	if got := firedIdle(fb, "plain"); got != 0 {
		t.Fatalf("에이전트가 아닌 도구가 울었다: %d", got)
	}
}

// V-ATF-2: 활동을 보고한 도구는 운다.
func TestAttnTracker_Idle_AgentToolFires(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	tr.SetActivity("agent", "done", "", "")
	tr.FeedOutput("agent", []byte("x"))

	tr.SweepIdleAt(int64(2_000) * 1e6)

	if got := firedIdle(fb, "agent"); got != 1 {
		t.Fatalf("에이전트 도구가 울지 않았다: %d", got)
	}
}

// V-ATF-3: `ended` 는 에이전트 표시를 내린다.
func TestAttnTracker_Idle_EndedRevokesAgentMark(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	tr.SetActivity("agent", "done", "", "")
	tr.SetActivity("agent", "ended", "", "")
	tr.FeedOutput("agent", []byte("x"))

	tr.SweepIdleAt(int64(2_000) * 1e6)

	if got := firedIdle(fb, "agent"); got != 0 {
		t.Fatalf("세션이 끝난 도구가 울었다: %d", got)
	}
}

// V-ATF-4·5: 주목 뒤에는 출력만으로 되살아나지 않고, 키 입력 뒤에만 다시 운다.
func TestAttnTracker_Rearm_RequiresUserInput(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	tr.SetActivity("agent", "done", "", "")
	tr.FeedOutput("agent", []byte("x"))
	tr.SweepIdleAt(int64(2_000) * 1e6)
	if got := firedIdle(fb, "agent"); got != 1 {
		t.Fatalf("첫 발화가 없다: %d", got)
	}

	tr.Attend("agent")
	tr.FeedOutput("agent", []byte("tui redraw"))
	tr.SweepIdleAt(int64(4_000) * 1e6)
	if got := firedIdle(fb, "agent"); got != 1 {
		t.Fatalf("주목 뒤 출력만으로 다시 울었다: %d", got)
	}

	tr.AttendTyped("agent")
	tr.FeedOutput("agent", []byte("agent works"))
	tr.SweepIdleAt(int64(6_000) * 1e6)
	if got := firedIdle(fb, "agent"); got != 2 {
		t.Fatalf("입력 뒤 정적에서 울지 않았다: %d", got)
	}
}

// V-ATF-6: 잠금은 L1 을 삼키지 않는다.
func TestAttnTracker_Rearm_LockDoesNotSilenceL1(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.Attend("agent")

	tr.FeedOutput("agent", []byte("\x1b]9;done\x07"))

	var signaled bool
	for _, p := range fb.sent {
		if bytes.Contains(p, []byte(`"reason":"signaled"`)) &&
			bytes.Contains(p, []byte(`"toolId":"agent"`)) {
			signaled = true
		}
	}
	if !signaled {
		t.Fatalf("잠금이 OSC 신호를 삼켰다: %q", fb.sent)
	}
}

// V-ATF-7: 굳은 working 은 억제하지 않는다.
func TestAttnTracker_Idle_StaleWorkingDoesNotSuppress(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	tr.SetActivity("agent", "working", "Bash", "make")
	tr.FeedOutput("agent", []byte("x"))

	tr.SweepIdleAt(int64(2_000) * 1e6)
	if got := firedIdle(fb, "agent"); got != 0 {
		t.Fatalf("신선한 working 이 억제되지 않았다: %d", got)
	}

	tr.FeedOutput("agent", []byte("x")) // 재무장(주목한 적이 없으므로 잠금 없음)
	tr.SweepIdleAt(toolhub.AttnWorkingStale + 1)
	if got := firedIdle(fb, "agent"); got != 1 {
		t.Fatalf("굳은 working 이 알람을 막았다: %d", got)
	}
}

// FR-ATF-7: Forget 은 잠금까지 통째로 버린다 — 상태를 버리는 자리는 하나다.
func TestAttnTracker_Forget_DropsRearmLock(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	tr.SetActivity("agent", "done", "", "")
	tr.Attend("agent")

	tr.Forget("agent")

	tr.SetActivity("agent", "done", "", "")
	tr.FeedOutput("agent", []byte("x"))
	tr.SweepIdleAt(int64(2_000) * 1e6)
	if got := firedIdle(fb, "agent"); got != 1 {
		t.Fatalf("Forget 뒤에도 잠금이 남아 울지 않았다: %d", got)
	}
}

// V-ATF-9 (FR-ATF-13): `모두 제거` 뒤에는 되살아나지 않는다. 개정 전에는 주의
// 비트만 내려, 이미 조용해진 도구들이 다음 tick 에서 통째로 다시 울었다.
func TestAttnTracker_ClearAll_DoesNotResurrect(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	tr.SetActivity("agent", "done", "", "")
	tr.FeedOutput("agent", []byte("x"))
	tr.SweepIdleAt(int64(2_000) * 1e6)
	if got := firedIdle(fb, "agent"); got != 1 {
		t.Fatalf("첫 발화가 없다: %d", got)
	}

	if n := tr.ClearAllAttention(); n != 1 {
		t.Fatalf("일괄 해제 수 = %d", n)
	}

	tr.SweepIdleAt(int64(4_000) * 1e6)
	if tr.Attention("agent") {
		t.Fatalf("`모두 제거` 뒤 다음 sweep 에서 되살아났다")
	}
	tr.FeedOutput("agent", []byte("tui redraw"))
	tr.SweepIdleAt(int64(6_000) * 1e6)
	if tr.Attention("agent") {
		t.Fatalf("`모두 제거` 뒤 화면 갱신만으로 되살아났다")
	}
}
