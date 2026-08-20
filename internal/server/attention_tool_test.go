package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// newAttnPane builds a bare Tool wired with capturing notifiers, without
// spawning a PTY/shell (attention state is independent of the shell).
func newAttnPane(id string, mu *sync.Mutex, attn *[]string, clear *[]string) *Tool {
	p := &Tool{ID: id}
	p.onAttention = func(pid, reason string) {
		mu.Lock()
		*attn = append(*attn, pid+":"+reason)
		mu.Unlock()
	}
	p.onAttentionClear = func(pid string) {
		mu.Lock()
		*clear = append(*clear, pid)
		mu.Unlock()
	}
	return p
}

// TC-PAN-8/9/10: idle sweeper edge semantics.
func TestPane_MaybeIdle_FiresOncePerQuietEdge(t *testing.T) {
	defer func(orig func(*Tool) bool) { attnBusyProbe = orig }(attnBusyProbe)
	attnBusyProbe = func(*Tool) bool { return true } // tool has a running agent
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("1", &mu, &attn, &clear)
	const threshold = int64(1000)

	// armed tool, still within threshold → no fire.
	p.lastOutputAt.Store(0)
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

func TestPane_MaybeIdle_NoActivityNeverFires(t *testing.T) {
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
func TestPane_MaybeIdle_GatedByBusy(t *testing.T) {
	defer func(orig func(*Tool) bool) { attnBusyProbe = orig }(attnBusyProbe)
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	// Not busy → armed+quiet but no fire.
	attnBusyProbe = func(*Tool) bool { return false }
	pIdle := newAttnPane("1", &mu, &attn, &clear)
	pIdle.lastOutputAt.Store(0)
	pIdle.attnArmed.Store(true)
	pIdle.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("idle must not fire for non-busy tool, got %v", attn)
	}

	// Busy → fires.
	attnBusyProbe = func(*Tool) bool { return true }
	pBusy := newAttnPane("2", &mu, &attn, &clear)
	pBusy.lastOutputAt.Store(0)
	pBusy.attnArmed.Store(true)
	pBusy.maybeIdle(threshold+1, threshold)
	if len(attn) != 1 || attn[0] != "2:idle" {
		t.Fatalf("idle must fire for busy tool, got %v", attn)
	}
}

func TestPane_MaybeIdle_DisabledThreshold(t *testing.T) {
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
func TestPane_MaybeIdle_SuppressedWhileWorking(t *testing.T) {
	defer func(orig func(*Tool) bool) { attnBusyProbe = orig }(attnBusyProbe)
	attnBusyProbe = func(*Tool) bool { return true }
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	p := newAttnPane("1", &mu, &attn, &clear)
	p.lastOutputAt.Store(0)
	p.attnArmed.Store(true)
	// Agent is working → idle must not fire.
	p.setActivity("working", "bash", "running")
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("idle must not fire while working, got %v", attn)
	}

	// Agent asks a question (waiting) → idle must fire.
	p.setActivity("waiting", "", "")
	p.attnArmed.Store(true)
	p.lastOutputAt.Store(0)
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 1 || attn[0] != "1:idle" {
		t.Fatalf("idle must fire while waiting, got %v", attn)
	}

	// Agent stops working → idle fires (after clearing prior attention).
	p.clearAttention()
	p.setActivity("ended", "", "")
	p.attnArmed.Store(true)
	p.lastOutputAt.Store(0)
	p.maybeIdle(threshold+1, threshold)
	if len(attn) != 2 || attn[1] != "1:idle" {
		t.Fatalf("idle must fire after work ends, got %v", attn)
	}
}

// TC-PAN-11: repeated signal while already in attention fires the edge once.
func TestPane_SetAttention_EdgeOnly(t *testing.T) {
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
func TestPane_Attend_ClearsOnce(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("3", &mu, &attn, &clear)
	p.setAttention("idle")
	p.attnArmed.Store(true)
	p.attend()
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
	p.attend()
	if len(clear) != 1 {
		t.Fatalf("attending a non-attention tool must be no-op, got %v", clear)
	}
}

// TC-PAN-13: AttentionIDs + endpoint return current attention set.
func TestPaneManager_AttentionIDs_AndEndpoint(t *testing.T) {
	m := NewToolManager("", nil)
	p2 := &Tool{ID: "2"}
	p2.attention.Store(true)
	p5 := &Tool{ID: "5"}
	p5.attention.Store(true)
	p7 := &Tool{ID: "7"} // not in attention
	m.mu.Lock()
	m.tools["2"] = p2
	m.tools["5"] = p5
	m.tools["7"] = p7
	m.mu.Unlock()

	ids := m.AttentionIDs()
	if len(ids) != 2 || ids[0] != "2" || ids[1] != "5" {
		t.Fatalf("AttentionIDs want [2 5], got %v", ids)
	}

	s := &Server{Panes: m}
	rec := httptest.NewRecorder()
	s.apiToolsAttention(rec, httptest.NewRequest(http.MethodGet, "/api/tools/attention", nil))
	var got struct {
		ToolIds []string `json:"toolIds"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.ToolIds) != 2 || got.ToolIds[0] != "2" || got.ToolIds[1] != "5" {
		t.Fatalf("endpoint toolIds want [2 5], got %v", got.ToolIds)
	}
}

// apiToolAttentionClear clears via the focus path and tolerates unknown tools.
func TestApiPaneAttentionClear(t *testing.T) {
	m := NewToolManager("", nil)
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("4", &mu, &attn, &clear)
	p.attention.Store(true)
	m.mu.Lock()
	m.tools["4"] = p
	m.mu.Unlock()

	s := &Server{Panes: m}

	// unknown tool → 200 no-op.
	rec := httptest.NewRecorder()
	s.apiToolAttentionClear(rec, httptest.NewRequest(http.MethodPost, "/api/tools/attention/clear",
		strings.NewReader(`{"toolId":"999"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("unknown tool want 200, got %d", rec.Code)
	}

	// known attention tool → cleared + notifier fired.
	rec = httptest.NewRecorder()
	s.apiToolAttentionClear(rec, httptest.NewRequest(http.MethodPost, "/api/tools/attention/clear",
		strings.NewReader(`{"toolId":"4"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("known tool want 200, got %d", rec.Code)
	}
	if p.Attention() {
		t.Fatalf("tool 4 attention should be cleared")
	}
	if len(clear) != 1 || clear[0] != "4" {
		t.Fatalf("clear notifier should fire once, got %v", clear)
	}

	// missing toolId → 400.
	rec = httptest.NewRecorder()
	s.apiToolAttentionClear(rec, httptest.NewRequest(http.MethodPost, "/api/tools/attention/clear",
		strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing toolId want 400, got %d", rec.Code)
	}
}

// FR-PAN-18: dmctl notify → set endpoint flags a tool (hook bridge).
func TestApiPaneAttentionSet(t *testing.T) {
	m := NewToolManager("", nil)
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("9", &mu, &attn, &clear)
	m.mu.Lock()
	m.tools["9"] = p
	m.mu.Unlock()
	s := &Server{Panes: m}

	rec := httptest.NewRecorder()
	s.apiToolAttentionSet(rec, httptest.NewRequest(http.MethodPost, "/api/tools/attention/set",
		strings.NewReader(`{"toolId":"9","reason":"done"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("set want 200, got %d", rec.Code)
	}
	if !p.Attention() {
		t.Fatalf("tool 9 should be in attention")
	}
	if len(attn) != 1 || attn[0] != "9:done" {
		t.Fatalf("notifier should fire once with reason, got %v", attn)
	}

	// Re-notify: a second explicit signal must fire AGAIN even though the tool
	// is already in attention (each agent completion re-alerts) — not edge-gated.
	rec = httptest.NewRecorder()
	s.apiToolAttentionSet(rec, httptest.NewRequest(http.MethodPost, "/api/tools/attention/set",
		strings.NewReader(`{"toolId":"9","reason":"waiting"}`)))
	if len(attn) != 2 || attn[1] != "9:waiting" {
		t.Fatalf("second signal must re-fire while already in attention, got %v", attn)
	}

	// missing toolId → 400.
	rec = httptest.NewRecorder()
	s.apiToolAttentionSet(rec, httptest.NewRequest(http.MethodPost, "/api/tools/attention/set",
		strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing toolId want 400, got %d", rec.Code)
	}
}

// FR-PAN-17: bulk dismiss clears every attention tool and disarms them.
func TestClearAllAttention_AndEndpoint(t *testing.T) {
	m := NewToolManager("", nil)
	var mu sync.Mutex
	var attn, clear []string
	for _, id := range []string{"1", "2", "3"} {
		p := newAttnPane(id, &mu, &attn, &clear)
		if id != "3" {
			p.attention.Store(true)
			p.attnArmed.Store(true)
		}
		m.mu.Lock()
		m.tools[id] = p
		m.mu.Unlock()
	}

	s := &Server{Panes: m}
	rec := httptest.NewRecorder()
	s.apiToolAttentionClearAll(rec, httptest.NewRequest(http.MethodPost, "/api/tools/attention/clear-all", nil))
	var got struct {
		Cleared int `json:"cleared"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Cleared != 2 {
		t.Fatalf("cleared want 2, got %d", got.Cleared)
	}
	if len(m.AttentionIDs()) != 0 {
		t.Fatalf("no tool should remain in attention, got %v", m.AttentionIDs())
	}
	if len(clear) != 2 {
		t.Fatalf("clear notifier should fire for the 2 attention tools, got %v", clear)
	}
}
