package fakeagent

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// NDJSON(rpc-ui) 판 — 형태는 17.4.0 실측·소스에서 옮겼다 (M8_PROGRESS §2-27). 명령은
// 즉시 응답하고 턴은 세션 이벤트로 흐른다. 승인은 `extension_ui_request{select}` 다.

type ompAgent struct {
	out      io.Writer
	lines    chan []byte
	sid      string
	model    string
	provider string
	approval string
	resumed  bool
}

func ompMain(args []string, stdin io.Reader, stdout io.Writer) int {
	a := &ompAgent{out: stdout, model: "fake-model-1", provider: "fake", approval: "yolo", sid: newID("sess")}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--resume":
			if i+1 < len(args) {
				a.sid = args[i+1]
				a.resumed = true
				i++
			}
		case "--model":
			if i+1 < len(args) {
				a.model = strings.TrimPrefix(args[i+1], a.provider+"/")
				i++
			}
		case "--approval-mode":
			if i+1 < len(args) {
				a.approval = args[i+1]
				i++
			}
		}
	}
	a.emit(map[string]any{"type": "ready", "protocolVersion": 1, "supportedProtocolVersions": []int{1, 2}, "maxFrameBytes": 1048576})
	a.emit(map[string]any{"type": "available_commands_update", "commands": []map[string]any{
		{"name": "compact", "source": "builtin", "description": "compact"}, {"name": "clear", "source": "builtin", "description": "clear"}, {"name": "model", "source": "builtin", "description": "model"}}})
	a.lines = readLines(stdin)
	for line := range a.lines {
		if code, exit := a.handle(line); exit {
			return code
		}
	}
	return 0
}

func (a *ompAgent) emit(v map[string]any) {
	b, _ := json.Marshal(v)
	fmt.Fprintf(a.out, "%s\n", b)
}

func (a *ompAgent) respond(id, cmd string, data any) {
	m := map[string]any{"type": "response", "command": cmd, "success": true}
	if id != "" {
		m["id"] = id
	}
	if data != nil {
		m["data"] = data
	}
	a.emit(m)
}

func (a *ompAgent) fail(id, cmd, msg string) {
	a.emit(map[string]any{"id": id, "type": "response", "command": cmd, "success": false, "error": msg})
}

func (a *ompAgent) modelObj() map[string]any {
	return map[string]any{"id": a.model, "name": "Fake " + a.model, "provider": a.provider, "contextWindow": 200000}
}

type ompCmd struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Message   string          `json:"message"`
	Provider  string          `json:"provider"`
	ModelID   string          `json:"modelId"`
	Value     string          `json:"value"`
	Confirmed *bool           `json:"confirmed"`
	Cancelled bool            `json:"cancelled"`
	Raw       json.RawMessage `json:"-"`
}

func (a *ompAgent) handle(line []byte) (int, bool) {
	var c ompCmd
	if err := json.Unmarshal(line, &c); err != nil || c.Type == "" {
		a.emit(map[string]any{"type": "response", "command": "parse", "success": false, "error": "bad frame"})
		return 0, false
	}
	switch c.Type {
	case "get_state":
		a.respond(c.ID, c.Type, map[string]any{"sessionId": a.sid, "model": a.modelObj(), "thinkingLevel": "high", "isStreaming": false,
			"contextUsage": map[string]any{"tokens": 1110, "contextWindow": 200000, "percent": 0.55}})
	case "get_available_models":
		a.respond(c.ID, c.Type, map[string]any{"models": []map[string]any{
			{"id": "fake-model-1", "name": "Default (fake)", "provider": a.provider, "contextWindow": 200000},
			{"id": "fast", "name": "Fast (fake)", "provider": a.provider, "contextWindow": 200000}}})
	case "set_model":
		if c.Provider != a.provider {
			a.fail(c.ID, c.Type, "Model not found: "+c.Provider+"/"+c.ModelID)
			return 0, false
		}
		a.model = c.ModelID
		a.respond(c.ID, c.Type, a.modelObj())
		a.emit(map[string]any{"type": "model_changed"})
	case "set_thinking_level", "abort", "negotiate_protocol":
		a.respond(c.ID, c.Type, nil)
	case "prompt":
		a.respond(c.ID, c.Type, nil)
		return a.turn(c.Message)
	case "extension_ui_response":
	default:
		a.emit(map[string]any{"type": "response", "command": c.Type, "success": false, "error": "Unknown command: " + c.Type})
	}
	return 0, false
}

func (a *ompAgent) turn(text string) (int, bool) {
	switch {
	case strings.Contains(text, "DIE"):
		return 1, true
	case strings.HasPrefix(text, "/"):
		if strings.HasPrefix(text, "/clear") {
			a.sid = newID("sess")
			a.emit(map[string]any{"type": "session_info_update", "title": "", "sessionId": a.sid})
		}
		a.emit(map[string]any{"type": "command_output", "text": "ok: " + text})
		a.respond("", "prompt", map[string]any{"agentInvoked": false})
		return 0, false
	}
	a.emit(map[string]any{"type": "agent_start"})
	a.emit(map[string]any{"type": "turn_start"})
	user := map[string]any{"role": "user", "content": []map[string]any{{"type": "text", "text": text}}, "timestamp": time.Now().UnixMilli()}
	a.emit(map[string]any{"type": "message_start", "message": user})
	a.emit(map[string]any{"type": "message_end", "message": user})
	switch {
	case strings.Contains(text, "APPROVE"):
		if !a.approveTurn() {
			return 0, false
		}
	case strings.Contains(text, "QUESTION"):
		if !a.questionTurn() {
			return 0, false
		}
	case strings.Contains(text, "TOOLARG"):
		// M12_SRS V-M12-3: omp 도 도구 시작 프레임이 인자를 들고 있다.
		tid := newID("tc")
		a.emit(map[string]any{"type": "tool_execution_start", "sessionId": a.sid,
			"toolName": "shell", "toolCallId": tid, "args": map[string]any{"command": "seq 1 3"}})
		a.assistant("", map[string]any{"type": "toolCall", "id": tid, "name": "shell",
			"arguments": map[string]any{"command": "seq 1 3"}})
		a.emit(map[string]any{"type": "tool_execution_end", "sessionId": a.sid,
			"toolName": "shell", "toolCallId": tid, "result": "1\n2\n3", "isError": false})
		a.assistant("TOOLDONE", nil)
	case strings.Contains(text, "SLOW"):
		a.slow()
	default:
		a.assistant("PONG", nil)
	}
	a.emit(map[string]any{"type": "agent_end", "messages": []any{}})
	return 0, false
}

func (a *ompAgent) assistantMsg(content []map[string]any, stop string) map[string]any {
	return map[string]any{"role": "assistant", "content": content, "api": "fake", "provider": a.provider, "model": a.model,
		"usage": map[string]any{"input": 10, "output": 5, "cacheRead": 1000, "cacheWrite": 100, "totalTokens": 1115,
			"cost": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0.001}},
		"stopReason": stop, "timestamp": time.Now().UnixMilli()}
}

// assistant 는 델타 하나와 스냅샷으로 한 메시지를 낸다. toolCall 이 있으면 그 블록도.
func (a *ompAgent) assistant(text string, toolCall map[string]any) {
	a.emit(map[string]any{"type": "message_start", "message": a.assistantMsg([]map[string]any{}, "stop")})
	content := []map[string]any{}
	if text != "" {
		a.emit(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "text_delta", "contentIndex": 0, "delta": text}, "message": a.assistantMsg([]map[string]any{}, "stop")})
		content = append(content, map[string]any{"type": "text", "text": text})
	}
	stop := "stop"
	if toolCall != nil {
		a.emit(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "toolcall_end", "contentIndex": len(content), "toolCall": toolCall}, "message": a.assistantMsg([]map[string]any{}, "stop")})
		content = append(content, toolCall)
		stop = "toolUse"
	}
	m := a.assistantMsg(content, stop)
	a.emit(map[string]any{"type": "message_end", "message": m})
	a.emit(map[string]any{"type": "turn_end", "message": m, "toolResults": []any{}})
}

// slow 는 델타를 천천히 낸다. 사이에 abort 가 오면 오류 정지로 끝난다.
func (a *ompAgent) slow() {
	a.emit(map[string]any{"type": "message_start", "message": a.assistantMsg([]map[string]any{}, "stop")})
	for i := 0; i < 50; i++ {
		select {
		case line, ok := <-a.lines:
			if !ok {
				return
			}
			var c ompCmd
			_ = json.Unmarshal(line, &c)
			if c.Type == "abort" {
				a.respond(c.ID, c.Type, nil)
				m := a.assistantMsg([]map[string]any{}, "aborted")
				m["errorMessage"] = "aborted"
				a.emit(map[string]any{"type": "message_end", "message": m})
				return
			}
			a.handle(line)
		case <-time.After(100 * time.Millisecond):
		}
		a.emit(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "text_delta", "contentIndex": 0, "delta": fmt.Sprintf("tick%d ", i)}, "message": a.assistantMsg([]map[string]any{}, "stop")})
	}
	a.emit(map[string]any{"type": "message_end", "message": a.assistantMsg([]map[string]any{{"type": "text", "text": "slow done"}}, "stop")})
}

// awaitUI 는 UI 요청 id 의 응답을 기다린다. stdin 이 닫히면 false.
func (a *ompAgent) awaitUI(id string) (ompCmd, bool) {
	for line := range a.lines {
		var c ompCmd
		if err := json.Unmarshal(line, &c); err != nil {
			continue
		}
		if c.Type == "extension_ui_response" && c.ID == id {
			return c, true
		}
		a.handle(line)
	}
	return ompCmd{}, false
}

func (a *ompAgent) approveTurn() bool {
	tc := map[string]any{"type": "toolCall", "id": newID("tc"), "name": "bash", "arguments": map[string]any{"command": "touch fake.txt"}}
	a.assistant("", tc)
	if a.approval != "yolo" {
		id := newID("ui")
		a.emit(map[string]any{"type": "extension_ui_request", "id": id, "method": "select", "title": "Allow tool: bash\nCommand: touch fake.txt", "options": []string{"Approve", "Deny"}})
		r, ok := a.awaitUI(id)
		if !ok {
			return false
		}
		if r.Value != "Approve" {
			a.emit(map[string]any{"type": "message_end", "message": map[string]any{"role": "toolResult", "toolCallId": tc["id"], "toolName": "bash",
				"content": []map[string]any{{"type": "text", "text": "Tool call denied by user: bash"}}, "isError": true, "timestamp": time.Now().UnixMilli()}})
			a.assistant("DENIED", nil)
			return true
		}
	}
	a.emit(map[string]any{"type": "tool_execution_start", "toolCallId": tc["id"], "toolName": "bash", "args": tc["arguments"]})
	a.emit(map[string]any{"type": "tool_execution_end", "toolCallId": tc["id"], "toolName": "bash", "result": map[string]any{"content": []map[string]any{{"type": "text", "text": "(bash completed with no output)"}}}, "isError": false})
	a.emit(map[string]any{"type": "message_end", "message": map[string]any{"role": "toolResult", "toolCallId": tc["id"], "toolName": "bash",
		"content": []map[string]any{{"type": "text", "text": "(bash completed with no output)"}}, "isError": false, "timestamp": time.Now().UnixMilli()}})
	a.assistant("DONE", nil)
	return true
}

func (a *ompAgent) questionTurn() bool {
	id := newID("ui")
	a.emit(map[string]any{"type": "extension_ui_request", "id": id, "method": "select", "title": "Pick a color", "options": []string{"Red", "Blue"}})
	r, ok := a.awaitUI(id)
	if !ok {
		return false
	}
	picked := r.Value
	if r.Cancelled || picked == "" {
		picked = "?"
	}
	a.assistant(picked, nil)
	return true
}
