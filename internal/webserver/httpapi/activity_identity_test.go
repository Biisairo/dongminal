package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// V-M11-17·18 (M11_SRS FR-M11-8 / M11-B7): **신원은 활동과 같은 요청에 온다.**
//
// 받는 쪽은 활동 방송을 계기로 "이 도구를 올릴 수 있는가" 를 즉시 되묻는다. 신원이
// 별도 POST 로 뒤따르면 그 물음이 언제나 한 왕복 빨라 "모른다" 를 받고, 그 뒤로는
// 다음 훅(첫 프롬프트)까지 아무도 다시 묻지 않는다 — 그것이 접수한 *"세션을 열자마자는
// '에이전트로' 가 안 보인다"* 다.
//
// `reportActivity` 의 D-1 과 같은 근거다: 한 요청 안에서는 순서가 확정된다.

func activitySet(t *testing.T, s *Server, body string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiToolActivitySet(rec, apiTestRequest(http.MethodPost, "/api/tools/activity/set",
		strings.NewReader(body)))
	return rec.Code
}

func identityServer(t *testing.T) *Server {
	t.Helper()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	var mu sync.Mutex
	var events []string
	m.Adopt(newActivityPane("9", &mu, &events))
	return &Server{Deps: Deps{Tools: m}}
}

func TestActivitySet_CarriesSessionIdentity(t *testing.T) {
	s := identityServer(t)

	if code := activitySet(t, s, `{"toolId":"9","agent":"claude","state":"idle","sessionId":"sess-1"}`); code != http.StatusOK {
		t.Fatalf("set want 200, got %d", code)
	}
	info := s.AgentSession("9")
	if info == nil {
		t.Fatal("활동 보고가 신원을 나르지 않았다 — 올리기가 첫 프롬프트까지 선다 (M11-B7)")
	}
	if info.SessionID != "sess-1" || info.Agent != "claude" {
		t.Fatalf("신원이 어긋난다: %+v", info)
	}
}

func TestActivitySet_WithoutSessionIsSilent(t *testing.T) {
	s := identityServer(t)

	// 신원 없는 보고는 아무것도 세우지 않는다 — 모르는 것을 없는 것으로 만들지
	// 않는다 (`noteAgentSession` 의 규약 · FR-CBG-5).
	if code := activitySet(t, s, `{"toolId":"9","agent":"claude","state":"working"}`); code != http.StatusOK {
		t.Fatalf("set want 200, got %d", code)
	}
	if info := s.AgentSession("9"); info != nil {
		t.Fatalf("신원 없는 보고가 빈 세션을 세웠다: %+v", info)
	}
}

func TestActivitySet_DoesNotEraseKnownIdentity(t *testing.T) {
	s := identityServer(t)

	activitySet(t, s, `{"toolId":"9","agent":"claude","state":"idle","sessionId":"sess-1"}`)
	// 신원을 말하지 않는 보고(압축·바이트만 실은 것)가 있던 신원을 지우면 안 된다.
	activitySet(t, s, `{"toolId":"9","agent":"claude","state":"working"}`)

	if info := s.AgentSession("9"); info == nil || info.SessionID != "sess-1" {
		t.Fatalf("뒤따른 보고가 신원을 지웠다: %+v", info)
	}
}
