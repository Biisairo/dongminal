package hub

import "testing"

// ATTENTION_FIRING_SRS §3.4.7 의 데몬 모드 검증. 직접 모드
// (`toolhub/attention_agent_osc_test.go`) 와 **같은 항목**을 같은 순서로 잰다
// (FR-ATN-25·NFR-4).

const claudeIdleOSC = "\x1b]777;notify;Claude Code;Claude is waiting for your input\x07"

// V-ATN-18
func TestAttnTracker_AgentOSC_DoesNotFire(t *testing.T) {
	tr, fb := firingTracker(0)

	tr.NoteUserPrompt("agent")
	tr.SetActivity("agent", "working", "", "")
	tr.SetActivity("agent", "done", "", "")
	tr.FeedOutput("agent", []byte(claudeIdleOSC))

	if got := firedReason(fb, "agent", "signaled"); got != 0 || tr.Attention("agent") {
		t.Fatalf("에이전트 도구의 OSC 가 알람이 되었다: %d", got)
	}
}

// V-ATN-19
func TestAttnTracker_PlainOSC_StillFires(t *testing.T) {
	tr, fb := firingTracker(0)

	tr.FeedOutput("plain", []byte(claudeIdleOSC))

	if got := firedReason(fb, "plain", "signaled"); got != 1 {
		t.Fatalf("에이전트가 아닌 도구의 OSC 가 알람이 되지 않았다: %d", got)
	}
}

// V-ATN-20
func TestAttnTracker_OSCAfterEnded_Fires(t *testing.T) {
	tr, fb := firingTracker(0)

	tr.SetActivity("agent", "working", "", "")
	tr.SetActivity("agent", "ended", "", "")
	tr.FeedOutput("agent", []byte(claudeIdleOSC))

	if got := firedReason(fb, "agent", "signaled"); got != 1 {
		t.Fatalf("세션이 끝난 도구의 OSC 가 알람이 되지 않았다: %d", got)
	}
}

// V-ATN-21
func TestAttnTracker_AgentOSC_KeepsCarry(t *testing.T) {
	tr, fb := firingTracker(0)

	half := len(claudeIdleOSC) / 2
	tr.SetActivity("agent", "working", "", "")
	tr.FeedOutput("agent", []byte(claudeIdleOSC[:half]))
	tr.SetActivity("agent", "ended", "", "")
	tr.FeedOutput("agent", []byte(claudeIdleOSC[half:]))

	if got := firedReason(fb, "agent", "signaled"); got != 1 {
		t.Fatalf("이월이 버려졌다: %d", got)
	}
}
