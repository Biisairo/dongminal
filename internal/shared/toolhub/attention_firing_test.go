package toolhub

import (
	"sync"
	"testing"
)

// ATTENTION_FIRING_SRS 묶음 F 의 직접 모드 검증. 여기서 재는 것은 **누가 언제
// 우는가** 다 — 알람의 수명(ATTENTION_LIFECYCLE) 이나 감지 규약(OSC) 이 아니다.

// V-ATF-1: 활동을 한 번도 보고하지 않은 도구는 전경 프로세스가 있고 조용해도
// 울지 않는다. vim·less·top·ssh·빌드 대기가 전부 이 자리에 있었다 (B1).
func TestTool_MaybeIdle_OnlyAgentTools(t *testing.T) {
	defer SetAttnBusyProbe(func(*Tool) bool { return true })()
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("plain", &mu, &attn, &clear)
	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("에이전트가 아닌 도구가 울었다: %v", attn)
	}
}

// V-ATF-2: 활동을 보고한 도구는 같은 조건에서 운다. 보고한 상태의 종류는 묻지
// 않는다 — 표시를 세우는 것은 보고했다는 사실이다 (FR-ATF-2).
func TestTool_MaybeIdle_AgentToolFires(t *testing.T) {
	defer SetAttnBusyProbe(func(*Tool) bool { return true })()
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	for _, state := range []string{"idle", "waiting", "done"} {
		attn, clear = nil, nil
		p := newAttnPane("agent", &mu, &attn, &clear)
		p.SetActivity(state, "", "")
		p.LastOutputAt.Store(0)
		p.attnArmed.Store(true)
		p.maybeIdle(threshold+1, threshold)
		if len(attn) != 1 || attn[0] != "agent:idle" {
			t.Fatalf("활동=%q 를 보고한 도구가 울지 않았다: %v", state, attn)
		}
	}
}

// V-ATF-3: `ended` 는 표시를 내린다. 에이전트가 끝난 뒤 같은 도구의 셸에서 연
// vim 이 알람을 물려받으면 안 된다 (FR-ATF-2).
func TestTool_MaybeIdle_EndedRevokesAgentMark(t *testing.T) {
	defer SetAttnBusyProbe(func(*Tool) bool { return true })()
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("agent", &mu, &attn, &clear)
	p.SetActivity("done", "", "")
	p.SetActivity("ended", "", "")
	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("세션이 끝난 도구가 울었다: %v", attn)
	}
}

// V-ATF-4·5: 주목 뒤에는 출력만으로 되살아나지 않는다. 사용자가 키를 눌렀을
// 때에만 다시 무장한다 (D-3).
func TestTool_Rearm_RequiresUserInput(t *testing.T) {
	defer SetAttnBusyProbe(func(*Tool) bool { return true })()
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("agent", &mu, &attn, &clear)
	p.SetActivity("done", "", "")
	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	p.maybeIdle(threshold, threshold)
	if len(attn) != 1 {
		t.Fatalf("첫 발화가 없다: %v", attn)
	}

	// 사용자가 보기만 했다 → 화면 갱신(출력)이 재무장을 만들지 못한다.
	p.Attend()
	p.observeOutputAt([]byte("tui redraw"), threshold+1)
	if p.attnArmed.Load() {
		t.Fatalf("주목 뒤 출력만으로 재무장했다")
	}
	p.maybeIdle(threshold+1+threshold, threshold)
	if len(attn) != 1 {
		t.Fatalf("주목 뒤 출력만으로 다시 울었다: %v", attn)
	}

	// 사용자가 키를 눌렀다 → 그 뒤의 출력부터 다시 무장한다.
	p.AttendTyped()
	p.observeOutputAt([]byte("agent works"), threshold+2)
	if !p.attnArmed.Load() {
		t.Fatalf("입력 뒤에도 재무장하지 않았다")
	}
	p.maybeIdle(threshold+2+threshold, threshold)
	if len(attn) != 2 {
		t.Fatalf("입력 뒤 정적에서 울지 않았다: %v", attn)
	}
}

// V-ATF-6: L1 은 잠금과 무관하다. 명시적 신호는 누가 보냈든 알람이다 (FR-ATF-9).
func TestTool_Rearm_LockDoesNotSilenceL1(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear)
	p.Attend() // 재무장 잠금

	p.observeOutputAt([]byte("\x1b]9;done\x07"), 1)
	if len(attn) != 1 || attn[0] != "agent:signaled" {
		t.Fatalf("잠금이 OSC 신호를 삼켰다: %v", attn)
	}

	p.clearAttention()
	p.SignalAttention("done")
	if len(attn) != 2 || attn[1] != "agent:done" {
		t.Fatalf("잠금이 훅 신호를 삼켰다: %v", attn)
	}
}

// V-ATF-7: `working` 억제는 그 활동이 신선할 때만 성립한다. 훅이 끊긴 채 굳은
// working 이 알람을 영구히 막던 것이 B3 이다.
func TestTool_MaybeIdle_StaleWorkingDoesNotSuppress(t *testing.T) {
	defer SetAttnBusyProbe(func(*Tool) bool { return true })()
	defer func(orig func() int64) { attnNow = orig }(attnNow)
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("agent", &mu, &attn, &clear)
	attnNow = func() int64 { return 0 }
	p.SetActivity("working", "Bash", "make")

	// 신선한 working → 억제된다.
	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("신선한 working 이 억제되지 않았다: %v", attn)
	}

	// 굳은 working → 억제하지 않는다.
	p.attnArmed.Store(true)
	p.maybeIdle(AttnWorkingStale+1, threshold)
	if len(attn) != 1 || attn[0] != "agent:idle" {
		t.Fatalf("굳은 working 이 알람을 막았다: %v", attn)
	}
}

// FR-ATF-7: 도구가 죽으면 잠금도 함께 버려진다.
func TestTool_Kill_DropsRearmLock(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear)
	p.Attend()
	if !p.attnRearmLocked.Load() {
		t.Fatalf("주목이 잠그지 않았다")
	}
	p.kill()
	if p.attnRearmLocked.Load() {
		t.Fatalf("죽은 도구가 잠금을 들고 있다")
	}
}
