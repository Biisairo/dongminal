package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"dongminal/internal/webserver/hub"
)

// attnServer 는 ids 의 도구를 가진, 방송을 cmds 로 받는 추적기 서버다. 관측은 추적기에
// 있다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-12).
func attnServer(t *testing.T, ids ...string) (*Server, *hub.AttnTracker, *fakeCommandBroker) {
	t.Helper()
	s, _, _ := trackedServer(t, ids...)
	cmds := &fakeCommandBroker{}
	s.AttnTracker = hub.NewAttnTracker(cmds, 0)
	return s, s.AttnTracker, cmds
}

func attentionIDsOf(t *testing.T, s *Server) []string {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiToolsAttention(rec, apiTestRequest(http.MethodGet, "/api/tools/attention", nil))
	var got struct {
		ToolIds []string `json:"toolIds"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got.ToolIds
}

// TC-PAN-13: 주의가 선 도구들을 종단이 돌려준다.
func TestAttentionIDs_Endpoint(t *testing.T) {
	s, tr, _ := attnServer(t, "2", "5", "7")
	tr.SignalAttention("2", "bell")
	tr.SignalAttention("5", "bell")
	// 순서는 계약이 아니다 — 추적기는 맵 순서로 답한다.
	got := attentionIDsOf(t, s)
	sort.Strings(got)
	if len(got) != 2 || got[0] != "2" || got[1] != "5" {
		t.Fatalf("endpoint toolIds want {2 5}, got %v", got)
	}
}

// apiToolAttentionClear clears via the focus path and tolerates unknown tools.
func TestApiToolAttentionClear(t *testing.T) {
	s, tr, cmds := attnServer(t, "4")
	tr.SignalAttention("4", "bell")

	// unknown tool → 200 no-op.
	rec := httptest.NewRecorder()
	s.apiToolAttentionClear(rec, apiTestRequest(http.MethodPost, "/api/tools/attention/clear",
		strings.NewReader(`{"toolId":"999"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("unknown tool want 200, got %d", rec.Code)
	}

	// known attention tool → cleared + notifier fired.
	rec = httptest.NewRecorder()
	s.apiToolAttentionClear(rec, apiTestRequest(http.MethodPost, "/api/tools/attention/clear",
		strings.NewReader(`{"toolId":"4"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("known tool want 200, got %d", rec.Code)
	}
	if tr.Attention("4") {
		t.Fatalf("tool 4 attention should be cleared")
	}
	ev := publishedActions(cmds, "tool_attention_clear")
	if len(ev) != 1 {
		t.Fatalf("clear notifier should fire once, got %d", len(ev))
	}
	if a, _ := ev[0]["args"].(map[string]any); a["toolId"] != "4" {
		t.Fatalf("tool_attention_clear args=%v", ev[0]["args"])
	}

	// missing toolId → 400.
	rec = httptest.NewRecorder()
	s.apiToolAttentionClear(rec, apiTestRequest(http.MethodPost, "/api/tools/attention/clear",
		strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing toolId want 400, got %d", rec.Code)
	}
}

// FR-PAN-18: dmctl notify → set endpoint flags a tool (hook bridge).
func TestApiToolAttentionSet(t *testing.T) {
	s, tr, cmds := attnServer(t, "9")

	// FR-ATN-4·6 의 전제: 턴이 진행 중이다. 이 테스트가 재는 것은 **종단의 배선과
	// 재알림**이지 판정이 아니다 (판정은 묶음 N 의 단위 테스트가 잰다).
	tr.SetActivity("9", "working", "Bash", "")

	rec := httptest.NewRecorder()
	s.apiToolAttentionSet(rec, apiTestRequest(http.MethodPost, "/api/tools/attention/set",
		strings.NewReader(`{"toolId":"9","reason":"done"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("set want 200, got %d", rec.Code)
	}
	if !tr.Attention("9") {
		t.Fatalf("tool 9 should be in attention")
	}
	if got := publishedActions(cmds, "tool_attention"); len(got) != 1 || got[0]["args"].(map[string]any)["reason"] != "done" {
		t.Fatalf("notifier should fire once with reason, got %v", got)
	}

	// Re-notify: a second explicit signal must fire AGAIN even though the tool
	// is already in attention (each agent completion re-alerts) — not edge-gated.
	rec = httptest.NewRecorder()
	s.apiToolAttentionSet(rec, apiTestRequest(http.MethodPost, "/api/tools/attention/set",
		strings.NewReader(`{"toolId":"9","reason":"waiting"}`)))
	if got := publishedActions(cmds, "tool_attention"); len(got) != 2 || got[1]["args"].(map[string]any)["reason"] != "waiting" {
		t.Fatalf("second signal must re-fire while already in attention, got %v", got)
	}

	// missing toolId → 400.
	rec = httptest.NewRecorder()
	s.apiToolAttentionSet(rec, apiTestRequest(http.MethodPost, "/api/tools/attention/set",
		strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing toolId want 400, got %d", rec.Code)
	}
}

// FR-PAN-17: bulk dismiss clears every attention tool and disarms them.
func TestClearAllAttention_AndEndpoint(t *testing.T) {
	s, tr, cmds := attnServer(t, "1", "2", "3")
	tr.SignalAttention("1", "bell")
	tr.SignalAttention("2", "bell")

	rec := httptest.NewRecorder()
	s.apiToolAttentionClearAll(rec, apiTestRequest(http.MethodPost, "/api/tools/attention/clear-all", nil))
	var got struct {
		Cleared int `json:"cleared"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Cleared != 2 {
		t.Fatalf("cleared want 2, got %d", got.Cleared)
	}
	if ids := tr.AttentionIDs(); len(ids) != 0 {
		t.Fatalf("no tool should remain in attention, got %v", ids)
	}
	if n := len(publishedActions(cmds, "tool_attention_clear")); n != 2 {
		t.Fatalf("clear notifier should fire for the 2 attention tools, got %d", n)
	}
}

// ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS V-ATL-6: 도구를 지우면 그 알람도 복원 목록
// 에서 사라진다 — Forget 이 한다. 이 결함이 살아 있는 동안, 닫은 탭의 알람은
// `모두 제거` 전까지 배지에 남았다.
func TestApiToolDelete_ClearsAttention(t *testing.T) {
	s, tr, _ := attnServer(t, "del", "keep")
	tr.SignalAttention("del", "bell")
	tr.SignalAttention("keep", "bell")

	rec := httptest.NewRecorder()
	s.apiToolDelete(rec, apiTestRequest(http.MethodDelete, "/api/tools/del", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete code=%d", rec.Code)
	}
	if got := attentionIDsOf(t, s); len(got) != 1 || got[0] != "keep" {
		t.Fatalf("삭제한 도구의 알람이 남았다: %v", got)
	}
}

// V-ATF-8 (ATTENTION_FIRING_SRS): 해제 종단의 `typed` 가 서버 상태에 도달한다.
// 보기만 한 해제는 재무장을 잠그고, 키를 누른 해제는 잠금을 푼다 — 그 차이는
// 본문의 한 필드로만 전해지므로 종단에서 재는 것이 맞다. 재는 방법은 **동작**
// 이다: 잠금이 풀린 도구만 다음 정적에서 다시 운다.
func TestApiToolAttentionClear_TypedUnlocksRearm(t *testing.T) {
	const idleMS = 1000
	for _, tc := range []struct {
		name   string
		body   string
		refire bool
	}{
		{"보기만 함", `{"toolId":"a"}`, false},
		{"키를 누름", `{"toolId":"a","typed":true}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tr := hub.NewAttnTracker(hub.NewCommandHub(), idleMS)
			tr.SetBusyProbe(busyAll(true))
			// 진행 중인 턴 — L2 가 울 수 있는 전제다 (FR-ATN-10). 이 테스트가
			// 재는 것은 `typed` 가 재무장 잠금을 푸는가 이다.
			tr.SetActivity("a", "working", "Bash", "")
			s := &Server{Deps: Deps{Tools: newFakePaneHub(), AttnTracker: tr}}

			rec := httptest.NewRecorder()
			s.apiToolAttentionClear(rec, apiTestRequest(http.MethodPost,
				"/api/tools/attention/clear", strings.NewReader(tc.body)))
			if rec.Code != http.StatusOK {
				t.Fatalf("clear → %d", rec.Code)
			}

			tr.FeedOutput("a", []byte("output"))
			tr.SweepIdleAt(time.Now().Add(time.Hour).UnixNano())

			if got := tr.Attention("a"); got != tc.refire {
				t.Fatalf("재발화 = %v, want %v", got, tc.refire)
			}
		})
	}
}
