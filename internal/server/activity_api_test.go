package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// FR-AAP-3 / TC-AAP-6: activity set endpoint — known / unknown / missing / bad-state.
func TestApiPaneActivitySet(t *testing.T) {
	m := NewPaneManager("", nil)
	var mu sync.Mutex
	var events []string
	p := newActivityPane("9", &mu, &events)
	m.mu.Lock()
	m.panes["9"] = p
	m.mu.Unlock()
	s := &Server{Panes: m}

	// known pane → updates + notifier fires.
	rec := httptest.NewRecorder()
	s.apiPaneActivitySet(rec, httptest.NewRequest(http.MethodPost, "/api/panes/activity/set",
		strings.NewReader(`{"paneId":"9","state":"working","tool":"Bash","detail":"npm test"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("set want 200, got %d", rec.Code)
	}
	got := p.Activity()
	if got == nil || got.State != "working" || got.Tool != "Bash" || got.Detail != "npm test" {
		t.Fatalf("activity not set: %+v", got)
	}
	if len(events) != 1 || events[0] != "9:working:Bash:npm test" {
		t.Fatalf("notifier should fire once, got %v", events)
	}

	// unknown pane → 200 no-op.
	rec = httptest.NewRecorder()
	s.apiPaneActivitySet(rec, httptest.NewRequest(http.MethodPost, "/api/panes/activity/set",
		strings.NewReader(`{"paneId":"999","state":"done"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("unknown pane want 200, got %d", rec.Code)
	}

	// missing paneId → 400.
	rec = httptest.NewRecorder()
	s.apiPaneActivitySet(rec, httptest.NewRequest(http.MethodPost, "/api/panes/activity/set",
		strings.NewReader(`{"state":"done"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing paneId want 400, got %d", rec.Code)
	}

	// invalid state → 400.
	rec = httptest.NewRecorder()
	s.apiPaneActivitySet(rec, httptest.NewRequest(http.MethodPost, "/api/panes/activity/set",
		strings.NewReader(`{"paneId":"9","state":"bogus"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid state want 400, got %d", rec.Code)
	}
}

// NFR-AAP-3 / TC-AAP-5: sanitizeActivityField strips control chars and bounds length.
func TestSanitizeActivityField(t *testing.T) {
	in := "a" + string(rune(0x07)) + "b" + string(rune(0x7f)) + "c"
	if got := sanitizeActivityField(in, activityDetailMax); got != "abc" {
		t.Fatalf("control chars must be stripped, got %q", got)
	}
	long := strings.Repeat("x", activityDetailMax+88)
	if got := sanitizeActivityField(long, activityDetailMax); len(got) != activityDetailMax {
		t.Fatalf("length must be bounded to %d, got %d", activityDetailMax, len(got))
	}
}

// FR-AAP-4 / TC-AAP-7: activity snapshot endpoint returns reported panes.
func TestApiPanesActivity_Endpoint(t *testing.T) {
	defer func(o func(*Pane) bool) { attnBusyProbe = o }(attnBusyProbe)
	attnBusyProbe = func(*Pane) bool { return true } // agent alive
	m := NewPaneManager("", nil)
	p1 := &Pane{ID: "1"}
	p1.setActivity("working", "Edit", "app.js")
	m.mu.Lock()
	m.panes["1"] = p1
	m.mu.Unlock()
	s := &Server{Panes: m}

	rec := httptest.NewRecorder()
	s.apiPanesActivity(rec, httptest.NewRequest(http.MethodGet, "/api/panes/activity", nil))
	var got struct {
		Activities []struct {
			PaneID string `json:"paneId"`
			State  string `json:"state"`
			Tool   string `json:"tool"`
			Detail string `json:"detail"`
		} `json:"activities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Activities) != 1 || got.Activities[0].PaneID != "1" ||
		got.Activities[0].State != "working" || got.Activities[0].Tool != "Edit" {
		t.Fatalf("snapshot endpoint unexpected: %+v", got.Activities)
	}
}

// FR-AAP-5: pane_activity SSE payload shape (server-published; lowerCamelCase).
func TestPaneActivityPayload(t *testing.T) {
	s := string(paneActivityPayload("3", "working", "Bash", "ls"))
	if !strings.Contains(s, `"action":"pane_activity"`) ||
		!strings.Contains(s, `"paneId":"3"`) ||
		!strings.Contains(s, `"state":"working"`) ||
		!strings.Contains(s, `"tool":"Bash"`) ||
		!strings.Contains(s, `"detail":"ls"`) {
		t.Fatalf("unexpected payload: %s", s)
	}
}
