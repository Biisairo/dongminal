package toolhub

import (
	"sync"
	"testing"
)

// ATTENTION_FIRING_SRS 묶음 N 의 직접 모드 검증. 여기서 재는 것은 **무엇이 알람이
// 되는가** 다 — 묶음 F 가 "누가 언제 우는가" 를 잰 자리 바로 옆이다.

// V-ATN-1·2: `Stop` 훅의 done 신호는 사용자 프롬프트로 시작된 턴이 끝났을 때만
// 알람이다. 배경 이벤트로 깨어난 턴의 종료는 사용자를 부를 사건이 아니다
// (FR-ATN-4, §1.8 의 관측).
func TestTool_SignalDone_RequiresUserTurn(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear)

	// 배경 턴: 사용자 프롬프트 없이 도구를 쓰고 끝났다.
	p.SetActivity("working", "Bash", "make")
	p.SignalAttention("done")
	if len(attn) != 0 {
		t.Fatalf("배경 턴의 done 이 알람이 되었다: %v", attn)
	}
	if p.Attention() {
		t.Fatalf("배경 턴의 done 이 주의 상태를 세웠다")
	}

	// 사용자 턴: 프롬프트가 앞선다.
	p.NoteUserPrompt()
	p.SetActivity("working", "Bash", "make")
	p.SignalAttention("done")
	if len(attn) != 1 || attn[0] != "agent:done" {
		t.Fatalf("사용자 턴의 done 이 알람이 되지 않았다: %v", attn)
	}
}

// V-ATN-3: §1.8 이 관측한 그대로다 — 한 번의 프롬프트 뒤에 배경 턴이 몇 번을
// 깨어나든 알람은 한 번뿐이다 (FR-ATN-1).
func TestTool_SignalDone_BackgroundTurnsAfterUserTurnStaySilent(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear)

	p.NoteUserPrompt()
	p.SignalAttention("done")
	p.clearAttention() // 사용자가 알람을 보고 지웠다

	// 백그라운드 작업 알림으로 네 번 깨어나 각각 끝났다.
	for range 4 {
		p.SetActivity("working", "Bash", "")
		p.SignalAttention("done")
	}
	if len(attn) != 1 {
		t.Fatalf("배경 턴들이 알람을 되풀이했다: %v", attn)
	}
}

// V-ATN-5·6·7: `Notification` 훅의 waiting 신호는 진행 중일 때만 알람이다.
// 그때가 권한 요청이고, 그 밖은 입력 유휴다 (FR-ATN-6, AS-3).
func TestTool_SignalWaiting_OnlyWhileInProgress(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string

	// 일을 시작한 적 없는 도구 — 세션을 열고 가만히 있었다.
	p := newAttnPane("fresh", &mu, &attn, &clear)
	p.SetActivity("idle", "", "startup")
	p.SignalAttention("waiting")
	if len(attn) != 0 {
		t.Fatalf("시작한 적 없는 도구의 waiting 이 알람이 되었다: %v", attn)
	}

	// 도구 실행 직전의 권한 요청.
	attn, clear = nil, nil
	q := newAttnPane("busy", &mu, &attn, &clear)
	q.SetActivity("working", "Bash", "rm -rf")
	q.SignalAttention("waiting")
	if len(attn) != 1 || attn[0] != "busy:waiting" {
		t.Fatalf("권한 요청의 waiting 이 알람이 되지 않았다: %v", attn)
	}

	// 응답을 마친 뒤의 입력 유휴 알림.
	attn, clear = nil, nil
	r := newAttnPane("settled", &mu, &attn, &clear)
	r.SetActivity("working", "Bash", "")
	r.SetActivity("done", "", "")
	r.SignalAttention("waiting")
	if len(attn) != 0 {
		t.Fatalf("입력 유휴의 waiting 이 알람이 되었다: %v", attn)
	}
}

// V-ATN-11: 판정을 받는 것은 훅 배선이 쓰는 두 라벨뿐이다. OSC 신호와 그 밖의
// `dmctl notify` 라벨은 그대로 알람이다 (FR-ATN-12·13 / FR-ATF-4).
func TestTool_SignalOtherLabels_BypassTheGate(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear) // 두 표시 모두 없는 상태

	p.SignalAttention("codex")
	p.clearAttention()
	p.observeOutputAt([]byte("\x1b]9;done\x07"), 1)

	if len(attn) != 2 || attn[0] != "agent:codex" || attn[1] != "agent:signaled" {
		t.Fatalf("판정 밖의 신호가 걸렸다: %v", attn)
	}
}

// V-ATN-9: 에이전트가 종결을 보고한 뒤의 정적은 새 사건이 아니다. 그 사실은 L1 이
// 이미 알렸다 (FR-ATN-10).
func TestTool_MaybeIdle_SettledTurnDoesNotFire(t *testing.T) {
	defer SetAttnBusyProbe(func(*Tool) bool { return true })()
	defer func(orig func() int64) { attnNow = orig }(attnNow)
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("agent", &mu, &attn, &clear)
	attnNow = func() int64 { return 0 }
	p.SetActivity("working", "Bash", "make")
	p.SetActivity("done", "", "")

	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	p.maybeIdle(AttnWorkingStale+1, threshold) // 굳음 억제까지 지난 자리
	if len(attn) != 0 {
		t.Fatalf("종결 뒤의 정적이 울었다: %v", attn)
	}
}

// V-ATN-13: 세션만 열고 아직 아무 일도 시작하지 않은 도구도 마찬가지다. 알릴
// 것이 없다 (FR-ATN-10).
func TestTool_MaybeIdle_NeverStartedDoesNotFire(t *testing.T) {
	defer SetAttnBusyProbe(func(*Tool) bool { return true })()
	defer func(orig func() int64) { attnNow = orig }(attnNow)
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("agent", &mu, &attn, &clear)
	attnNow = func() int64 { return 0 }
	p.SetActivity("idle", "", "startup") // SessionStart

	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	p.maybeIdle(AttnWorkingStale+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("시작한 적 없는 도구가 울었다: %v", attn)
	}
}

// V-ATN-10: 그러나 훅이 끊긴 채 굳은 `working` 은 여전히 운다. 그것이 L2 를
// 남겨 둔 이유다 — B3 의 회귀를 만들지 않는다 (FR-ATN-11 / FR-ATF-10).
func TestTool_MaybeIdle_StaleWorkingStillFires(t *testing.T) {
	defer SetAttnBusyProbe(func(*Tool) bool { return true })()
	defer func(orig func() int64) { attnNow = orig }(attnNow)
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("agent", &mu, &attn, &clear)
	attnNow = func() int64 { return 0 }
	p.SetActivity("working", "Bash", "make") // 이 뒤로 훅이 끊겼다

	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	p.maybeIdle(AttnWorkingStale+1, threshold)
	if len(attn) != 1 || attn[0] != "agent:idle" {
		t.Fatalf("굳은 working 이 울지 않았다: %v", attn)
	}
}

// V-ATN-12: `ended` 는 두 표시를 함께 버린다 (FR-ATN-5).
func TestTool_Ended_DropsTurnMarks(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear)

	p.NoteUserPrompt()
	p.SetActivity("working", "Bash", "")
	p.SetActivity("ended", "", "")

	p.SignalAttention("done")
	p.SignalAttention("waiting")
	if len(attn) != 0 {
		t.Fatalf("세션이 끝난 도구의 신호가 알람이 되었다: %v", attn)
	}
}

// V-ATN-14·16 (개정): 대기 하나가 낳는 알람은 한 번뿐이다. `Notification` 훅의
// 되풀이도, **주목도** 그것을 되살리지 못한다 — 해소를 말하는 것은 `working`
// 하나다 (FR-ATN-15·16a, B7 · `U-24`).
func TestTool_SignalWaiting_FiresOncePerWait(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear)

	p.SetActivity("working", "Bash", "rm -rf")
	p.SignalAttention("waiting")
	if len(attn) != 1 {
		t.Fatalf("권한 요청의 waiting 이 알람이 되지 않았다: %v", attn)
	}

	// 대기가 이어지는 동안 훅이 되풀이 발화한다.
	for range 4 {
		p.SignalAttention("waiting")
	}
	if len(attn) != 1 {
		t.Fatalf("되풀이 훅이 알람을 되풀이했다: %v", attn)
	}

	// 사용자가 보기만 하고 거둔다 — 그래도 되풀이는 조용해야 한다.
	p.Attend()
	p.SignalAttention("waiting")
	if len(attn) != 1 {
		t.Fatalf("거둔 뒤의 되풀이 훅이 알람을 되살렸다: %v", attn)
	}

	// 키를 눌러도 대기 표시는 남는다 (FR-ATN-16a) — 만졌다고 대기가 끝난 것이
	// 아니기 때문이다. 같은 대기의 되풀이는 여전히 조용하다.
	p.AttendTyped()
	p.SignalAttention("waiting")
	if len(attn) != 1 {
		t.Fatalf("주목 뒤의 되풀이 훅이 알람을 되살렸다: %v", attn)
	}

	// 해소의 신호는 하나뿐이다: 에이전트가 실제로 다시 일을 시작했다.
	p.SetActivity("working", "Bash", "ls")
	p.SignalAttention("waiting")
	if len(attn) != 2 || attn[1] != "agent:waiting" {
		t.Fatalf("일이 다시 시작된 뒤의 waiting 이 알람이 되지 않았다: %v", attn)
	}
}
