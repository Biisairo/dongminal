package hub

import (
	"bytes"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// ATTENTION_FIRING_SRS 묶음 N 의 데몬 모드 검증. 직접 모드
// (`toolhub/attention_novel_test.go`) 와 **같은 항목**을 같은 순서로 잰다
// (FR-ATN-14·NFR-4).

// firedReason 은 그 도구에 실린 특정 이유의 알람 수를 센다.
func firedReason(fb *fakeBroker, toolID, reason string) int {
	n := 0
	for _, p := range fb.sent {
		if bytes.Contains(p, []byte(`"action":"tool_attention"`)) &&
			bytes.Contains(p, []byte(`"toolId":"`+toolID+`"`)) &&
			bytes.Contains(p, []byte(`"reason":"`+reason+`"`)) {
			n++
		}
	}
	return n
}

// V-ATN-1·2: done 은 사용자 프롬프트로 시작된 턴이 끝났을 때만 알람이다.
func TestAttnTracker_SignalDone_RequiresUserTurn(t *testing.T) {
	tr, fb := firingTracker(1000)

	tr.SetActivity("agent", "working", "Bash", "make")
	tr.SignalAttention("agent", "done")
	if got := firedReason(fb, "agent", "done"); got != 0 {
		t.Fatalf("배경 턴의 done 이 알람이 되었다: %d", got)
	}
	if tr.Attention("agent") {
		t.Fatalf("배경 턴의 done 이 주의 상태를 세웠다")
	}

	tr.NoteUserPrompt("agent")
	tr.SetActivity("agent", "working", "Bash", "make")
	tr.SignalAttention("agent", "done")
	if got := firedReason(fb, "agent", "done"); got != 1 {
		t.Fatalf("사용자 턴의 done 이 알람이 되지 않았다: %d", got)
	}
}

// V-ATN-3: 한 번의 프롬프트 뒤 배경 턴이 몇 번을 깨어나든 알람은 한 번뿐이다.
func TestAttnTracker_SignalDone_BackgroundTurnsStaySilent(t *testing.T) {
	tr, fb := firingTracker(1000)

	tr.NoteUserPrompt("agent")
	tr.SignalAttention("agent", "done")
	tr.Attend("agent")

	for range 4 {
		tr.SetActivity("agent", "working", "Bash", "")
		tr.SignalAttention("agent", "done")
	}
	if got := firedReason(fb, "agent", "done"); got != 1 {
		t.Fatalf("배경 턴들이 알람을 되풀이했다: %d", got)
	}
}

// V-ATN-5·6·7: waiting 은 진행 중일 때만 알람이다.
func TestAttnTracker_SignalWaiting_OnlyWhileInProgress(t *testing.T) {
	tr, fb := firingTracker(1000)

	tr.SetActivity("fresh", "idle", "", "startup")
	tr.SignalAttention("fresh", "waiting")
	if got := firedReason(fb, "fresh", "waiting"); got != 0 {
		t.Fatalf("시작한 적 없는 도구의 waiting 이 알람이 되었다: %d", got)
	}

	tr.SetActivity("busy", "working", "Bash", "rm -rf")
	tr.SignalAttention("busy", "waiting")
	if got := firedReason(fb, "busy", "waiting"); got != 1 {
		t.Fatalf("권한 요청의 waiting 이 알람이 되지 않았다: %d", got)
	}

	tr.SetActivity("settled", "working", "Bash", "")
	tr.SetActivity("settled", "done", "", "")
	tr.SignalAttention("settled", "waiting")
	if got := firedReason(fb, "settled", "waiting"); got != 0 {
		t.Fatalf("입력 유휴의 waiting 이 알람이 되었다: %d", got)
	}
}

// V-ATN-11: 판정을 받는 것은 두 라벨뿐이다.
func TestAttnTracker_SignalOtherLabels_BypassTheGate(t *testing.T) {
	tr, fb := firingTracker(1000)

	tr.SignalAttention("agent", "codex")
	if got := firedReason(fb, "agent", "codex"); got != 1 {
		t.Fatalf("판정 밖의 라벨이 걸렸다: %d", got)
	}
}

// V-ATN-9: 종결을 보고한 뒤의 정적은 새 사건이 아니다.
func TestAttnTracker_Idle_SettledTurnDoesNotFire(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	tr.SetActivity("agent", "working", "Bash", "make")
	tr.SetActivity("agent", "done", "", "")
	tr.FeedOutput("agent", []byte("x"))

	tr.SweepIdleAt(toolhub.AttnWorkingStale + 1)

	if got := firedIdle(fb, "agent"); got != 0 {
		t.Fatalf("종결 뒤의 정적이 울었다: %d", got)
	}
}

// V-ATN-13: 세션만 열고 일을 시작하지 않은 도구도 울지 않는다.
func TestAttnTracker_Idle_NeverStartedDoesNotFire(t *testing.T) {
	tr, fb := firingTracker(1000)
	tr.nowFn = func() int64 { return 0 }
	tr.SetActivity("agent", "idle", "", "startup")
	tr.FeedOutput("agent", []byte("x"))

	tr.SweepIdleAt(toolhub.AttnWorkingStale + 1)

	if got := firedIdle(fb, "agent"); got != 0 {
		t.Fatalf("시작한 적 없는 도구가 울었다: %d", got)
	}
}

// V-ATN-12: `ended` 는 두 표시를 함께 버린다.
func TestAttnTracker_Ended_DropsTurnMarks(t *testing.T) {
	tr, fb := firingTracker(1000)

	tr.NoteUserPrompt("agent")
	tr.SetActivity("agent", "working", "Bash", "")
	tr.SetActivity("agent", "ended", "", "")

	tr.SignalAttention("agent", "done")
	tr.SignalAttention("agent", "waiting")
	if firedReason(fb, "agent", "done")+firedReason(fb, "agent", "waiting") != 0 {
		t.Fatalf("세션이 끝난 도구의 신호가 알람이 되었다: %q", fb.sent)
	}
}

// V-ATN-14·16: 대기 하나가 낳는 알람은 한 번뿐이다. 직접 모드
// (`TestTool_SignalWaiting_FiresOncePerWait`) 와 같은 항목을 잰다 (NFR-4).
func TestAttnTracker_SignalWaiting_FiresOncePerWait(t *testing.T) {
	tr, fb := firingTracker(1000)

	tr.SetActivity("agent", "working", "Bash", "rm -rf")
	tr.SignalAttention("agent", "waiting")
	if got := firedReason(fb, "agent", "waiting"); got != 1 {
		t.Fatalf("권한 요청의 waiting 이 알람이 되지 않았다: %d", got)
	}

	for range 4 {
		tr.SignalAttention("agent", "waiting")
	}
	if got := firedReason(fb, "agent", "waiting"); got != 1 {
		t.Fatalf("되풀이 훅이 알람을 되풀이했다: %d", got)
	}

	tr.Attend("agent")
	tr.SignalAttention("agent", "waiting")
	if got := firedReason(fb, "agent", "waiting"); got != 1 {
		t.Fatalf("거둔 뒤의 되풀이 훅이 알람을 되살렸다: %d", got)
	}

	tr.AttendTyped("agent")
	tr.SignalAttention("agent", "waiting")
	if got := firedReason(fb, "agent", "waiting"); got != 2 {
		t.Fatalf("응답 뒤의 waiting 이 알람이 되지 않았다: %d", got)
	}
}
