// 에이전트 접합면의 서버측 절반이다 (SKILL_INJECTION_SRS 묶음 B). MCP 폐지로
// 사라진 read_screen / read_output / send_input / send_agent_message 의 액션 계층을
// dmctl 이 호출하는 HTTP 엔드포인트로 옮겼다.
//
// 세 핸들러 모두 toolaccess 인터페이스(Deps.ToolIO / Deps.WorkIndex)만 경유한다.
// 구현은 internal/webserver/seam/adapters 이고, 그쪽이 direct 모드(toolhub.ToolManager)와 daemon 모드
// (toolhub.ToolHub) 의 이중 경로 + bracketed paste + submit 지연을 이미 캡슐화하므로
// 두 모드에서 동일하게 동작한다 (FR-API-6).
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"dongminal/internal/shared/workspace"
)

// toolIOReady reports whether the toolaccess deps were injected. Daemon/test
// wirings that omit them get 503 instead of a nil dereference.
func (s *Server) toolIOReady(w http.ResponseWriter) bool {
	if s.ToolIO == nil || s.WorkIndex == nil {
		writeToolIOError(w, http.StatusServiceUnavailable, "tool io unavailable")
		return false
	}
	return true
}

// resolveToolID maps an identifier (tab uuid / toolId) to a live toolId. 이
// 함수 하나가 read-screen·read-output·send-input·msg·status·wait 의 공통 관문이다.
//
// FR-IDU-4: 좌표 라벨은 ResolveStrict 가 거부하고 여기서 400 이 된다 — 에이전트가
// "잘못 불렀다"(400)와 "없다"(404)를 갈라야 하기 때문이다. 미지의 식별자나 죽은
// 도구는 종전대로 404 다 (FR-API-4).
func (s *Server) resolveToolID(w http.ResponseWriter, id string) (string, bool) {
	if id == "" {
		writeToolIOError(w, http.StatusBadRequest, "id 누락")
		return "", false
	}
	toolID, err := s.WorkIndex.ResolveStrict(id)
	if err != nil {
		status := http.StatusNotFound
		if errors.Is(err, workspace.ErrLabelIdentifier) {
			status = http.StatusBadRequest
		}
		writeToolIOError(w, status, err.Error())
		return "", false
	}
	if !s.ToolIO.Has(toolID) {
		writeToolIOError(w, http.StatusNotFound, "tool 없음: "+toolID)
		return "", false
	}
	return toolID, true
}

// apiToolOutput implements GET /api/tools/output?id=&bytes=&strip= (FR-API-1).
// bytes <= 0 (or absent) returns the whole buffer; truncation keeps the tail.
func (s *Server) apiToolOutput(w http.ResponseWriter, r *http.Request) {
	if !s.toolIOReady(w) {
		return
	}
	toolID, ok := s.resolveToolID(w, r.URL.Query().Get("id"))
	if !ok {
		return
	}
	n := 0
	if v := r.URL.Query().Get("bytes"); v != "" {
		parsed, err := strconv.Atoi(v)
		if err != nil {
			writeToolIOError(w, http.StatusBadRequest, "bytes 는 정수여야 한다: "+v)
			return
		}
		n = parsed
	}
	data, dropped, ok := s.ToolIO.Snapshot(toolID)
	if !ok {
		writeToolIOError(w, http.StatusNotFound, "tool 없음: "+toolID)
		return
	}
	if n > 0 && len(data) > n {
		data = data[len(data)-n:]
	}
	text := string(data)
	if r.URL.Query().Get("strip") == "1" {
		text = stripANSI(data)
	}
	writeJSON(w, map[string]any{"toolId": toolID, "text": text, "dropped": dropped})
}

// apiToolInput implements POST /api/tools/input (FR-API-2).
func (s *Server) apiToolInput(w http.ResponseWriter, r *http.Request) {
	if !s.toolIOReady(w) {
		return
	}
	var body struct {
		ID      string `json:"id"`
		Text    string `json:"text"`
		Execute bool   `json:"execute"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeToolIOError(w, http.StatusBadRequest, "잘못된 JSON: "+err.Error())
		return
	}
	toolID, ok := s.resolveToolID(w, body.ID)
	if !ok {
		return
	}
	if err := s.ToolIO.SendPaste(toolID, []byte(body.Text), body.Execute); err != nil {
		writeToolIOError(w, http.StatusInternalServerError, err.Error())
		return
	}
	log.Printf("[toolio] input tool=%s id=%s execute=%v textLen=%d",
		toolID, body.ID, body.Execute, len(body.Text))
	writeJSON(w, map[string]any{"toolId": toolID, "len": len(body.Text), "execute": body.Execute})
}

// apiToolMessage implements POST /api/tools/message (FR-API-3). The envelope is
// assembled here so every caller — and every agent CLI — produces the byte
// format the receiving agent is taught to trust.
func (s *Server) apiToolMessage(w http.ResponseWriter, r *http.Request) {
	if !s.toolIOReady(w) {
		return
	}
	var body struct {
		To      string `json:"to"`
		From    string `json:"from"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeToolIOError(w, http.StatusBadRequest, "잘못된 JSON: "+err.Error())
		return
	}
	if body.Message == "" {
		writeToolIOError(w, http.StatusBadRequest, "message 누락")
		return
	}
	toolID, ok := s.resolveToolID(w, body.To)
	if !ok {
		return
	}
	fromToolID, ok := s.resolveSender(w, body.From)
	if !ok {
		return
	}
	sender := envelopeSender(fromToolID)
	envelope := fmt.Sprintf(
		"[DONGMINAL-AGENT-MSG from=%s to=%s ts=%s]\n%s\n[/DONGMINAL-AGENT-MSG]",
		sender, toolID, time.Now().Format("15:04:05"), body.Message,
	)
	if err := s.ToolIO.SendPaste(toolID, []byte(envelope), true); err != nil {
		writeToolIOError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// FR-RVZ-14: 배달에 성공한 것만 Run 의 사실로 적는다. 실패는 위에서 이미
	// 돌아갔으므로 여기 도달한 것은 전부 전달된 메시지다. 본문은 넘기지 않는다.
	s.recordRunMessage(fromToolID, toolID, len(body.Message))
	log.Printf("[toolio] message from=%s(input=%s) to=%s(input=%s) msgLen=%d",
		sender, body.From, toolID, body.To, len(body.Message))
	writeJSON(w, map[string]any{
		"toolId": toolID, "from": sender, "to": toolID, "len": len(body.Message),
	})
}

// resolveSender resolves the envelope's `from` party to a tool uuid under the
// same rule as `to` — labels are rejected (FR-IDU-9). An empty `from` is allowed
// and returns "", which the header renders as "unknown".
//
// --to 와 규칙을 같이 두는 이유: 헤더의 `from=` 값이 곧 답장의 `--to` 다. 표시
// 전용이라며 라벨을 받아 주면 메시지 경로에 좌표 라벨이 남고, 그 값은 창이 닫히면
// 다른 도구를 가리킨다 (§1.3 reflow). 존재 검사(`ToolIO.Has`)는 하지 않는다 —
// 발신자의 PTY 생존은 배달과 무관하고, 라우팅은 --to 가 정한다.
func (s *Server) resolveSender(w http.ResponseWriter, from string) (string, bool) {
	if from == "" {
		return "", true
	}
	toolID, err := s.WorkIndex.ResolveStrict(from)
	if err != nil {
		status := http.StatusNotFound
		if errors.Is(err, workspace.ErrLabelIdentifier) {
			status = http.StatusBadRequest
		}
		writeToolIOError(w, status, err.Error())
		return "", false
	}
	return toolID, true
}

// envelopeSender renders the `from=` value. 발신자를 주지 않은 호출(dongminal
// 외부)만 "unknown" 이 된다.
func envelopeSender(fromToolID string) string {
	if fromToolID == "" {
		return "unknown"
	}
	return fromToolID
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeToolIOError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
