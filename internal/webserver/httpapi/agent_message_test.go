package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/seam/toolaccess"
)

// M12_SRS FR-M12-8 (V-M12-19~21) — **에이전트 도구에 보낸 메시지는 에이전트에게 간다.**
//
// **이 SRS 를 낳은 결함이다.** M11 의 인계에서 `dmctl msg --to <gui toolId>` 를 두 번
// 보냈고 둘 다 *"전송 완료"* 를 냈는데 `/api/agent/events` 에는 아무것도 남지 않았다.
//
// 경로를 따라가면 한 줄에서 끝난다 — `SendPaste` 가 `KindAgent` 면 `return nil` 이다
// (`toolhub/bracketpaste.go`). 그 무동작 자체는 옳다 (FR-AGT-2: 프레임이 아닌 바이트는
// 에이전트를 깨뜨린다). 틀린 것은 **부르는 쪽이 그것을 성공으로 읽은 것**이다.
//
// 그 자리의 주석은 *"입력은 해석층의 프롬프트 경로로 간다"* 라 적혀 있었는데
// **그 경로로 보내는 코드가 없었다.**

// agentMsgToolIO 는 배달이 PTY 로 새는지 보는 대역이다 — 에이전트 도구에 붙는
// 붙여넣기는 **한 번도 없어야** 한다.
type agentMsgToolIO struct {
	pastes []string
}

func (f *agentMsgToolIO) List() []toolaccess.ToolInfo           { return nil }
func (f *agentMsgToolIO) Has(string) bool                       { return true }
func (f *agentMsgToolIO) Snapshot(string) ([]byte, int64, bool) { return nil, 0, true }
func (f *agentMsgToolIO) Size(string) string                    { return "80x24" }
func (f *agentMsgToolIO) SendPaste(id string, b []byte, _ bool) error {
	f.pastes = append(f.pastes, string(b))
	return nil
}

// agentMsgIndex 는 도구 id 를 그대로 통과시키는 좌표 해석 대역이다
// (`fakeWorkIndex` 를 그대로 쓴다 — 대역을 두 벌로 만들지 않는다).
func agentMsgIndex(id string) *fakeWorkIndex {
	return &fakeWorkIndex{
		resolve:  map[string]string{id: id, "other": "other"},
		labelIdx: map[string]string{},
		coords:   map[string]string{},
	}
}

// agentEventTexts 는 이벤트 로그의 본문들이다 — 닿았는지는 글자로 본다.
func agentEventTexts(t *testing.T, s *Server, toolID string) []string {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiAgentEvents(rec, apiTestRequest(http.MethodGet, "/api/agent/events?tool="+toolID+"&since=0", nil))
	var resp struct {
		Events []struct {
			Ev struct{ Text string } `json:"ev"`
		} `json:"events"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	var out []string
	for _, e := range resp.Events {
		if e.Ev.Text != "" {
			out = append(out, e.Ev.Text)
		}
	}
	return out
}

// V-M12-19·21: 에이전트 도구면 프롬프트로 간다 — 엔벨로프 바이트는 종전과 같다.
func TestAgentMessage_ReachesAgentSession(t *testing.T) {
	s, m, _ := directAgentServer(t)
	id := createAgent(t, s, "")
	tool := m.Get(id)
	waitAgent(t, "idle", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })

	io := &agentMsgToolIO{}
	s.Deps.ToolIO = io
	s.Deps.WorkIndex = agentMsgIndex(id)

	rec := httptest.NewRecorder()
	s.apiToolMessage(rec, apiTestRequest(http.MethodPost, "/api/tools/message",
		strings.NewReader(`{"to":"`+id+`","from":"other","message":"읽고 진행하라"}`)))
	if rec.Code != 200 {
		t.Fatalf("status=%d %s", rec.Code, rec.Body.String())
	}
	// **PTY 로 새지 않았다.**
	if len(io.pastes) != 0 {
		t.Fatalf("에이전트 도구에 붙여넣기가 나갔다: %q", io.pastes)
	}
	// 그리고 **실제로 닿았다** — 이벤트 로그에 사용자 항목으로 선다.
	waitAgent(t, "프롬프트가 이벤트 로그에 선다", func() bool {
		_, kinds, _ := agentEvents(t, s, id, 0)
		return has(kinds, "user")
	})
	joined := strings.Join(agentEventTexts(t, s, id), "\n")
	// V-M12-21: 엔벨로프 **바이트가 종전과 같다** — 터미널 경로와 같은 것을 만든다.
	for _, want := range []string{"[DONGMINAL-AGENT-MSG", "from=other", "to=" + id, "읽고 진행하라", "[/DONGMINAL-AGENT-MSG]"} {
		if !strings.Contains(joined, want) {
			t.Errorf("엔벨로프에 %q 가 없다:\n%s", want, joined)
		}
	}
}

// V-M12-19: `/api/tools/input` 도 같은 문을 지난다 — 손이 둘이면 한쪽만 고쳐진다.
func TestAgentInput_ReachesAgentSession(t *testing.T) {
	s, m, _ := directAgentServer(t)
	id := createAgent(t, s, "")
	tool := m.Get(id)
	waitAgent(t, "idle", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })

	io := &agentMsgToolIO{}
	s.Deps.ToolIO = io
	s.Deps.WorkIndex = agentMsgIndex(id)

	rec := httptest.NewRecorder()
	s.apiToolInput(rec, apiTestRequest(http.MethodPost, "/api/tools/input",
		strings.NewReader(`{"id":"`+id+`","text":"say PONG","execute":true}`)))
	if rec.Code != 200 {
		t.Fatalf("status=%d %s", rec.Code, rec.Body.String())
	}
	if len(io.pastes) != 0 {
		t.Fatalf("에이전트 도구에 붙여넣기가 나갔다: %q", io.pastes)
	}
	waitAgent(t, "프롬프트가 닿는다", func() bool {
		return strings.Contains(strings.Join(agentEventTexts(t, s, id), "\n"), "say PONG")
	})
}
