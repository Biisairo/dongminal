// Package fakeagent 는 프로토콜 표면을 말하는 **가짜 에이전트**다 (M8_UNIFIED_SRS
// §9.3 ② · V-12 · D-C-9). e2e 와 핸들러 테스트가 실제 바이너리 대신 이것을 꽂는다 —
// 서버는 `DONGMINAL_AGENT_BIN_DIR` 에서 `DetectCmd` 이름의 파일을 먼저 찾으므로
// (D-C-7) 픽스처는 그 이름으로 놓인다.
//
// **세 프로토콜을 말한다** (§9.2 R-a — e2e 가 셋을 잰다). 어느 것을 말할지는 argv 의
// 모양이 고른다 — 이름이 아니다: `app-server` 가 있으면 JSON-RPC(codex 판, fake_codex.go),
// `--mode rpc-ui` 가 있으면 NDJSON(omp 판, fake_omp.go), 그 밖은 stream-json(claude 판,
// 이 파일). 프레임의 **형태**는 실측(§2.3.4 · M8_PROGRESS §2-27)에서 옮겼고 내용은 PONG
// 류다 (NFR-C-1). 시나리오는 세 판이 같고 프롬프트 본문이 고른다 (D-C-9):
//
//	APPROVE  → 도구 승인을 열고 답을 기다린 뒤 도구 결과와 DONE
//	QUESTION → 선택형 질문을 열고 답한 라벨을 되읊는다
//	SLOW     → 델타를 천천히 낸다 — interrupt 가 끊을 자리
//	DIE      → 턴을 끝내지 않고 exit 1 (V-8)
//	/…       → 로컬 명령의 답; /clear 는 신원 교체
//	그 밖    → PONG
//
// claude 판의 `system:init` 은 실제와 같이 **첫 프롬프트 뒤**에 온다 (§2-28 · D-C-16) —
// 첫 턴 전의 `idle` 은 `initialize` 응답에서 파생한다. `--resume <id>` 는 세 판 다 이력
// 없이 그 id 로 신원만 되돌린다 (U-4).
package fakeagent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Main 은 argv(프로그램 이름 제외)로 한 프로세스를 돈다. 종료 코드를 돌려준다.
func Main(args []string, stdin io.Reader, stdout io.Writer) int {
	for i, a := range args {
		switch {
		case a == "app-server":
			return codexMain(args, stdin, stdout)
		case a == "--mode" && i+1 < len(args) && args[i+1] == "rpc-ui":
			return ompMain(args, stdin, stdout)
		}
	}
	return claudeMain(args, stdin, stdout)
}

// readLines 는 stdin 을 줄 채널로 — 세 판이 같이 쓴다.
func readLines(stdin io.Reader) chan []byte {
	lines := make(chan []byte, 64)
	go func() {
		sc := bufio.NewScanner(stdin)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			lines <- append([]byte(nil), sc.Bytes()...)
		}
		close(lines)
	}()
	return lines
}

// claudeMain 은 stream-json 판이다.
func claudeMain(args []string, stdin io.Reader, stdout io.Writer) int {
	a := &agent{out: stdout, model: "fake-model-1", permMode: "default", sid: newID("sess")}
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
				a.model = args[i+1]
				i++
			}
		case "--permission-mode":
			if i+1 < len(args) {
				a.permMode = args[i+1]
				i++
			}
		}
	}
	// `system:init` 은 여기서 내지 않는다 — 실제 claude 는 첫 `user` 프레임 뒤에 낸다
	// (M8_PROGRESS §2-28 · D-C-16). 첫 프롬프트가 handle 에서 그것을 낸다. `--resume` 도 같다.
	a.lines = readLines(stdin)
	for line := range a.lines {
		if code, exit := a.handle(line); exit {
			return code
		}
	}
	return 0
}

type agent struct {
	out      io.Writer
	lines    chan []byte
	sid      string
	model    string
	permMode string
	resumed  bool
	inited   bool
	seq      int
}

func newID(prefix string) string {
	return fmt.Sprintf("%s-%d-%d", prefix, os.Getpid(), time.Now().UnixNano()%1000000)
}

func (a *agent) emit(v map[string]any) {
	a.seq++
	if _, ok := v["uuid"]; !ok {
		v["uuid"] = fmt.Sprintf("u-%d", a.seq)
	}
	if _, ok := v["session_id"]; !ok && v["type"] != "control_request" && v["type"] != "control_response" {
		v["session_id"] = a.sid
	}
	b, _ := json.Marshal(v)
	fmt.Fprintf(a.out, "%s\n", b)
}

func (a *agent) init() {
	a.emit(map[string]any{"type": "system", "subtype": "init", "cwd": mustCwd(),
		"tools": []string{"Bash", "Read", "Edit", "AskUserQuestion"}, "mcp_servers": []any{},
		"model": a.model, "permissionMode": a.permMode, "slash_commands": []string{"compact", "clear", "model"},
		"apiKeySource": "none", "claude_code_version": "fake"})
}

func mustCwd() string {
	d, _ := os.Getwd()
	return d
}

// handle 은 stdin 한 줄이다. exit=true 면 프로세스를 끝낸다.
func (a *agent) handle(line []byte) (int, bool) {
	var fr struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Request   struct {
			Subtype string `json:"subtype"`
			Model   string `json:"model"`
			Mode    string `json:"mode"`
		} `json:"request"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &fr); err != nil {
		return 0, false
	}
	switch fr.Type {
	case "control_request":
		a.control(fr.RequestID, fr.Request.Subtype, fr.Request.Model, fr.Request.Mode)
	case "user":
		var text string
		_ = json.Unmarshal(fr.Message.Content, &text)
		if !a.inited {
			a.inited = true
			a.init()
		}
		return a.turn(text)
	}
	return 0, false
}

func (a *agent) control(id, subtype, model, mode string) {
	ok := func(resp any) {
		a.emit(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": id, "response": resp}})
	}
	switch subtype {
	case "initialize":
		ok(map[string]any{
			"commands": []map[string]any{{"name": "compact", "description": "compact"}, {"name": "clear", "description": "clear"}, {"name": "model", "description": "model"}},
			"models": []map[string]any{
				{"value": "default", "displayName": "Default (fake)", "description": "fake default"},
				{"value": "fast", "displayName": "Fast (fake)", "description": "fake fast"},
			},
			"account":                 map[string]any{"email": "fake@example", "subscriptionType": "Fake"},
			"current_permission_mode": a.permMode, "session_state": "idle",
		})
	case "set_model":
		a.model = model
		ok(map[string]any{})
	case "set_permission_mode":
		a.permMode = mode
		ok(map[string]any{"mode": mode})
		a.emit(map[string]any{"type": "system", "subtype": "status", "status": nil, "permissionMode": mode})
	case "set_max_thinking_tokens", "interrupt":
		ok(map[string]any{})
	default:
		a.emit(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "error", "request_id": id, "error": "unknown subtype " + subtype}})
	}
}

// turn 은 프롬프트 하나의 턴이다.
func (a *agent) turn(text string) (int, bool) {
	switch {
	case strings.Contains(text, "DIE"):
		return 1, true
	case strings.HasPrefix(text, "/"):
		a.local(text)
		return 0, false
	}
	a.emit(map[string]any{"type": "system", "subtype": "status", "status": "requesting"})
	a.messageStart()
	switch {
	case strings.Contains(text, "APPROVE"):
		a.toolTurn("Bash", map[string]any{"command": "touch fake.txt", "description": "Create fake.txt"},
			[]map[string]any{{"type": "setMode", "mode": "acceptEdits", "destination": "session"}}, "DONE")
	case strings.Contains(text, "QUESTION"):
		a.questionTurn()
	case strings.Contains(text, "SLOW"):
		if a.slowText() {
			// 인터럽트로 끊겼다 — aborted result.
			a.result(true, "aborted_streaming")
			return 0, false
		}
	default:
		a.text("PONG")
	}
	a.rateLimit()
	a.result(false, "completed")
	return 0, false
}

func (a *agent) messageStart() {
	a.emit(map[string]any{"type": "stream_event", "parent_tool_use_id": nil, "ttft_ms": 5,
		"event": map[string]any{"type": "message_start", "message": map[string]any{
			"model": a.model, "id": newID("msg"), "type": "message", "role": "assistant", "content": []any{},
			"usage": map[string]any{"input_tokens": 10, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000, "output_tokens": 1}}}})
}

func (a *agent) text(s string) {
	a.emit(map[string]any{"type": "stream_event", "parent_tool_use_id": nil,
		"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}}})
	a.emit(map[string]any{"type": "stream_event", "parent_tool_use_id": nil,
		"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": s}}})
	a.assistant([]map[string]any{{"type": "text", "text": s}})
	a.emit(map[string]any{"type": "stream_event", "parent_tool_use_id": nil, "event": map[string]any{"type": "content_block_stop", "index": 0}})
	a.emit(map[string]any{"type": "stream_event", "parent_tool_use_id": nil, "event": map[string]any{"type": "message_stop"}})
}

// slowText 는 델타를 천천히 낸다. 사이에 interrupt 가 오면 true.
func (a *agent) slowText() bool {
	a.emit(map[string]any{"type": "stream_event", "parent_tool_use_id": nil,
		"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}}})
	for i := 0; i < 50; i++ {
		select {
		case line, ok := <-a.lines:
			if !ok {
				return true
			}
			if strings.Contains(string(line), `"interrupt"`) {
				var fr struct {
					RequestID string `json:"request_id"`
				}
				_ = json.Unmarshal(line, &fr)
				a.emit(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": fr.RequestID, "response": map[string]any{"still_queued": []any{}}}})
				return true
			}
		case <-time.After(100 * time.Millisecond):
		}
		a.emit(map[string]any{"type": "stream_event", "parent_tool_use_id": nil,
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": fmt.Sprintf("tick%d ", i)}}})
	}
	a.assistant([]map[string]any{{"type": "text", "text": "slow done"}})
	return false
}

func (a *agent) assistant(content []map[string]any) {
	a.emit(map[string]any{"type": "assistant", "parent_tool_use_id": nil, "request_id": newID("req"), "timestamp": time.Now().UTC().Format(time.RFC3339),
		"message": map[string]any{"model": a.model, "id": newID("msg"), "type": "message", "role": "assistant", "content": content,
			"usage": map[string]any{"input_tokens": 10, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000, "output_tokens": 5}}})
}

// awaitResponse 는 request_id 의 control_response 를 기다린다. 그 사이의 다른
// 제어 요청은 처리한다. stdin 이 닫히면 false.
func (a *agent) awaitResponse(id string) (map[string]any, bool) {
	for line := range a.lines {
		var fr struct {
			Type      string `json:"type"`
			RequestID string `json:"request_id"`
			Request   struct {
				Subtype, Model, Mode string
			} `json:"request"`
			Response struct {
				RequestID string         `json:"request_id"`
				Response  map[string]any `json:"response"`
			} `json:"response"`
		}
		if err := json.Unmarshal(line, &fr); err != nil {
			continue
		}
		if fr.Type == "control_response" && fr.Response.RequestID == id {
			return fr.Response.Response, true
		}
		if fr.Type == "control_request" {
			a.control(fr.RequestID, fr.Request.Subtype, fr.Request.Model, fr.Request.Mode)
		}
	}
	return nil, false
}

func (a *agent) toolTurn(tool string, input map[string]any, suggestions []map[string]any, finalText string) {
	toolUse := newID("toolu")
	a.emit(map[string]any{"type": "stream_event", "parent_tool_use_id": nil,
		"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": toolUse, "name": tool, "input": map[string]any{}}}})
	a.assistant([]map[string]any{{"type": "tool_use", "id": toolUse, "name": tool, "input": input}})
	reqID := newID("perm")
	a.emit(map[string]any{"type": "control_request", "request_id": reqID, "request": map[string]any{
		"subtype": "can_use_tool", "tool_name": tool, "display_name": tool, "input": input,
		"description": input["description"], "permission_suggestions": suggestions, "tool_use_id": toolUse}})
	resp, ok := a.awaitResponse(reqID)
	if !ok {
		return
	}
	if resp["behavior"] == "deny" {
		a.emit(map[string]any{"type": "user", "parent_tool_use_id": nil, "message": map[string]any{"role": "user",
			"content": []map[string]any{{"tool_use_id": toolUse, "type": "tool_result", "content": "denied", "is_error": true}}}})
		a.text("DENIED")
		return
	}
	if ups, ok := resp["updatedPermissions"].([]any); ok {
		for _, u := range ups {
			if m, ok := u.(map[string]any); ok && m["type"] == "setMode" {
				if mode, ok := m["mode"].(string); ok {
					a.permMode = mode
					a.emit(map[string]any{"type": "system", "subtype": "status", "status": nil, "permissionMode": mode})
				}
			}
		}
	}
	a.emit(map[string]any{"type": "user", "parent_tool_use_id": nil, "message": map[string]any{"role": "user",
		"content": []map[string]any{{"tool_use_id": toolUse, "type": "tool_result", "content": "(" + tool + " completed with no output)", "is_error": false}}},
		"tool_use_result": map[string]any{"stdout": "", "stderr": ""}})
	a.emit(map[string]any{"type": "system", "subtype": "status", "status": "requesting"})
	a.messageStart()
	a.text(finalText)
}

func (a *agent) questionTurn() {
	toolUse := newID("toolu")
	input := map[string]any{"questions": []map[string]any{{
		"question": "Pick a color", "header": "Color", "multiSelect": false,
		"options": []map[string]any{{"label": "Red", "description": "The color red"}, {"label": "Blue", "description": "The color blue"}},
	}}}
	a.emit(map[string]any{"type": "stream_event", "parent_tool_use_id": nil,
		"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": toolUse, "name": "AskUserQuestion", "input": map[string]any{}}}})
	a.assistant([]map[string]any{{"type": "tool_use", "id": toolUse, "name": "AskUserQuestion", "input": input}})
	reqID := newID("perm")
	a.emit(map[string]any{"type": "control_request", "request_id": reqID, "request": map[string]any{
		"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "display_name": "AskUserQuestion", "input": input,
		"tool_use_id": toolUse, "requires_user_interaction": true}})
	resp, ok := a.awaitResponse(reqID)
	if !ok {
		return
	}
	picked := "?"
	if ui, ok := resp["updatedInput"].(map[string]any); ok {
		if ans, ok := ui["answers"].(map[string]any); ok {
			if v, ok := ans["Pick a color"].(string); ok {
				picked = v
			}
		}
	}
	a.emit(map[string]any{"type": "user", "parent_tool_use_id": nil, "message": map[string]any{"role": "user",
		"content": []map[string]any{{"tool_use_id": toolUse, "type": "tool_result", "content": "Your questions have been answered: \"Pick a color\"=\"" + picked + "\""}}}})
	a.emit(map[string]any{"type": "system", "subtype": "status", "status": "requesting"})
	a.messageStart()
	a.text(picked)
}

func (a *agent) local(cmd string) {
	if strings.HasPrefix(cmd, "/clear") {
		old := a.sid
		a.sid = newID("sess")
		a.emit(map[string]any{"type": "conversation_reset", "new_conversation_id": a.sid, "session_id": old})
		a.init()
	}
	a.emit(map[string]any{"type": "assistant", "parent_tool_use_id": nil, "request_id": newID("req"),
		"message": map[string]any{"model": "<synthetic>", "id": newID("msg"), "type": "message", "role": "assistant",
			"content": []map[string]any{{"type": "text", "text": "ok: " + cmd}}}})
	a.result(false, "completed")
}

// rateLimit 은 실측한 `rate_limit_event` 를 그대로 흉내 낸다 (M9_SRS FR-M9-34).
//
// `unifiedWindows` 는 **키가 가변**이고 값은 **총량 없이 비율만** 준다 — 그 모양이
// 곧 `ProtoLimit` 이 목록인 이유다. 여기 셋째 창(`monthly`)을 함께 두는 이유는
// **우리가 아는 둘만으로는 가변성이 검사되지 않기** 때문이다.
func (a *agent) rateLimit() {
	a.emit(map[string]any{"type": "rate_limit_event",
		"rate_limit_info": map[string]any{"status": "allowed", "rateLimitType": "five_hour",
			"unifiedWindows": map[string]any{
				"five_hour": map[string]any{"utilization": 0.44, "resetsAt": 1789383600},
				"seven_day": map[string]any{"utilization": 0.17, "resetsAt": 1789822800},
				"monthly":   map[string]any{"utilization": 0.05, "resetsAt": 1792414800},
				// **화면이 모르는 주기** (D-M9-23). 카탈로그에 없으므로 이름이 그대로
				// 서야 한다 — 열거로 굳힌 구현에서는 이 창이 조용히 사라진다.
				"opus_weekly": map[string]any{"utilization": 0.02, "resetsAt": 1792500000},
			}}})
}

func (a *agent) result(isErr bool, reason string) {
	sub := "success"
	if isErr {
		sub = "error_during_execution"
	}
	a.emit(map[string]any{"type": "result", "subtype": sub, "is_error": isErr, "duration_ms": 10, "duration_api_ms": 5, "num_turns": 1,
		"result": "PONG", "total_cost_usd": 0.001, "stop_reason": "end_turn", "terminal_reason": reason, "permission_denials": []any{},
		"usage":      map[string]any{"input_tokens": 10, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000, "output_tokens": 5},
		"modelUsage": map[string]any{a.model: map[string]any{"inputTokens": 10, "outputTokens": 5, "costUSD": 0.001, "contextWindow": 200000}}})
}
