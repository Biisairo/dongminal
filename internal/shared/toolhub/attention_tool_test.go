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
	p.SetActivity("done", "", "")
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
	pIdle.SetActivity("done", "", "") // FR-ATF-1 의 전제 (아래 pBusy 도 같다)
	pIdle.LastOutputAt.Store(0)
	pIdle.attnArmed.Store(true)
	pIdle.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("idle must not fire for non-busy tool, got %v", attn)
	}

	// Busy → fires.
	attnBusyProbe = func(*Tool) bool { return true }
	pBusy := newAttnPane("2", &mu, &attn, &clear)
	pBusy.SetActivity("done", "", "")
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

// Idle must NOT fire while the agent is actively working (activity state
// "working"). A thinking agent that pauses output is not waiting for input.
// Idle must NOT fire while the agent is actively working (activity state
// "working"). A thinking agent that pauses output is not waiting for input.
func TestTool_MaybeIdle_SuppressedWhileWorking(t *testing.T) {
	defer func(orig func(*Tool) bool) { attnBusyProbe = orig }(attnBusyProbe)
	attnBusyProbe = func(*Tool) bool { return true }
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("1", &mu, &attn, &clear)
	p.LastOutputAt.Store(0)
	p.attnArmed.Store(true)
	// Agent is working → idle must not fire.
	p.SetActivity("working", "bash", "running")
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("idle must not fire while working, got %v", attn)
	}

	// Agent asks a question (waiting) → idle must fire.
	p.SetActivity("waiting", "", "")
	p.attnArmed.Store(true)
	p.LastOutputAt.Store(0)
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 1 || attn[0] != "1:idle" {
		t.Fatalf("idle must fire while waiting, got %v", attn)
	}

	// Agent stops working → idle fires (after clearing prior attention).
	// `ended` 로 말하지 않는다 — 그것은 세션 종료이고 에이전트 표시를 내려
	// L2 자체를 끈다 (FR-ATF-2). 여기서 재는 것은 "working 이 아니면 운다" 다.
	p.clearAttention()
	p.SetActivity("done", "", "")
	p.attnArmed.Store(true)
	p.LastOutputAt.Store(0)
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 2 || attn[1] != "1:idle" {
		t.Fatalf("idle must fire after work ends, got %v", attn)
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
