// 에이전트 접합면의 서버측 절반이다 (SKILL_INJECTION_SRS 묶음 B). MCP 폐지로
// 사라진 read_screen / read_output / send_input / send_agent_message 의 액션 계층을
// dmctl 이 호출하는 HTTP 엔드포인트로 옮겼다.
//
// 세 핸들러 모두 toolaccess 인터페이스(Deps.ToolIO / Deps.WorkIndex)만 경유한다.
// 구현은 internal/adapters 이고, 그쪽이 direct 모드(toolhub.ToolManager)와 daemon 모드
// (toolhub.ToolHub) 의 이중 경로 + bracketed paste + submit 지연을 이미 캡슐화하므로
// 두 모드에서 동일하게 동작한다 (FR-API-6).
package httpapi

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"
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

// resolveToolID maps an identifier (tab uuid / toolId / label) to a live toolId.
// FR-API-4: unknown identifier or dead tool → 404.
func (s *Server) resolveToolID(w http.ResponseWriter, id string) (string, bool) {
	if id == "" {
		writeToolIOError(w, http.StatusBadRequest, "id 누락")
		return "", false
	}
	toolID, err := s.WorkIndex.Resolve(id)
	if err != nil {
		writeToolIOError(w, http.StatusNotFound, err.Error())
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
	fromLabel, toLabel := s.envelopeLabels(body.From, toolID)
	envelope := fmt.Sprintf(
		"[DONGMINAL-AGENT-MSG from=%s to=%s ts=%s]\n%s\n[/DONGMINAL-AGENT-MSG]",
		fromLabel, toLabel, time.Now().Format("15:04:05"), body.Message,
	)
	if err := s.ToolIO.SendPaste(toolID, []byte(envelope), true); err != nil {
		writeToolIOError(w, http.StatusInternalServerError, err.Error())
		return
	}
	log.Printf("[toolio] message from=%s(input=%s) to=%s(input=%s tool=%s) msgLen=%d",
		fromLabel, body.From, toLabel, body.To, toolID, len(body.Message))
	writeJSON(w, map[string]any{
		"toolId": toolID, "from": fromLabel, "to": toLabel, "len": len(body.Message),
	})
}

// envelopeLabels normalizes the envelope header for human readability: a uuid or
// toolId input is rendered as its workspace label. Routing already happened via
// resolveToolID, so this never affects delivery (NFR-UID-0). An unresolvable
// `from` passes through verbatim; an empty one becomes "unknown".
func (s *Server) envelopeLabels(from, toToolID string) (string, string) {
	labels := s.WorkIndex.Labels()
	fromLabel := from
	if fromLabel == "" {
		fromLabel = "unknown"
	} else if pid, err := s.WorkIndex.Resolve(from); err == nil {
		if l, ok := labels[pid]; ok {
			fromLabel = l
		}
	}
	toLabel := toToolID
	if l, ok := labels[toToolID]; ok {
		toLabel = l
	}
	return fromLabel, toLabel
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
