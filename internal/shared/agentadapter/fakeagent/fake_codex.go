package fakeagent

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

// JSON-RPC(app-server) 판 — 형태는 0.154.0 실측·스키마에서 옮겼다 (M8_PROGRESS §2-27).
// 요청은 순서대로 처리하고 응답 뒤에 알림을 낸다. 한 thread 만 든다 (F-3).

type codexAgent struct {
	out      io.Writer
	lines    chan []byte
	threadID string
	turnSeq  int
	itemSeq  int
	model    string
	approval string
	resumed  bool
}

func codexMain(_ []string, stdin io.Reader, stdout io.Writer) int {
	a := &codexAgent{out: stdout, model: "fake-model-1", approval: "on-request"}
	a.lines = readLines(stdin)
	for line := range a.lines {
		if code, exit := a.handle(line); exit {
			return code
		}
	}
	return 0
}

func (a *codexAgent) emit(v map[string]any) {
	b, _ := json.Marshal(v)
	fmt.Fprintf(a.out, "%s\n", b)
}

func (a *codexAgent) notify(method string, params map[string]any) {
	a.emit(map[string]any{"method": method, "params": params, "emittedAtMs": time.Now().UnixMilli()})
}

func (a *codexAgent) result(id json.RawMessage, result any) {
	a.emit(map[string]any{"id": id, "result": result})
}

func (a *codexAgent) rpcError(id json.RawMessage, msg string) {
	a.emit(map[string]any{"id": id, "error": map[string]any{"code": -32600, "message": msg}})
}

func (a *codexAgent) nextItem() string {
	a.itemSeq++
	return fmt.Sprintf("item-%d", a.itemSeq)
}

type codexReq struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		ThreadID       string `json:"threadId"`
		TurnID         string `json:"turnId"`
		Cwd            string `json:"cwd"`
		Model          string `json:"model"`
		ApprovalPolicy string `json:"approvalPolicy"`
		Input          []struct {
			Text string `json:"text"`
		} `json:"input"`
	} `json:"params"`
	Result json.RawMessage `json:"result"`
}

func (a *codexAgent) thread() map[string]any {
	return map[string]any{"id": a.threadID, "sessionId": a.threadID, "model": a.model, "status": map[string]any{"type": "idle"}, "turns": []any{}}
}

func (a *codexAgent) handle(line []byte) (int, bool) {
	var r codexReq
	if err := json.Unmarshal(line, &r); err != nil || r.Method == "" {
		return 0, false
	}
	switch r.Method {
	case "initialize":
		a.result(r.ID, map[string]any{"userAgent": "fake/0.0", "codexHome": "/nowhere", "platformFamily": "unix", "platformOs": "fake"})
	case "initialized":
	case "thread/start", "thread/resume":
		if r.Method == "thread/resume" {
			a.threadID = r.Params.ThreadID
			a.resumed = true
		} else {
			a.threadID = newID("thread")
		}
		if r.Params.Model != "" {
			a.model = r.Params.Model
		}
		if r.Params.ApprovalPolicy != "" {
			a.approval = r.Params.ApprovalPolicy
		}
		a.result(r.ID, map[string]any{"thread": a.thread(), "model": a.model, "modelProvider": "fake", "cwd": r.Params.Cwd,
			"approvalPolicy": a.approval, "approvalsReviewer": "user", "sandbox": map[string]any{"type": "readOnly"}})
		a.notify("thread/started", map[string]any{"thread": a.thread()})
	case "model/list":
		a.result(r.ID, map[string]any{"data": []map[string]any{
			{"id": "fake-model-1", "model": "fake-model-1", "displayName": "Default (fake)", "description": "fake default", "hidden": false},
			{"id": "fast", "model": "fast", "displayName": "Fast (fake)", "description": "fake fast", "hidden": false},
		}, "nextCursor": nil})
	case "turn/start":
		if r.Params.ThreadID != a.threadID {
			a.rpcError(r.ID, "invalid thread id")
			return 0, false
		}
		if r.Params.Model != "" || r.Params.ApprovalPolicy != "" {
			if r.Params.Model != "" {
				a.model = r.Params.Model
			}
			if r.Params.ApprovalPolicy != "" {
				a.approval = r.Params.ApprovalPolicy
			}
			a.notify("thread/settings/updated", map[string]any{"threadId": a.threadID, "threadSettings": map[string]any{"model": a.model, "approvalPolicy": a.approval}})
		}
		text := ""
		if len(r.Params.Input) > 0 {
			text = r.Params.Input[0].Text
		}
		return a.turn(r.ID, text)
	case "turn/interrupt":
		a.rpcError(r.ID, "no active turn to interrupt")
	default:
		a.rpcError(r.ID, "unknown method "+r.Method)
	}
	return 0, false
}

func (a *codexAgent) turn(id json.RawMessage, text string) (int, bool) {
	a.turnSeq++
	turnID := fmt.Sprintf("turn-%d", a.turnSeq)
	a.result(id, map[string]any{"turn": map[string]any{"id": turnID, "items": []any{}, "status": "inProgress"}})
	a.notify("thread/status/changed", map[string]any{"threadId": a.threadID, "status": map[string]any{"type": "active", "activeFlags": []any{}}})
	a.notify("turn/started", map[string]any{"threadId": a.threadID, "turn": map[string]any{"id": turnID, "items": []any{}, "status": "inProgress"}})
	uid := a.nextItem()
	a.item("item/started", uid, map[string]any{"type": "userMessage", "id": uid, "content": []map[string]any{{"type": "text", "text": text}}}, turnID)
	a.item("item/completed", uid, map[string]any{"type": "userMessage", "id": uid, "content": []map[string]any{{"type": "text", "text": text}}}, turnID)
	status := "completed"
	switch {
	case strings.Contains(text, "DIE"):
		return 1, true
	case strings.HasPrefix(text, "/"):
		a.message(turnID, "ok: "+text)
	case strings.Contains(text, "APPROVE"):
		if !a.approveTurn(turnID) {
			return 0, false
		}
	case strings.Contains(text, "QUESTION"):
		if !a.questionTurn(turnID) {
			return 0, false
		}
	case strings.Contains(text, "TOOLARG"):
		// M12_SRS V-M12-3: **인자가 도구 시작 프레임에 이미 있다** — claude 와 달리
		// 늦게 오지 않는다. 화면이 그것을 그리는지 재려면 이 턴이 있어야 한다.
		cid := a.nextItem()
		a.item("item/started", cid, map[string]any{"type": "commandExecution", "id": cid,
			"command": "seq 1 3", "cwd": mustCwd(), "status": "inProgress", "commandActions": []any{}}, turnID)
		a.item("item/completed", cid, map[string]any{"type": "commandExecution", "id": cid,
			"command": "seq 1 3", "status": "completed", "exitCode": 0, "aggregatedOutput": "1\n2\n3"}, turnID)
		a.message(turnID, "TOOLDONE")
	case strings.Contains(text, "EDITDIFF"):
		// V-M12-5: codex 는 **경로만** 준다 — 줄을 주지 않는다 (D-M11-4). 화면이
		// 머리만 그리고 몸을 세우지 않는지가 그 사실의 검사다.
		fid := a.nextItem()
		changes := []map[string]any{{"path": "/w/sample.txt", "kind": "update"}}
		a.item("item/started", fid, map[string]any{"type": "fileChange", "id": fid,
			"changes": changes, "status": "inProgress"}, turnID)
		a.item("item/completed", fid, map[string]any{"type": "fileChange", "id": fid,
			"changes": changes, "status": "completed"}, turnID)
		a.message(turnID, "EDITED")
	case strings.Contains(text, "SLOW"):
		if a.slow(turnID) {
			status = "interrupted"
		}
	default:
		a.message(turnID, "PONG")
	}
	a.notify("thread/tokenUsage/updated", map[string]any{"threadId": a.threadID, "turnId": turnID, "tokenUsage": map[string]any{
		"last":               map[string]any{"inputTokens": 1110, "cachedInputTokens": 1000, "outputTokens": 5, "reasoningOutputTokens": 0, "totalTokens": 1115},
		"total":              map[string]any{"inputTokens": 1110, "cachedInputTokens": 1000, "outputTokens": 5, "reasoningOutputTokens": 0, "totalTokens": 1115},
		"modelContextWindow": 200000}})
	a.notify("thread/status/changed", map[string]any{"threadId": a.threadID, "status": map[string]any{"type": "idle"}})
	a.notify("turn/completed", map[string]any{"threadId": a.threadID, "turn": map[string]any{"id": turnID, "items": []any{}, "status": status}})
	return 0, false
}

func (a *codexAgent) item(method, id string, item map[string]any, turnID string) {
	a.notify(method, map[string]any{"item": item, "threadId": a.threadID, "turnId": turnID, "startedAtMs": time.Now().UnixMilli()})
}

func (a *codexAgent) message(turnID, text string) {
	id := a.nextItem()
	a.item("item/started", id, map[string]any{"type": "agentMessage", "id": id, "text": ""}, turnID)
	a.notify("item/agentMessage/delta", map[string]any{"delta": text, "itemId": id, "threadId": a.threadID, "turnId": turnID})
	a.item("item/completed", id, map[string]any{"type": "agentMessage", "id": id, "text": text}, turnID)
}

// slow 는 델타를 천천히 낸다. 사이에 turn/interrupt 가 오면 true.
func (a *codexAgent) slow(turnID string) bool {
	id := a.nextItem()
	a.item("item/started", id, map[string]any{"type": "agentMessage", "id": id, "text": ""}, turnID)
	for i := 0; i < 50; i++ {
		select {
		case line, ok := <-a.lines:
			if !ok {
				return true
			}
			var r codexReq
			_ = json.Unmarshal(line, &r)
			if r.Method == "turn/interrupt" {
				a.result(r.ID, map[string]any{})
				return true
			}
		case <-time.After(100 * time.Millisecond):
		}
		a.notify("item/agentMessage/delta", map[string]any{"delta": fmt.Sprintf("tick%d ", i), "itemId": id, "threadId": a.threadID, "turnId": turnID})
	}
	a.item("item/completed", id, map[string]any{"type": "agentMessage", "id": id, "text": "slow done"}, turnID)
	return false
}

// awaitResult 는 서버 요청 id 의 응답을 기다린다. stdin 이 닫히면 false.
func (a *codexAgent) awaitResult(id string) (json.RawMessage, bool) {
	for line := range a.lines {
		var r codexReq
		if err := json.Unmarshal(line, &r); err != nil {
			continue
		}
		if r.Method == "" && string(r.ID) == `"`+id+`"` {
			return r.Result, true
		}
		if r.Method != "" {
			a.handle(line)
		}
	}
	return nil, false
}

func (a *codexAgent) approveTurn(turnID string) bool {
	cid := a.nextItem()
	a.item("item/started", cid, map[string]any{"type": "commandExecution", "id": cid, "command": "touch fake.txt", "cwd": mustCwd(), "status": "inProgress", "commandActions": []any{}}, turnID)
	reqID := newID("req")
	a.emit(map[string]any{"id": reqID, "method": "item/commandExecution/requestApproval", "params": map[string]any{
		"itemId": cid, "command": "touch fake.txt", "cwd": mustCwd(), "reason": nil, "proposedExecpolicyAmendment": []string{"touch", "*"},
		"threadId": a.threadID, "turnId": turnID, "startedAtMs": time.Now().UnixMilli()}})
	res, ok := a.awaitResult(reqID)
	if !ok {
		return false
	}
	a.notify("serverRequest/resolved", map[string]any{"requestId": reqID, "threadId": a.threadID})
	var d struct {
		Decision json.RawMessage `json:"decision"`
	}
	_ = json.Unmarshal(res, &d)
	if strings.Contains(string(d.Decision), "decline") || strings.Contains(string(d.Decision), "cancel") {
		a.item("item/completed", cid, map[string]any{"type": "commandExecution", "id": cid, "command": "touch fake.txt", "status": "declined", "exitCode": nil, "aggregatedOutput": ""}, turnID)
		a.message(turnID, "DENIED")
		return true
	}
	if strings.Contains(string(d.Decision), "acceptWithExecpolicyAmendment") {
		a.approval = "never"
		a.notify("thread/settings/updated", map[string]any{"threadId": a.threadID, "threadSettings": map[string]any{"model": a.model, "approvalPolicy": a.approval}})
	}
	a.item("item/completed", cid, map[string]any{"type": "commandExecution", "id": cid, "command": "touch fake.txt", "status": "completed", "exitCode": 0, "aggregatedOutput": ""}, turnID)
	a.message(turnID, "DONE")
	return true
}

func (a *codexAgent) questionTurn(turnID string) bool {
	iid := a.nextItem()
	reqID := newID("req")
	a.emit(map[string]any{"id": reqID, "method": "item/tool/requestUserInput", "params": map[string]any{
		"itemId": iid, "isBlocking": true, "threadId": a.threadID, "turnId": turnID,
		"questions": []map[string]any{{"id": "color", "header": "Color", "question": "Pick a color",
			"options": []map[string]any{{"label": "Red", "description": "The color red"}, {"label": "Blue", "description": "The color blue"}}}}}})
	res, ok := a.awaitResult(reqID)
	if !ok {
		return false
	}
	var d struct {
		Answers map[string]struct {
			Answers []string `json:"answers"`
		} `json:"answers"`
	}
	_ = json.Unmarshal(res, &d)
	picked := "?"
	if v, ok := d.Answers["color"]; ok && len(v.Answers) > 0 {
		picked = v.Answers[0]
	}
	a.message(turnID, picked)
	return true
}
