package agentadapter

import (
	"encoding/json"
	"strings"
	"testing"
)

// M8_UNIFIED_SRS §3.4.1 묶음 P — codex app-server 해석층 (FR-APS-2·3·5·8, V-1 의 "형태",
// P4). 프레임은 P4 실측(0.154.0, `/tmp/m8-spike/p4/codex-*.jsonl`)과 `generate-json-schema`
// 에서 **형태만** 옮겼다 — 내용은 PONG 류다 (NFR-C-1).

const codexTID = "01a09b1e-2423-7122-9330-d4e75fbfed36"

func codexProtoOf(t *testing.T) (*Proto, *ProtoState) {
	t.Helper()
	ad, err := Get("codex")
	if err != nil {
		t.Fatal(err)
	}
	if ad.Proto == nil {
		t.Fatal("codex 는 프로토콜 표면이 있어야 한다 (P4)")
	}
	return ad.Proto, NewProtoState()
}

// 핸드셰이크를 지나 thread 를 아는 상태로.
func codexReady(t *testing.T) (*Proto, *ProtoState) {
	t.Helper()
	p, st := codexProtoOf(t)
	p.Handshake(LaunchOpts{Cwd: "/w"}, st)
	decode1(t, p, st, `{"id":"dm-1","result":{"userAgent":"dongminal/0.154.0","codexHome":"/h","platformFamily":"unix","platformOs":"macos"}}`)
	decode1(t, p, st, `{"id":"dm-2","result":{"thread":{"id":"`+codexTID+`","sessionId":"`+codexTID+`","model":"gpt-5.4","status":{"type":"idle"},"cwd":"/w","turns":[]},"model":"gpt-5.4","modelProvider":"openai","cwd":"/w","approvalPolicy":"on-request","sandbox":{"type":"readOnly"}}}`)
	return p, st
}

// FR-APS-9: 기동은 `app-server` 하나다 — 모델·재개·cwd 는 핸드셰이크 요청에 실린다.
func TestCodexProto_LaunchAndHandshake(t *testing.T) {
	p, st := codexProtoOf(t)
	argv := p.Launch(LaunchOpts{Bin: "/opt/bin/agent", Cwd: "/w", Model: "gpt-x", Resume: codexTID})
	if strings.Join(argv, " ") != "/opt/bin/agent app-server" {
		t.Fatalf("argv: %v", argv)
	}
	hs := p.Handshake(LaunchOpts{Cwd: "/w", Model: "gpt-x", PermissionMode: "untrusted"}, st)
	if len(hs) != 4 {
		t.Fatalf("핸드셰이크는 initialize·initialized·thread/start·model/list 넷: %d", len(hs))
	}
	var init, start struct {
		ID     string         `json:"id"`
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	_ = json.Unmarshal(hs[0], &init)
	_ = json.Unmarshal(hs[2], &start)
	if init.Method != "initialize" || init.ID == "" || !strings.Contains(string(hs[1]), `"method":"initialized"`) {
		t.Fatalf("initialize/initialized: %s %s", hs[0], hs[1])
	}
	if start.Method != "thread/start" || start.Params["cwd"] != "/w" || start.Params["model"] != "gpt-x" || start.Params["approvalPolicy"] != "untrusted" {
		t.Fatalf("thread/start: %s", hs[2])
	}
	// 재개는 thread/resume{threadId}.
	st2 := NewProtoState()
	hs2 := p.Handshake(LaunchOpts{Resume: codexTID}, st2)
	if !strings.Contains(string(hs2[2]), `"method":"thread/resume"`) || !strings.Contains(string(hs2[2]), codexTID) {
		t.Fatalf("thread/resume: %s", hs2[2])
	}
	if !strings.Contains(string(hs[3]), `"method":"model/list"`) {
		t.Fatalf("model/list: %s", hs[3])
	}
}

// 세션 신원은 thread/start 응답에서, 모델 목록은 model/list 응답에서 (FR-APS-3 · FR-AGT-11).
func TestCodexProto_SessionAndModels(t *testing.T) {
	p, st := codexProtoOf(t)
	p.Handshake(LaunchOpts{}, st)
	if evs := decode1(t, p, st, `{"id":"dm-1","result":{"userAgent":"x"}}`); len(evs) != 0 {
		t.Fatalf("initialize 응답은 이벤트가 없다: %v", evs)
	}
	evs := decode1(t, p, st, `{"id":"dm-2","result":{"thread":{"id":"`+codexTID+`","model":"gpt-5.4","status":{"type":"idle"}},"model":"gpt-5.4","approvalPolicy":"on-request"}}`)
	if kinds(evs) != "session" || evs[0].SessionID != codexTID || evs[0].Status.Model != "gpt-5.4" || evs[0].Status.PermissionMode != "on-request" {
		t.Fatalf("session: %+v", evs)
	}
	if st.SessionID != codexTID {
		t.Fatalf("st.SessionID=%q", st.SessionID)
	}
	if a, _ := evs[0].Activity(); a != "idle" {
		t.Fatalf("session → idle, got %q", a)
	}
	evs = decode1(t, p, st, `{"id":"dm-3","result":{"data":[{"id":"gpt-6-astra","model":"gpt-6-astra","displayName":"GPT-6-Astra","description":"most capable","hidden":false},{"id":"old","model":"old","hidden":true}]}}`)
	if kinds(evs) != "status" || len(evs[0].Status.Models) != 1 || evs[0].Status.Models[0].Value != "gpt-6-astra" {
		t.Fatalf("models: %+v", evs)
	}
	// 대기표에 없는 응답은 모르는 프레임이다 (FR-APS-8).
	if _, ok := p.Decode([]byte(`{"id":"zzz","result":{}}`), st); ok {
		t.Fatal("모르는 id 의 응답을 안다고 했다")
	}
	// granular 승인 정책은 한 단어로.
	st3 := NewProtoState()
	p.Handshake(LaunchOpts{}, st3)
	evs = decode1(t, p, st3, `{"id":"dm-2","result":{"thread":{"id":"t"},"model":"m","approvalPolicy":{"granular":{"mcp_elicitations":true,"rules":true,"sandbox_approval":true}}}}`)
	if evs[0].Status.PermissionMode != "granular" {
		t.Fatalf("granular: %+v", evs[0].Status)
	}
}

// 턴: turn/start 응답 → turn/started → 델타·item → tokenUsage → turn/completed.
func TestCodexProto_Turn(t *testing.T) {
	p, st := codexReady(t)
	frames := p.Prompt("say PONG", nil, st)
	if len(frames) != 1 {
		t.Fatalf("prompt 는 프레임 하나: %d", len(frames))
	}
	var req struct {
		ID     string `json:"id"`
		Method string `json:"method"`
		Params struct {
			ThreadID string `json:"threadId"`
			Input    []struct {
				Type, Text string
			} `json:"input"`
		} `json:"params"`
	}
	_ = json.Unmarshal(frames[0], &req)
	if req.Method != "turn/start" || req.Params.ThreadID != codexTID || len(req.Params.Input) != 1 || req.Params.Input[0].Text != "say PONG" {
		t.Fatalf("turn/start: %s", frames[0])
	}
	decode1(t, p, st, `{"id":"`+req.ID+`","result":{"turn":{"id":"turn-1","items":[],"status":"inProgress"}}}`)
	evs := decode1(t, p, st, `{"method":"thread/status/changed","params":{"threadId":"`+codexTID+`","status":{"type":"active","activeFlags":[]}}}`)
	if len(evs) != 0 {
		t.Fatalf("status/changed 는 이벤트가 없다: %v", evs)
	}
	evs = decode1(t, p, st, `{"method":"turn/started","params":{"threadId":"`+codexTID+`","turn":{"id":"turn-1","items":[],"status":"inProgress"}}}`)
	if kinds(evs) != "turn_start" {
		t.Fatalf("turn_start: %v", kinds(evs))
	}
	evs = decode1(t, p, st, `{"method":"item/started","params":{"item":{"type":"userMessage","id":"u1","content":[{"type":"text","text":"say PONG"}]},"threadId":"`+codexTID+`","turnId":"turn-1"}}`)
	if len(evs) != 0 {
		t.Fatalf("userMessage 는 우리가 보낸 것: %v", evs)
	}
	evs = decode1(t, p, st, `{"method":"item/started","params":{"item":{"type":"agentMessage","id":"a1","text":""},"threadId":"`+codexTID+`","turnId":"turn-1"}}`)
	if len(evs) != 0 {
		t.Fatalf("agentMessage started: %v", evs)
	}
	evs = decode1(t, p, st, `{"method":"item/agentMessage/delta","params":{"delta":"PO","itemId":"a1","threadId":"`+codexTID+`","turnId":"turn-1"}}`)
	if kinds(evs) != "text_delta" || evs[0].Text != "PO" {
		t.Fatalf("delta: %+v", evs)
	}
	evs = decode1(t, p, st, `{"method":"item/reasoning/summaryTextDelta","params":{"delta":"hmm","itemId":"r1","summaryIndex":0,"threadId":"`+codexTID+`","turnId":"turn-1"}}`)
	if kinds(evs) != "thinking_delta" || evs[0].Text != "hmm" {
		t.Fatalf("thinking: %+v", evs)
	}
	evs = decode1(t, p, st, `{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"a1","text":"PONG"},"threadId":"`+codexTID+`","turnId":"turn-1"}}`)
	if kinds(evs) != "message" || !strings.Contains(string(evs[0].Message), `"text":"PONG"`) {
		t.Fatalf("message: %+v", evs)
	}
	evs = decode1(t, p, st, `{"method":"thread/tokenUsage/updated","params":{"threadId":"`+codexTID+`","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":1200,"cachedInputTokens":1000,"outputTokens":5,"reasoningOutputTokens":0,"totalTokens":1205},"total":{"inputTokens":1200,"cachedInputTokens":1000,"outputTokens":5,"reasoningOutputTokens":0,"totalTokens":1205},"modelContextWindow":272000}}}`)
	if kinds(evs) != "usage" || evs[0].Usage.Tokens != 1200 || evs[0].Usage.OutputTokens != 5 || evs[0].Usage.ContextWindow != 272000 {
		t.Fatalf("usage: %+v", evs[0].Usage)
	}
	evs = decode1(t, p, st, `{"method":"turn/completed","params":{"threadId":"`+codexTID+`","turn":{"id":"turn-1","items":[],"status":"completed"}}}`)
	if kinds(evs) != "turn_end" || evs[0].Outcome != OutcomeCompleted || evs[0].Text != "completed" {
		t.Fatalf("turn_end: %+v", evs)
	}
	if a, _ := evs[0].Activity(); a != "done" {
		t.Fatalf("turn_end → done, got %q", a)
	}
	// 실패한 턴 (실측: 401) — error 알림과 failed 상태.
	evs = decode1(t, p, st, `{"method":"error","params":{"error":{"message":"Your access token could not be refreshed.","codexErrorInfo":"unauthorized"},"willRetry":false,"threadId":"`+codexTID+`","turnId":"turn-2"}}`)
	if kinds(evs) != "error" || !strings.Contains(evs[0].Text, "access token") {
		t.Fatalf("error: %+v", evs)
	}
	evs = decode1(t, p, st, `{"method":"turn/completed","params":{"threadId":"`+codexTID+`","turn":{"id":"turn-2","items":[],"status":"failed","error":{"message":"boom"}}}}`)
	if kinds(evs) != "turn_end" || evs[0].Outcome != OutcomeError || evs[0].Text != "boom" {
		t.Fatalf("failed turn_end: %+v", evs)
	}
	// 중단(interrupted)은 오류가 아니다.
	evs = decode1(t, p, st, `{"method":"turn/completed","params":{"threadId":"`+codexTID+`","turn":{"id":"turn-3","items":[],"status":"interrupted"}}}`)
	if evs[0].Outcome != OutcomeStopped || evs[0].Text != "interrupted" {
		t.Fatalf("interrupted: %+v", evs)
	}
}

// 도구: commandExecution 의 시작·끝, 그리고 그 승인 요청 (FR-APS-5 · FR-AGT-5).
func TestCodexProto_CommandApproval(t *testing.T) {
	p, st := codexReady(t)
	evs := decode1(t, p, st, `{"method":"item/started","params":{"item":{"type":"commandExecution","id":"c1","command":"touch fake.txt","cwd":"/w","status":"inProgress","commandActions":[]},"threadId":"`+codexTID+`","turnId":"turn-1"}}`)
	if kinds(evs) != "tool_start" || evs[0].Tool != "commandExecution" || evs[0].ToolUseID != "c1" || evs[0].Detail != "touch fake.txt" {
		t.Fatalf("tool_start: %+v", evs)
	}
	// 승인 요청 — JSON-RPC id 는 숫자다. 그대로 되돌려야 한다.
	evs = decode1(t, p, st, `{"id":7,"method":"item/commandExecution/requestApproval","params":{"itemId":"c1","command":"touch fake.txt","cwd":"/w","reason":null,"proposedExecpolicyAmendment":["touch","*"],"threadId":"`+codexTID+`","turnId":"turn-1","startedAtMs":1}}`)
	if kinds(evs) != "approval_open" {
		t.Fatalf("approval_open: %v", kinds(evs))
	}
	ar := evs[0].Approval
	if ar.ID != "7" || ar.Kind != ApprovalPermission || ar.Tool != "commandExecution" || ar.Detail != "touch fake.txt" {
		t.Fatalf("request: %+v", ar)
	}
	if a, _ := evs[0].Activity(); a != "waiting" || evs[0].Detail != "touch fake.txt" {
		t.Fatalf("approval_open → waiting + detail: %+v", evs[0])
	}
	// allow · deny · acceptForSession · amendment · cancel = 다섯. 프로토콜 것 그대로.
	ids := make([]string, 0, len(ar.Options))
	for _, o := range ar.Options {
		ids = append(ids, o.ID)
	}
	if strings.Join(ids, ",") != "allow,deny,suggestion:0,suggestion:1,suggestion:2" {
		t.Fatalf("options: %v", ids)
	}
	if !strings.Contains(string(ar.Input), `"command":"touch fake.txt"`) {
		t.Fatalf("input: %s", ar.Input)
	}
	if len(st.Open) != 1 {
		t.Fatalf("열린 요청 %d", len(st.Open))
	}
	// 제안(amendment)을 고른다 — 응답 id 가 숫자 7 그대로다.
	frame, err := p.Approve(*ar, Decision{Choice: "suggestion:1"}, st)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(frame), `{"id":7,`) && !strings.Contains(string(frame), `"id":7,`) {
		t.Fatalf("id 가 숫자 그대로여야 한다: %s", frame)
	}
	if !strings.Contains(string(frame), `"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["touch","*"]}`) {
		t.Fatalf("decision: %s", frame)
	}
	if len(st.Open) != 0 {
		t.Fatal("답한 요청은 닫힌다")
	}
	if _, err := p.Approve(*ar, Decision{Choice: ChoiceAllow}, st); err != ErrNotOpen {
		t.Fatalf("두 번째 답은 ErrNotOpen: %v", err)
	}
	// 도구 결과.
	evs = decode1(t, p, st, `{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"c1","command":"touch fake.txt","cwd":"/w","status":"completed","exitCode":0,"aggregatedOutput":""},"threadId":"`+codexTID+`","turnId":"turn-1"}}`)
	if kinds(evs) != "tool_end" || evs[0].IsError || evs[0].ToolUseID != "c1" {
		t.Fatalf("tool_end: %+v", evs)
	}
	// 단순 허용·거절은 accept·decline 문자열이다.
	decode1(t, p, st, `{"id":8,"method":"item/commandExecution/requestApproval","params":{"itemId":"c2","command":"rm x","threadId":"`+codexTID+`","turnId":"turn-1","startedAtMs":1}}`)
	req := st.Open["8"]
	frame, _ = p.Approve(req, Decision{Choice: ChoiceDeny}, st)
	if !strings.Contains(string(frame), `"result":{"decision":"decline"}`) {
		t.Fatalf("decline: %s", frame)
	}
	if _, err := p.Approve(req, Decision{Choice: "nope"}, st); err != ErrNotOpen {
		t.Fatalf("닫힌 뒤: %v", err)
	}
}

// fileChange · permissions 승인, 그리고 서버가 스스로 닫은 요청 (serverRequest/resolved).
func TestCodexProto_FileChangeAndPermissions(t *testing.T) {
	p, st := codexReady(t)
	evs := decode1(t, p, st, `{"method":"item/started","params":{"item":{"type":"fileChange","id":"f1","status":"inProgress","changes":[{"path":"/w/a.txt","kind":{"type":"add"},"diff":"+hi"}]},"threadId":"`+codexTID+`","turnId":"t"}}`)
	if kinds(evs) != "tool_start" || evs[0].Detail != "/w/a.txt" {
		t.Fatalf("fileChange start: %+v", evs)
	}
	evs = decode1(t, p, st, `{"id":"r1","method":"item/fileChange/requestApproval","params":{"itemId":"f1","reason":null,"threadId":"`+codexTID+`","turnId":"t","startedAtMs":1}}`)
	ar := evs[0].Approval
	if ar.Tool != "fileChange" || ar.Detail != "/w/a.txt" || !strings.Contains(string(ar.Input), `"diff":"+hi"`) || len(ar.Options) != 4 {
		t.Fatalf("fileChange approval: %+v", ar)
	}
	frame, err := p.Approve(*ar, Decision{Choice: "suggestion:0"}, st)
	if err != nil || !strings.Contains(string(frame), `"decision":"acceptForSession"`) || !strings.Contains(string(frame), `"id":"r1"`) {
		t.Fatalf("acceptForSession: %s %v", frame, err)
	}
	// permissions — 답은 permissions+scope 다.
	evs = decode1(t, p, st, `{"id":"r2","method":"item/permissions/requestApproval","params":{"itemId":"p1","cwd":"/w","permissions":{"network":{"enabled":true}},"reason":"needs net","threadId":"`+codexTID+`","turnId":"t","startedAtMs":1}}`)
	ar = evs[0].Approval
	if ar.Tool != "permissions" || ar.Detail != "needs net" || len(ar.Options) != 3 {
		t.Fatalf("permissions: %+v", ar)
	}
	frame, _ = p.Approve(*ar, Decision{Choice: ChoiceAllow}, st)
	if !strings.Contains(string(frame), `"permissions":{"network":{"enabled":true}}`) || !strings.Contains(string(frame), `"scope":"turn"`) {
		t.Fatalf("permissions allow: %s", frame)
	}
	// 열린 요청이 서버 쪽에서 닫혔다 (턴 중단).
	decode1(t, p, st, `{"id":"r3","method":"item/commandExecution/requestApproval","params":{"itemId":"c9","command":"x","threadId":"`+codexTID+`","turnId":"t","startedAtMs":1}}`)
	evs = decode1(t, p, st, `{"method":"serverRequest/resolved","params":{"requestId":"r3","threadId":"`+codexTID+`"}}`)
	if kinds(evs) != "approval_closed" || evs[0].Approval.ID != "r3" || len(st.Open) != 0 {
		t.Fatalf("resolved: %+v open=%d", evs, len(st.Open))
	}
	if evs, _ := p.Decode([]byte(`{"method":"serverRequest/resolved","params":{"requestId":"r3","threadId":"x"}}`), st); len(evs) != 0 {
		t.Fatalf("이미 닫힌 요청의 resolved 는 조용하다: %v", evs)
	}
}

// 질문 (item/tool/requestUserInput) — 답은 질문 id 로 간다 (FR-AGT-4).
func TestCodexProto_Question(t *testing.T) {
	p, st := codexReady(t)
	evs := decode1(t, p, st, `{"id":"q1","method":"item/tool/requestUserInput","params":{"itemId":"i1","isBlocking":true,"questions":[{"id":"color","header":"Color","question":"Pick a color","options":[{"label":"Red","description":"the red"},{"label":"Blue","description":"the blue"}]},{"id":"name","header":"Name","question":"Your name"}],"threadId":"`+codexTID+`","turnId":"t"}}`)
	ar := evs[0].Approval
	if ar.Kind != ApprovalQuestion || len(ar.Questions) != 2 || ar.Questions[0].Options[1].Label != "Blue" || !ar.Questions[1].FreeText || ar.Detail != "Pick a color" {
		t.Fatalf("question: %+v", ar)
	}
	frame, err := p.Approve(*ar, Decision{Answers: map[string]string{"Pick a color": "Blue", "Your name": "dm"}}, st)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame), `"color":{"answers":["Blue"]}`) || !strings.Contains(string(frame), `"name":{"answers":["dm"]}`) {
		t.Fatalf("answers: %s", frame)
	}
	// 거절은 빈 답이다.
	decode1(t, p, st, `{"id":"q2","method":"item/tool/requestUserInput","params":{"itemId":"i2","isBlocking":true,"questions":[{"id":"a","header":"","question":"q?"}],"threadId":"`+codexTID+`","turnId":"t"}}`)
	frame, _ = p.Approve(st.Open["q2"], Decision{Choice: ChoiceDeny}, st)
	if !strings.Contains(string(frame), `"result":{"answers":{}}`) {
		t.Fatalf("deny: %s", frame)
	}
}

// 제어는 다음 turn/start 에 실린다 — 지금은 빈 프레임 (codex 가 빈 줄을 무시한다, P4 실측).
func TestCodexProto_ControlInterruptResume(t *testing.T) {
	p, st := codexReady(t)
	fr, err := p.Control(ControlOp{Kind: "set_model", Value: "gpt-6-astra"}, st)
	if err != nil || len(fr) != 0 {
		t.Fatalf("set_model: %q %v", fr, err)
	}
	fr, err = p.Control(ControlOp{Kind: "set_permission_mode", Value: "never"}, st)
	if err != nil || len(fr) != 0 {
		t.Fatalf("set_permission_mode: %q %v", fr, err)
	}
	if _, err := p.Control(ControlOp{Kind: "set_max_thinking_tokens", Value: "1"}, st); err != ErrUnsupported {
		t.Fatalf("없는 제어는 ErrUnsupported: %v", err)
	}
	frames := p.Prompt("next", nil, st)
	if !strings.Contains(string(frames[0]), `"model":"gpt-6-astra"`) || !strings.Contains(string(frames[0]), `"approvalPolicy":"never"`) {
		t.Fatalf("다음 turn/start 에 실린다: %s", frames[0])
	}
	frames = p.Prompt("after", nil, st)
	if strings.Contains(string(frames[0]), `"model"`) {
		t.Fatalf("한 번 실은 재정의는 지운다 (codex 가 이후 턴에도 적용한다): %s", frames[0])
	}
	// 반영은 thread/settings/updated 가 알린다.
	evs := decode1(t, p, st, `{"method":"thread/settings/updated","params":{"threadId":"`+codexTID+`","threadSettings":{"model":"gpt-6-astra","approvalPolicy":"never","cwd":"/w"}}}`)
	if kinds(evs) != "status" || evs[0].Status.Model != "gpt-6-astra" || evs[0].Status.PermissionMode != "never" {
		t.Fatalf("settings: %+v", evs)
	}
	// 인터럽트는 threadId·turnId 를 싣는다. 없는 턴이면 codex 가 오류로 답한다 (실측).
	decode1(t, p, st, `{"method":"turn/started","params":{"threadId":"`+codexTID+`","turn":{"id":"turn-9","items":[],"status":"inProgress"}}}`)
	in := p.Interrupt(st)
	if !strings.Contains(string(in), `"method":"turn/interrupt"`) || !strings.Contains(string(in), `"turnId":"turn-9"`) {
		t.Fatalf("interrupt: %s", in)
	}
	var req struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(in, &req)
	evs = decode1(t, p, st, `{"error":{"code":-32600,"message":"no active turn to interrupt"},"id":"`+req.ID+`"}`)
	if kinds(evs) != "error" || !strings.Contains(evs[0].Text, "turn/interrupt: no active turn") {
		t.Fatalf("error response: %+v", evs)
	}
	// 압축 · TUI 출구.
	evs = decode1(t, p, st, `{"method":"thread/compacted","params":{"threadId":"`+codexTID+`","turnId":"t"}}`)
	if kinds(evs) != "status" || !evs[0].Status.Compacted {
		t.Fatalf("compacted: %+v", evs)
	}
	if got := strings.Join(p.TUIResume(codexTID), " "); got != "codex resume "+codexTID {
		t.Fatalf("tui: %s", got)
	}
}

// FR-APS-8: 모르는 것과 아는 것의 경계 — 알림은 스키마가 아는 형태라 조용히 지나고, 모르는
// 서버 요청·대기표 없는 응답·JSON 아닌 줄은 모르는 프레임이다.
func TestCodexProto_Unknown(t *testing.T) {
	p, st := codexReady(t)
	for _, line := range []string{
		`{"method":"mcpServer/startupStatus/updated","params":{"threadId":"x","name":"codegraph","status":"failed","error":"nope"}}`,
		`{"method":"remoteControl/status/changed","params":{"status":"disabled"}}`,
		`{"method":"deprecationNotice","params":{"summary":"…"}}`,
		`{"method":"item/started","params":{"item":{"type":"contextCompaction","id":"cc"},"threadId":"x","turnId":"t"}}`,
	} {
		if evs, ok := p.Decode([]byte(line), st); !ok || len(evs) != 0 {
			t.Fatalf("아는 알림·이벤트 없음이어야 한다: %s → %v %v", line, evs, ok)
		}
	}
	for _, line := range []string{
		`{"id":"s1","method":"mcpServer/elicitation/request","params":{}}`,
		`{"id":"s2","method":"execCommandApproval","params":{}}`,
		`{"id":"zzz","result":{}}`,
		`not json`,
		`{"jsonrpc":"2.0"}`,
	} {
		if _, ok := p.Decode([]byte(line), st); ok {
			t.Fatalf("모르는 프레임을 안다고 했다: %s", line)
		}
	}
}

// P5 D-C-14 (실측): 살아 있는 프로세스에 핸드셰이크를 다시 보내면 `initialize` 만 "Already
// initialized" 로 거절된다 — 그 한 오류는 부재다. 다른 오류는 그대로 EvError 다.
func TestCodexProto_ReinitializeIsQuiet(t *testing.T) {
	p, st := codexProtoOf(t)
	p.Handshake(LaunchOpts{Cwd: "/w", Resume: codexTID}, st)
	if evs := decode1(t, p, st, `{"error":{"code":-32600,"message":"Already initialized"},"id":"dm-1"}`); len(evs) != 0 {
		t.Fatalf("재 initialize 의 거절은 이벤트가 아니다: %+v", evs)
	}
	evs := decode1(t, p, st, `{"error":{"code":-32600,"message":"no rollout found for thread id x"},"id":"dm-2"}`)
	if kinds(evs) != "error" || !strings.Contains(evs[0].Text, "thread/resume") {
		t.Fatalf("다른 오류는 그대로: %+v", evs)
	}
}

// V-M12-30 (FR-M12-23): codex 의 `turn.status` 셋이 공통 어휘로 갈린다.
// **`failed` 의 Text 는 오류 문장이므로** 종류는 상태에서 나와야 한다 — 문장을 비교하면
// 메시지가 바뀔 때마다 갈래가 틀린다.
func TestCodexProto_TurnOutcome(t *testing.T) {
	p, st := codexReady(t)
	evs := decode1(t, p, st, `{"method":"turn/completed","params":{"threadId":"`+codexTID+`","turn":{"id":"t1","items":[],"status":"completed"}}}`)
	if evs[0].Outcome != OutcomeCompleted {
		t.Errorf("completed → %q", evs[0].Outcome)
	}
	evs = decode1(t, p, st, `{"method":"turn/completed","params":{"threadId":"`+codexTID+`","turn":{"id":"t2","items":[],"status":"interrupted"}}}`)
	if evs[0].Outcome != OutcomeStopped {
		t.Errorf("interrupted → %q, 기대 stopped", evs[0].Outcome)
	}
	evs = decode1(t, p, st, `{"method":"turn/completed","params":{"threadId":"`+codexTID+`","turn":{"id":"t3","items":[],"status":"failed","error":{"message":"boom"}}}}`)
	if evs[0].Outcome != OutcomeError || evs[0].Text != "boom" {
		t.Errorf("failed → %q/%q", evs[0].Outcome, evs[0].Text)
	}
}
