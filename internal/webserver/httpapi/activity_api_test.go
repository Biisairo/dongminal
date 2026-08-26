package httpapi

import (
	"dongminal/internal/shared/toolhub"

	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// FR-AAP-3 / TC-AAP-6: activity set endpoint — known / unknown / missing / bad-state.
func TestApiToolActivitySet(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	var mu sync.Mutex
	var events []string
	p := newActivityPane("9", &mu, &events)
	m.Adopt(p)
	s := &Server{Tools: m}

	// known tool → updates + notifier fires.
	rec := httptest.NewRecorder()
	s.apiToolActivitySet(rec, httptest.NewRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(`{"toolId":"9","state":"working","tool":"Bash","detail":"npm test"}`)))
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

	// unknown tool → 200 no-op.
	rec = httptest.NewRecorder()
	s.apiToolActivitySet(rec, httptest.NewRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(`{"toolId":"999","state":"done"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("unknown tool want 200, got %d", rec.Code)
	}

	// missing toolId → 400.
	rec = httptest.NewRecorder()
	s.apiToolActivitySet(rec, httptest.NewRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(`{"state":"done"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing toolId want 400, got %d", rec.Code)
	}

	// invalid state → 400.
	rec = httptest.NewRecorder()
	s.apiToolActivitySet(rec, httptest.NewRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(`{"toolId":"9","state":"bogus"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid state want 400, got %d", rec.Code)
	}
}

// NFR-AAP-3 / TC-AAP-5: hub.SanitizeActivityField strips control chars and bounds length.
// FR-AAP-4 / TC-AAP-7: activity snapshot endpoint returns reported tools.
func TestApiToolsActivity_Endpoint(t *testing.T) {
	defer toolhub.SetAttnBusyProbe(func(*toolhub.Tool) bool { return true })() // agent alive
	m := toolhub.NewToolManager("", nil)
	p1 := &toolhub.Tool{ID: "1"}
	p1.SetActivity("working", "Edit", "app.js")
	m.Adopt(p1)
	s := &Server{Tools: m}

	rec := httptest.NewRecorder()
	s.apiToolsActivity(rec, httptest.NewRequest(http.MethodGet, "/api/tools/activity", nil))
	var got struct {
		Activities []struct {
			ToolID string `json:"toolId"`
			State  string `json:"state"`
			Tool   string `json:"tool"`
			Detail string `json:"detail"`
		} `json:"activities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Activities) != 1 || got.Activities[0].ToolID != "1" ||
		got.Activities[0].State != "working" || got.Activities[0].Tool != "Edit" {
		t.Fatalf("snapshot endpoint unexpected: %+v", got.Activities)
	}
}

// FR-AAP-5: tool_activity SSE payload shape (server-published; lowerCamelCase).
