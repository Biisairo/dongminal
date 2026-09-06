package toolhub

import (
	"sync"
	"testing"
)

// newAttnPane builds a bare Tool wired with capturing notifiers, without
// spawning a PTY/shell (attention state is independent of the shell).
func newAttnPane(id string, mu *sync.Mutex, attn *[]string, clear *[]string) *Tool {
	return NewDetachedTool(id, &ToolHooks{
		OnAttention: func(pid, reason string) {
			mu.Lock()
			*attn = append(*attn, pid+":"+reason)
			mu.Unlock()
		},
		OnAttentionClear: func(pid string) {
			mu.Lock()
			*clear = append(*clear, pid)
			mu.Unlock()
		},
	})
}

// startStaleWork 는 L2 가 발화할 수 있는 최소 전제를 세운다. 관문이 둘이기
// 때문이다: 턴이 **진행 중**이어야 하고 (FR-ATN-10), 그 `working` 보고는 이미
// **굳어** 억제력을 잃었어야 한다 (FR-ATF-10).
//
// 보고 시각을 원점보다 `AttnWorkingStale` 앞에 둔다. 그래야 작은 now 로 재는
// 기존 테스트들의 시간 축을 그대로 둘 수 있다.
//
// 개정 전 이 전제는 `SetActivity("done", "", "")` 한 줄이었다 — 그때는 활동을
// 보고했다는 사실만으로 L2 가 울었기 때문이다 (V-ATF-2). 묶음 N 이 그 자리를
// 뒤집었다: 종결을 보고한 뒤의 정적은 L1 이 이미 알린 사실이다.
func startStaleWork(p *Tool) {
	orig := attnNow
	attnNow = func() int64 { return -AttnWorkingStale }
	p.SetActivity("working", "Bash", "make")
	attnNow = orig
}

// TC-PAN-8/9/10: idle sweeper edge semantics.
// TC-PAN-8/9/10: idle sweeper edge semantics.
func TestTool_MaybeIdle_FiresOncePerQuietEdge(t *testing.T) {
	defer func(orig func(*Tool) bool) { attnBusyProbe = orig }(attnBusyProbe)
	attnBusyProbe = func(*Tool) bool { return true } // tool has a running agent
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("1", &mu, &attn, &clear)
	// ATTENTION_FIRING_SRS FR-ATF-1: L2 는 에이전트 도구에만 운다. 이 테스트가
	// 재는 것은 **에지 의미론**이므로, 전제인 에이전트 표시를 세워 둔다.
	startStaleWork(p)
	const threshold = int64(1000)

	// armed tool, still within threshold → no fire.
	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	p.maybeIdle(threshold-1, threshold)
	if len(attn) != 0 {
		t.Fatalf("should not fire within threshold: %v", attn)
	}
	// past threshold → fire exactly once.
	p.maybeIdle(threshold, threshold)
	p.maybeIdle(threshold+5, threshold) // disarmed → no second fire
	if len(attn) != 1 || attn[0] != "1:idle" {
		t.Fatalf("want one idle fire, got %v", attn)
	}
	// User attends (clear), agent works again (re-arm), goes quiet again →
	// fires again (TC-PAN-9). Re-fire requires a clear first; staying in the
	// attention state must not re-spam (NFR-PAN-3).
	p.clearAttention()
	p.observeOutputAt([]byte("x"), threshold+5)
	p.maybeIdle(threshold+5+threshold, threshold)
	if len(attn) != 2 {
		t.Fatalf("want re-fire after attend+re-arm, got %v", attn)
	}
}

func TestTool_MaybeIdle_NoActivityNeverFires(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("1", &mu, &attn, &clear)
	// never armed (no output) → never fires.
	p.maybeIdle(1_000_000, 1000)
	if len(attn) != 0 {
		t.Fatalf("unarmed tool must not fire idle: %v", attn)
	}
}

// Idle must NOT fire for a bare shell (no foreground process) — this is the
// daemon-restart flood guard.
// Idle must NOT fire for a bare shell (no foreground process) — this is the
// daemon-restart flood guard.
func TestTool_MaybeIdle_GatedByBusy(t *testing.T) {
	defer func(orig func(*Tool) bool) { attnBusyProbe = orig }(attnBusyProbe)
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	// Not busy → armed+quiet but no fire.
	attnBusyProbe = func(*Tool) bool { return false }
	pIdle := newAttnPane("1", &mu, &attn, &clear)
	startStaleWork(pIdle) // FR-ATF-1·ATN-10 의 전제 (아래 pBusy 도 같다)
	pIdle.LastOutputAt.Store(0)
	pIdle.attnArmed.Store(true)
	pIdle.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("idle must not fire for non-busy tool, got %v", attn)
	}

	// Busy → fires.
	attnBusyProbe = func(*Tool) bool { return true }
	pBusy := newAttnPane("2", &mu, &attn, &clear)
	startStaleWork(pBusy)
	pBusy.LastOutputAt.Store(0)
	pBusy.attnArmed.Store(true)
	pBusy.maybeIdle(threshold+1, threshold)
	if len(attn) != 1 || attn[0] != "2:idle" {
		t.Fatalf("idle must fire for busy tool, got %v", attn)
	}
}

func TestTool_MaybeIdle_DisabledThreshold(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("1", &mu, &attn, &clear)
	p.attnArmed.Store(true)
	p.maybeIdle(1_000_000, 0) // threshold 0 disables L2
	if len(attn) != 0 {
		t.Fatalf("threshold<=0 must disable idle: %v", attn)
	}
}

// 일하는 중인 에이전트는 울리지 않는다 — 출력을 멈춘 채 생각하는 것은 입력을
// 기다리는 것이 아니다. 그 억제가 풀리는 자리와 풀리지 않는 자리를 함께 잰다.
//
// **개정 (묶음 N):** 마지막 단계가 뒤집혔다. 개정 전에는 `done` 을 보고하면
// "working 이 아니므로" 울었다. 이제는 울지 않는다 — 에이전트가 스스로 끝났다고
// 말한 사실은 L1 이 이미 알렸고, 그 뒤의 정적은 새 사건이 아니다 (FR-ATN-10).
// 진행 중에 던진 `waiting`(권한 요청·질문)은 그대로 운다.
func TestTool_MaybeIdle_SuppressedWhileWorking(t *testing.T) {
	defer func(orig func(*Tool) bool) { attnBusyProbe = orig }(attnBusyProbe)
	attnBusyProbe = func(*Tool) bool { return true }
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("1", &mu, &attn, &clear)
	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	// 일하는 중 → 울지 않는다.
	p.SetActivity("working", "bash", "running")
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("idle must not fire while working, got %v", attn)
	}

	// 물음을 던졌다(waiting) → 턴은 아직 진행 중이므로 운다.
	p.SetActivity("waiting", "", "")
	p.attnArmed.Store(true)
	p.LastOutputAt.Store(0)
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 1 || attn[0] != "1:idle" {
		t.Fatalf("idle must fire while waiting, got %v", attn)
	}

	// 끝났다고 보고했다 → 더는 울지 않는다 (FR-ATN-10).
	// `ended` 로 말하지 않는다 — 그것은 세션 종료이고 에이전트 표시를 내려
	// L2 자체를 끈다 (FR-ATF-2). 여기서 재는 것은 **턴의 종결**이다.
	p.clearAttention()
	p.SetActivity("done", "", "")
	p.attnArmed.Store(true)
	p.LastOutputAt.Store(0)
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 1 {
		t.Fatalf("종결 뒤의 정적이 울었다: %v", attn)
	}
}

// TC-PAN-11: repeated signal while already in attention fires the edge once.
// TC-PAN-11: repeated signal while already in attention fires the edge once.
func TestTool_SetAttention_EdgeOnly(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("2", &mu, &attn, &clear)
	if !p.setAttention("signaled") {
		t.Fatalf("first setAttention should transition")
	}
	if p.setAttention("signaled") {
		t.Fatalf("second setAttention must not re-transition")
	}
	if len(attn) != 1 {
		t.Fatalf("notifier must fire once on edge, got %v", attn)
	}
}

// TC-PAN-12: attend (focus/clear path) clears attention once + disarms idle;
// attending a non-attention tool is a no-op.
// TC-PAN-12: attend (focus/clear path) clears attention once + disarms idle;
// attending a non-attention tool is a no-op.
func TestTool_Attend_ClearsOnce(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("3", &mu, &attn, &clear)
	p.setAttention("idle")
	p.attnArmed.Store(true)
	p.Attend()
	if len(clear) != 1 || clear[0] != "3" {
		t.Fatalf("attend should clear once, got %v", clear)
	}
	if p.Attention() {
		t.Fatalf("attention should be cleared")
	}
	if p.attnArmed.Load() {
		t.Fatalf("attend should disarm idle")
	}
	// second attend with no attention → no extra clear.
	p.Attend()
	if len(clear) != 1 {
		t.Fatalf("attending a non-attention tool must be no-op, got %v", clear)
	}
}

// TC-PAN-13: AttentionIDs + endpoint return current attention set.
