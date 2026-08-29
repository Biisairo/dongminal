package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// TC-PAN-13: AttentionIDs + endpoint return current attention set.
func TestToolManager_AttentionIDs_AndEndpoint(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	p2 := toolhub.NewAttendingTool("2", nil, false)
	p5 := toolhub.NewAttendingTool("5", nil, false)
	p7 := &toolhub.Tool{ID: "7"} // not in attention
	m.Adopt(p2)
	m.Adopt(p5)
	m.Adopt(p7)

	ids := m.AttentionIDs()
	if len(ids) != 2 || ids[0] != "2" || ids[1] != "5" {
		t.Fatalf("AttentionIDs want [2 5], got %v", ids)
	}

	s := &Server{Tools: m}
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
// apiToolAttentionClear clears via the focus path and tolerates unknown tools.
func TestApiToolAttentionClear(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	var mu sync.Mutex
	var attn, clear []string
	p := newAttendingPane("4", &mu, &attn, &clear, false)
	m.Adopt(p)

	s := &Server{Tools: m}

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
// FR-PAN-18: dmctl notify → set endpoint flags a tool (hook bridge).
func TestApiToolAttentionSet(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("9", &mu, &attn, &clear)
	m.Adopt(p)
	s := &Server{Tools: m}

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
// FR-PAN-17: bulk dismiss clears every attention tool and disarms them.
func TestClearAllAttention_AndEndpoint(t *testing.T) {
	m := toolhub.NewToolManager("", nil)
	var mu sync.Mutex
	var attn, clear []string
	for _, id := range []string{"1", "2", "3"} {
		var p *toolhub.Tool
		if id == "3" {
			p = newAttnPane(id, &mu, &attn, &clear)
		} else {
			p = newAttendingPane(id, &mu, &attn, &clear, true)
		}
		m.Adopt(p)
	}

	s := &Server{Tools: m}
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

// ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS V-ATL-6: 도구를 지우면 그 알람도 복원 목록
// 에서 사라진다. 직접 모드는 Delete → kill() 이, 데몬 모드는 Forget 이 한다.
// 이 결함이 살아 있는 동안, 닫은 탭의 알람은 `모두 제거` 전까지 배지에 남았다.
func TestApiToolDelete_ClearsAttention(t *testing.T) {
	// Delete 가 SaveAll 을 부르므로 dataDir 를 준다 — 빈 값이면 패키지 디렉터리에
	// tools.json 을 떨군다.
	m := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.WaitSaves)
	m.Adopt(toolhub.NewAttendingTool("del", nil, false))
	m.Adopt(toolhub.NewAttendingTool("keep", nil, false))

	s := &Server{Tools: m}
	rec := httptest.NewRecorder()
	s.apiToolDelete(rec, httptest.NewRequest(http.MethodDelete, "/api/tools/del", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete code=%d", rec.Code)
	}

	rec = httptest.NewRecorder()
	s.apiToolsAttention(rec, httptest.NewRequest(http.MethodGet, "/api/tools/attention", nil))
	var got struct {
		ToolIds []string `json:"toolIds"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.ToolIds) != 1 || got.ToolIds[0] != "keep" {
		t.Fatalf("삭제한 도구의 알람이 남았다: %v", got.ToolIds)
	}
}
