package httpapi

import (
	"dongminal/internal/webserver/hub"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// FR-AAP-3 / TC-AAP-6: activity set endpoint — known / unknown / missing / bad-state.
func TestApiToolActivitySet(t *testing.T) {
	cmds := &fakeCommandBroker{}
	s, _, _ := trackedServer(t, "9")
	s.AttnTracker = hub.NewAttnTracker(cmds, 0)
	p := trackedTool{id: "9", tr: s.AttnTracker}

	// known tool → updates + notifier fires.
	rec := httptest.NewRecorder()
	s.apiToolActivitySet(rec, apiTestRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(`{"toolId":"9","state":"working","tool":"Bash","detail":"npm test"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("set want 200, got %d", rec.Code)
	}
	got := p.Activity()
	if got == nil || got.State != "working" || got.Tool != "Bash" || got.Detail != "npm test" {
		t.Fatalf("activity not set: %+v", got)
	}
	ev := publishedActions(cmds, "tool_activity")
	if len(ev) != 1 {
		t.Fatalf("notifier should fire once, got %d", len(ev))
	}
	if a, _ := ev[0]["args"].(map[string]any); a["toolId"] != "9" || a["state"] != "working" || a["tool"] != "Bash" || a["detail"] != "npm test" {
		t.Fatalf("tool_activity args=%v", ev[0]["args"])
	}

	// unknown tool → 200 no-op.
	rec = httptest.NewRecorder()
	s.apiToolActivitySet(rec, apiTestRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(`{"toolId":"999","state":"done"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("unknown tool want 200, got %d", rec.Code)
	}

	// missing toolId → 400.
	rec = httptest.NewRecorder()
	s.apiToolActivitySet(rec, apiTestRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(`{"state":"done"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing toolId want 400, got %d", rec.Code)
	}

	// invalid state → 400.
	rec = httptest.NewRecorder()
	s.apiToolActivitySet(rec, apiTestRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(`{"toolId":"9","state":"bogus"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid state want 400, got %d", rec.Code)
	}
}

// NFR-AAP-3 / TC-AAP-5: agentrec.Sanitize strips control chars and bounds length.
// FR-AAP-4 / TC-AAP-7: activity snapshot endpoint returns reported tools.
func TestApiToolsActivity_Endpoint(t *testing.T) {
	s, _, tr := trackedServer(t, "1")
	tr.SetBusyProbe(busyAll(true)) // agent alive
	tr.SetActivity("1", "working", "Edit", "app.js")

	rec := httptest.NewRecorder()
	s.apiToolsActivity(rec, apiTestRequest(http.MethodGet, "/api/tools/activity", nil))
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

// V-ATN-1 (개정, D-12): `working` 활동 보고가 턴 시작 표시에 닿고, 그 턴의 done 은 알람이다.
func TestApiToolActivitySet_WorkingReachesTheTurnMark(t *testing.T) {
	s, _, tr := trackedServer(t, "9")
	p := trackedTool{id: "9", tr: tr}

	post := func(body string) {
		rec := httptest.NewRecorder()
		s.apiToolActivitySet(rec, apiTestRequest(http.MethodPost, "/api/tools/activity/set",
			strings.NewReader(body)))
		if rec.Code != http.StatusOK {
			t.Fatalf("activity set want 200, got %d", rec.Code)
		}
	}
	post(`{"toolId":"9","state":"working","tool":"Bash"}`)
	if !tr.AgentStateOf("9").Turn.TurnRan {
		t.Fatalf("working 이 턴 시작 표시에 닿지 않았다")
	}
	p.SignalAttention("done")
	if !p.Attention() {
		t.Fatalf("그 턴의 done 이 알람이 되지 않았다")
	}
}
