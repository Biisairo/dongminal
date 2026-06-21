package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// newAttnPane builds a bare Pane wired with capturing notifiers, without
// spawning a PTY/shell (attention state is independent of the shell).
func newAttnPane(id string, mu *sync.Mutex, attn *[]string, clear *[]string) *Pane {
	p := &Pane{ID: id}
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
	defer func(orig func(*Pane) bool) { attnBusyProbe = orig }(attnBusyProbe)
	attnBusyProbe = func(*Pane) bool { return true } // pane has a running agent
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("1", &mu, &attn, &clear)
	const threshold = int64(1000)

	// armed pane, still within threshold → no fire.
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
		t.Fatalf("unarmed pane must not fire idle: %v", attn)
	}
}

// Idle must NOT fire for a bare shell (no foreground process) — this is the
// daemon-restart flood guard.
func TestPane_MaybeIdle_GatedByBusy(t *testing.T) {
	defer func(orig func(*Pane) bool) { attnBusyProbe = orig }(attnBusyProbe)
	var mu sync.Mutex
	var attn, clear []string
	const threshold = int64(1000)

	// Not busy → armed+quiet but no fire.
	attnBusyProbe = func(*Pane) bool { return false }
	pIdle := newAttnPane("1", &mu, &attn, &clear)
	pIdle.lastOutputAt.Store(0)
	pIdle.attnArmed.Store(true)
	pIdle.maybeIdle(threshold+1, threshold)
	if len(attn) != 0 {
		t.Fatalf("idle must not fire for non-busy pane, got %v", attn)
	}

	// Busy → fires.
	attnBusyProbe = func(*Pane) bool { return true }
	pBusy := newAttnPane("2", &mu, &attn, &clear)
	pBusy.lastOutputAt.Store(0)
	pBusy.attnArmed.Store(true)
	pBusy.maybeIdle(threshold+1, threshold)
	if len(attn) != 1 || attn[0] != "2:idle" {
		t.Fatalf("idle must fire for busy pane, got %v", attn)
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
// attending a non-attention pane is a no-op.
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
		t.Fatalf("attending a non-attention pane must be no-op, got %v", clear)
	}
}

// TC-PAN-13: AttentionIDs + endpoint return current attention set.
func TestPaneManager_AttentionIDs_AndEndpoint(t *testing.T) {
	m := NewPaneManager("", nil)
	p2 := &Pane{ID: "2"}
	p2.attention.Store(true)
	p5 := &Pane{ID: "5"}
	p5.attention.Store(true)
	p7 := &Pane{ID: "7"} // not in attention
	m.mu.Lock()
	m.panes["2"] = p2
	m.panes["5"] = p5
	m.panes["7"] = p7
	m.mu.Unlock()

	ids := m.AttentionIDs()
	if len(ids) != 2 || ids[0] != "2" || ids[1] != "5" {
		t.Fatalf("AttentionIDs want [2 5], got %v", ids)
	}

	s := &Server{Panes: m}
	rec := httptest.NewRecorder()
	s.apiPanesAttention(rec, httptest.NewRequest(http.MethodGet, "/api/panes/attention", nil))
	var got struct {
		PaneIds []string `json:"paneIds"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.PaneIds) != 2 || got.PaneIds[0] != "2" || got.PaneIds[1] != "5" {
		t.Fatalf("endpoint paneIds want [2 5], got %v", got.PaneIds)
	}
}

// apiPaneAttentionClear clears via the focus path and tolerates unknown panes.
func TestApiPaneAttentionClear(t *testing.T) {
	m := NewPaneManager("", nil)
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("4", &mu, &attn, &clear)
	p.attention.Store(true)
	m.mu.Lock()
	m.panes["4"] = p
	m.mu.Unlock()

	s := &Server{Panes: m}

	// unknown pane → 200 no-op.
	rec := httptest.NewRecorder()
	s.apiPaneAttentionClear(rec, httptest.NewRequest(http.MethodPost, "/api/panes/attention/clear",
		strings.NewReader(`{"paneId":"999"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("unknown pane want 200, got %d", rec.Code)
	}

	// known attention pane → cleared + notifier fired.
	rec = httptest.NewRecorder()
	s.apiPaneAttentionClear(rec, httptest.NewRequest(http.MethodPost, "/api/panes/attention/clear",
		strings.NewReader(`{"paneId":"4"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("known pane want 200, got %d", rec.Code)
	}
	if p.Attention() {
		t.Fatalf("pane 4 attention should be cleared")
	}
	if len(clear) != 1 || clear[0] != "4" {
		t.Fatalf("clear notifier should fire once, got %v", clear)
	}

	// missing paneId → 400.
	rec = httptest.NewRecorder()
	s.apiPaneAttentionClear(rec, httptest.NewRequest(http.MethodPost, "/api/panes/attention/clear",
		strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing paneId want 400, got %d", rec.Code)
	}
}

// FR-PAN-18: dmctl notify → set endpoint flags a pane (hook bridge).
func TestApiPaneAttentionSet(t *testing.T) {
	m := NewPaneManager("", nil)
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("9", &mu, &attn, &clear)
	m.mu.Lock()
	m.panes["9"] = p
	m.mu.Unlock()
	s := &Server{Panes: m}

	rec := httptest.NewRecorder()
	s.apiPaneAttentionSet(rec, httptest.NewRequest(http.MethodPost, "/api/panes/attention/set",
		strings.NewReader(`{"paneId":"9","reason":"done"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("set want 200, got %d", rec.Code)
	}
	if !p.Attention() {
		t.Fatalf("pane 9 should be in attention")
	}
	if len(attn) != 1 || attn[0] != "9:done" {
		t.Fatalf("notifier should fire once with reason, got %v", attn)
	}

	// missing paneId → 400.
	rec = httptest.NewRecorder()
	s.apiPaneAttentionSet(rec, httptest.NewRequest(http.MethodPost, "/api/panes/attention/set",
		strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing paneId want 400, got %d", rec.Code)
	}
}

// FR-PAN-17: bulk dismiss clears every attention pane and disarms them.
func TestClearAllAttention_AndEndpoint(t *testing.T) {
	m := NewPaneManager("", nil)
	var mu sync.Mutex
	var attn, clear []string
	for _, id := range []string{"1", "2", "3"} {
		p := newAttnPane(id, &mu, &attn, &clear)
		if id != "3" {
			p.attention.Store(true)
			p.attnArmed.Store(true)
		}
		m.mu.Lock()
		m.panes[id] = p
		m.mu.Unlock()
	}

	s := &Server{Panes: m}
	rec := httptest.NewRecorder()
	s.apiPaneAttentionClearAll(rec, httptest.NewRequest(http.MethodPost, "/api/panes/attention/clear-all", nil))
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
		t.Fatalf("no pane should remain in attention, got %v", m.AttentionIDs())
	}
	if len(clear) != 2 {
		t.Fatalf("clear notifier should fire for the 2 attention panes, got %v", clear)
	}
}
