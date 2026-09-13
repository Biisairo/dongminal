package agentadapter

import (
	"encoding/json"
	"strings"
	"testing"
)

// M8_UNIFIED_SRS §3.4.1 묶음 P — claude stream-json 해석층 (FR-APS-2·3·5·8·10,
// V-1 의 "형태"). 프레임은 §2.3.4 실측(2.1.270)에서 **형태만** 옮겼다 — 내용은
// PONG 류다 (NFR-C-1).

const claudeSID = "05d6d228-8b91-4e5d-9973-284a5cef6763"

func protoOf(t *testing.T) (*Proto, *ProtoState) {
	t.Helper()
	ad, err := Get(claudeID)
	if err != nil {
		t.Fatal(err)
	}
	if ad.Proto == nil {
		t.Fatal("claude 는 프로토콜 표면이 있어야 한다 (FR-APS-9)")
	}
	return ad.Proto, NewProtoState()
}

func decode1(t *testing.T, p *Proto, st *ProtoState, line string) []Event {
	t.Helper()
	evs, ok := p.Decode([]byte(line), st)
	if !ok {
		t.Fatalf("아는 프레임을 모른다고 했다: %s", line)
	}
	return evs
}

func kinds(evs []Event) string {
	var out []string
	for _, e := range evs {
		out = append(out, string(e.Kind))
	}
	return strings.Join(out, ",")
}

// FR-APS-9·10: 기동 argv 는 stream-json 양방향 + 숨은 승인 플래그를 싣는다.
func TestClaudeProto_Launch(t *testing.T) {
	p, _ := protoOf(t)
	argv := p.Launch(LaunchOpts{Bin: "/opt/bin/agent", Cwd: "/w", Model: "haiku", Resume: "sid-1", PermissionMode: "plan"})
	got := strings.Join(argv, " ")
	for _, want := range []string{"/opt/bin/agent", "--output-format stream-json", "--input-format stream-json",
		"--include-partial-messages", "--verbose", "--permission-prompt-tool stdio", "--model haiku", "--resume sid-1", "--permission-mode plan"} {
		if !strings.Contains(got, want) {
			t.Errorf("argv 에 %q 가 없다: %s", want, got)
		}
	}
	if argv[0] != "/opt/bin/agent" {
		t.Errorf("argv[0] 은 Bin 이어야 한다: %v", argv)
	}
	// 프롬프트를 싣지 않는다 — 입력은 Prompt 가 프레임으로 만든다.
	for _, a := range argv {
		if strings.Contains(a, "PONG") {
			t.Errorf("argv 에 프롬프트가 실렸다: %v", argv)
		}
	}
	plain := strings.Join(p.Launch(LaunchOpts{Bin: "x"}), " ")
	if strings.Contains(plain, "--resume") || strings.Contains(plain, "--model") || strings.Contains(plain, "--permission-mode") {
		t.Errorf("비어 있는 선택지가 argv 에 나갔다: %s", plain)
	}
}

// FR-APS-3: 세션 신원 — system:init.
func TestClaudeProto_Init(t *testing.T) {
	p, st := protoOf(t)
	evs := decode1(t, p, st, `{"type":"system","subtype":"init","cwd":"/w","session_id":"`+claudeSID+`","tools":["Bash"],"mcp_servers":[],"model":"claude-x","permissionMode":"default","slash_commands":["compact"],"uuid":"u1"}`)
	if kinds(evs) != "session" {
		t.Fatalf("kinds=%s", kinds(evs))
	}
	e := evs[0]
	if e.SessionID != claudeSID || st.SessionID != claudeSID {
		t.Fatalf("세션 신원이 실리지 않았다: %+v st=%s", e, st.SessionID)
	}
	if e.Status == nil || e.Status.Model != "claude-x" || e.Status.PermissionMode != "default" {
		t.Fatalf("init 의 모델·권한 모드가 실리지 않았다: %+v", e.Status)
	}
	if state, ok := e.Activity(); !ok || state != "idle" {
		t.Fatalf("session → idle 이어야 한다: %q %v", state, ok)
	}
}

// FR-APS-3: 턴 경계 · 텍스트/추론 델타 · 메시지 스냅샷 · 사용량.
func TestClaudeProto_Turn(t *testing.T) {
	p, st := protoOf(t)
	sid := `"session_id":"` + claudeSID + `","parent_tool_use_id":null,"uuid":"u"`
	// 첫 요청: status requesting → turn_start 한 번.
	evs := decode1(t, p, st, `{"type":"system","subtype":"status","status":"requesting",`+sid+`}`)
	if kinds(evs) != "turn_start" {
		t.Fatalf("첫 requesting 은 turn_start 다: %s", kinds(evs))
	}
	// 같은 턴의 둘째 requesting 은 조용하다.
	if evs := decode1(t, p, st, `{"type":"system","subtype":"status","status":"requesting",`+sid+`}`); len(evs) != 0 {
		t.Fatalf("같은 턴의 requesting 이 다시 turn_start 를 냈다: %s", kinds(evs))
	}
	evs = decode1(t, p, st, `{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-x","id":"m1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000,"output_tokens":1}}},`+sid+`,"ttft_ms":9}`)
	if kinds(evs) != "usage" || evs[0].Usage.Tokens != 1110 || evs[0].Usage.Model != "claude-x" {
		t.Fatalf("message_start 의 사용량: %s %+v", kinds(evs), evs[0].Usage)
	}
	if evs := decode1(t, p, st, `{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}},`+sid+`}`); len(evs) != 0 {
		t.Fatalf("thinking 블록 시작은 이벤트가 아니다: %s", kinds(evs))
	}
	evs = decode1(t, p, st, `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}},`+sid+`}`)
	if kinds(evs) != "thinking_delta" || evs[0].Text != "hm" {
		t.Fatalf("thinking_delta: %s %+v", kinds(evs), evs)
	}
	if evs := decode1(t, p, st, `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"E"}},`+sid+`}`); len(evs) != 0 {
		t.Fatalf("signature_delta 는 이벤트가 아니다")
	}
	evs = decode1(t, p, st, `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"PONG"}},`+sid+`}`)
	if kinds(evs) != "text_delta" || evs[0].Text != "PONG" {
		t.Fatalf("text_delta: %s %+v", kinds(evs), evs)
	}
	evs = decode1(t, p, st, `{"type":"assistant","message":{"model":"claude-x","id":"m1","type":"message","role":"assistant","content":[{"type":"text","text":"PONG"}],"usage":{"input_tokens":10}},"parent_tool_use_id":null,"session_id":"`+claudeSID+`","uuid":"u","timestamp":"t"}`)
	if kinds(evs) != "message" || !strings.Contains(string(evs[0].Message), `"PONG"`) {
		t.Fatalf("assistant 스냅샷: %s %s", kinds(evs), evs[0].Message)
	}
	for _, quiet := range []string{
		`{"type":"stream_event","event":{"type":"content_block_stop","index":1},` + sid + `}`,
		`{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}},` + sid + `}`,
		`{"type":"stream_event","event":{"type":"message_stop"},` + sid + `}`,
		`{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"session_id":"` + claudeSID + `","uuid":"u"}`,
		`{"type":"system","subtype":"hook_started","hook_id":"h","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"u","session_id":"` + claudeSID + `"}`,
		`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"},"uuid":"u","session_id":"` + claudeSID + `"}`,
	} {
		if evs := decode1(t, p, st, quiet); len(evs) != 0 {
			t.Fatalf("이벤트가 없어야 하는 프레임이 냈다: %s ← %s", kinds(evs), quiet)
		}
	}
	evs = decode1(t, p, st, `{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"num_turns":1,"result":"PONG","session_id":"`+claudeSID+`","total_cost_usd":0.04,"usage":{"input_tokens":18,"cache_creation_input_tokens":19063,"cache_read_input_tokens":18486,"output_tokens":258},"modelUsage":{"claude-x":{"inputTokens":927,"outputTokens":278,"costUSD":0.04,"contextWindow":200000}},"permission_denials":[],"stop_reason":"end_turn","terminal_reason":"completed","uuid":"u"}`)
	if kinds(evs) != "usage,turn_end" {
		t.Fatalf("result: %s", kinds(evs))
	}
	u := evs[0].Usage
	if u.Tokens != 18+19063+18486 || u.ContextWindow != 200000 || u.CostUSD != 0.04 || u.Model != "claude-x" || u.OutputTokens != 258 {
		t.Fatalf("result 의 사용량: %+v", u)
	}
	if evs[1].IsError || evs[1].Text != "completed" {
		t.Fatalf("turn_end 의 종료 사유: %+v", evs[1])
	}
	if state, _ := evs[1].Activity(); state != "done" {
		t.Fatalf("turn_end → done")
	}
	// 다음 턴의 requesting 은 다시 turn_start 다.
	if evs := decode1(t, p, st, `{"type":"system","subtype":"status","status":"requesting",`+sid+`}`); kinds(evs) != "turn_start" {
		t.Fatalf("새 턴의 requesting: %s", kinds(evs))
	}
}

// FR-APS-3: 도구 호출과 결과.
func TestClaudeProto_Tool(t *testing.T) {
	p, st := protoOf(t)
	sid := `"session_id":"` + claudeSID + `","parent_tool_use_id":null,"uuid":"u"`
	evs := decode1(t, p, st, `{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}},`+sid+`}`)
	if kinds(evs) != "tool_start" || evs[0].Tool != "Bash" || evs[0].ToolUseID != "toolu_1" {
		t.Fatalf("tool_start: %s %+v", kinds(evs), evs)
	}
	if evs := decode1(t, p, st, `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"co"}},`+sid+`}`); len(evs) != 0 {
		t.Fatalf("input_json_delta 는 이벤트가 아니다")
	}
	evs = decode1(t, p, st, `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"(Bash completed with no output)","is_error":false}]},"parent_tool_use_id":null,"session_id":"`+claudeSID+`","uuid":"u","timestamp":"t","tool_use_result":{"stdout":"","stderr":""}}`)
	if kinds(evs) != "tool_end" || evs[0].ToolUseID != "toolu_1" || !strings.Contains(evs[0].Text, "no output") || evs[0].IsError {
		t.Fatalf("tool_end: %s %+v", kinds(evs), evs)
	}
	// 배열 content 도 읽는다.
	evs = decode1(t, p, st, `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_2","type":"tool_result","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}],"is_error":true}]},"parent_tool_use_id":null,"session_id":"`+claudeSID+`","uuid":"u"}`)
	if kinds(evs) != "tool_end" || evs[0].Text != "a\nb" || !evs[0].IsError {
		t.Fatalf("tool_end 배열 content: %+v", evs)
	}
	// 로컬 명령의 출력은 사용자 쪽 텍스트다.
	evs = decode1(t, p, st, `{"type":"user","message":{"role":"user","content":"<local-command-stdout>ok</local-command-stdout>"},"session_id":"`+claudeSID+`","uuid":"u"}`)
	if kinds(evs) != "user" || evs[0].Text == "" {
		t.Fatalf("user 문자열 content: %s %+v", kinds(evs), evs)
	}
}

// FR-APS-5·10 · FR-AGT-5: 승인 요청-응답. 선택지는 프로토콜의 제안 그대로다.
func TestClaudeProto_Approval(t *testing.T) {
	p, st := protoOf(t)
	line := `{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"touch /w/x","description":"Create x"},"description":"Create x","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch /w/x"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["/w"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"blocked_path":"/w/x","tool_use_id":"toolu_1"}}`
	evs := decode1(t, p, st, line)
	if kinds(evs) != "approval_open" {
		t.Fatalf("approval_open: %s", kinds(evs))
	}
	req := evs[0].Approval
	if req == nil || req.ID != "req-1" || req.Kind != ApprovalPermission || req.Tool != "Bash" || req.Detail != "touch /w/x" || req.ToolUseID != "toolu_1" {
		t.Fatalf("요청의 모양: %+v", req)
	}
	if state, _ := evs[0].Activity(); state != "waiting" {
		t.Fatalf("approval_open → waiting")
	}
	if _, open := st.Open["req-1"]; !open {
		t.Fatal("열린 요청이 상태에 남아야 한다 (FR-APS-5)")
	}
	// allow · deny · 제안 셋 = 다섯. 우리가 접거나 늘리지 않는다.
	ids := make([]string, 0, len(req.Options))
	for _, o := range req.Options {
		ids = append(ids, o.ID)
	}
	if strings.Join(ids, ",") != "allow,deny,suggestion:0,suggestion:1,suggestion:2" {
		t.Fatalf("선택지: %v", ids)
	}
	if req.Options[4].Label == "" || !strings.Contains(req.Options[4].Label, "acceptEdits") {
		t.Fatalf("제안의 라벨은 그 내용을 말해야 한다: %+v", req.Options[4])
	}

	// 제안 하나를 고르면 allow + updatedPermissions[그 항목 그대로].
	frame, err := p.Approve(*req, Decision{Choice: "suggestion:2"}, st)
	if err != nil {
		t.Fatal(err)
	}
	var resp struct {
		Type     string `json:"type"`
		Response struct {
			Subtype   string `json:"subtype"`
			RequestID string `json:"request_id"`
			Response  struct {
				Behavior           string            `json:"behavior"`
				UpdatedInput       json.RawMessage   `json:"updatedInput"`
				UpdatedPermissions []json.RawMessage `json:"updatedPermissions"`
				Message            string            `json:"message"`
			} `json:"response"`
		} `json:"response"`
	}
	if err := json.Unmarshal(frame, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Type != "control_response" || resp.Response.Subtype != "success" || resp.Response.RequestID != "req-1" || resp.Response.Response.Behavior != "allow" {
		t.Fatalf("응답 봉투: %s", frame)
	}
	if !strings.Contains(string(resp.Response.Response.UpdatedInput), `"touch /w/x"`) {
		t.Fatalf("updatedInput 은 입력 그대로다: %s", frame)
	}
	if len(resp.Response.Response.UpdatedPermissions) != 1 || !strings.Contains(string(resp.Response.Response.UpdatedPermissions[0]), `"setMode"`) {
		t.Fatalf("updatedPermissions 는 고른 제안 하나 그대로다: %s", frame)
	}
	if _, open := st.Open["req-1"]; open {
		t.Fatal("답한 요청은 닫혀야 한다")
	}
	// 닫힌 요청에 다시 답하면 ErrNotOpen.
	if _, err := p.Approve(*req, Decision{Choice: ChoiceAllow}, st); err == nil {
		t.Fatal("닫힌 요청에 답이 나갔다")
	}

	// deny.
	decode1(t, p, st, strings.Replace(line, "req-1", "req-2", 1))
	frame, err = p.Approve(st.Open["req-2"], Decision{Choice: ChoiceDeny}, st)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame), `"behavior":"deny"`) || !strings.Contains(string(frame), `"request_id":"req-2"`) {
		t.Fatalf("deny: %s", frame)
	}
	// 모르는 선택지는 오류다 — 프로토콜이 준 것만.
	decode1(t, p, st, strings.Replace(line, "req-1", "req-3", 1))
	if _, err := p.Approve(st.Open["req-3"], Decision{Choice: "maybe"}, st); err == nil {
		t.Fatal("모르는 선택지가 통과했다")
	}
}

// FR-AGT-4 질문 답변: AskUserQuestion 은 같은 통로로 오고 답은 updatedInput.answers 다.
func TestClaudeProto_Question(t *testing.T) {
	p, st := protoOf(t)
	evs := decode1(t, p, st, `{"type":"control_request","request_id":"q-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Pick a color","header":"Color","options":[{"label":"Red","description":"r"},{"label":"Blue","description":"b"}],"multiSelect":false}]},"tool_use_id":"toolu_q","requires_user_interaction":true}}`)
	if kinds(evs) != "approval_open" {
		t.Fatalf("%s", kinds(evs))
	}
	req := evs[0].Approval
	if req.Kind != ApprovalQuestion || len(req.Questions) != 1 || req.Questions[0].Question != "Pick a color" || len(req.Questions[0].Options) != 2 || req.Questions[0].Options[1].Label != "Blue" {
		t.Fatalf("질문의 모양: %+v", req)
	}
	frame, err := p.Approve(*req, Decision{Answers: map[string]string{"Pick a color": "Blue"}}, st)
	if err != nil {
		t.Fatal(err)
	}
	s := string(frame)
	if !strings.Contains(s, `"behavior":"allow"`) || !strings.Contains(s, `"answers":{"Pick a color":"Blue"}`) || !strings.Contains(s, `"questions":[`) {
		t.Fatalf("질문의 답: %s", s)
	}
}

// FR-AGT-11: 핸드셰이크(initialize)와 제어. 응답은 대기표로 짝짓는다.
func TestClaudeProto_HandshakeAndControl(t *testing.T) {
	p, st := protoOf(t)
	hs := p.Handshake(LaunchOpts{}, st)
	if len(hs) != 1 || !strings.Contains(string(hs[0]), `"subtype":"initialize"`) {
		t.Fatalf("handshake: %q", hs)
	}
	var req struct {
		RequestID string `json:"request_id"`
	}
	json.Unmarshal(hs[0], &req)
	if req.RequestID == "" {
		t.Fatal("request_id 가 없다")
	}
	evs := decode1(t, p, st, `{"type":"control_response","response":{"subtype":"success","request_id":"`+req.RequestID+`","response":{"commands":[{"name":"compact","description":"d"}],"models":[{"value":"default","displayName":"Default","description":"D"},{"value":"sonnet","displayName":"Sonnet","description":"S"}],"account":{"email":"e@x","subscriptionType":"Max"},"current_permission_mode":"default","session_state":"idle"}}}`)
	if kinds(evs) != "status" {
		t.Fatalf("initialize 응답: %s", kinds(evs))
	}
	stt := evs[0].Status
	if len(stt.Models) != 2 || stt.Models[1].Value != "sonnet" || len(stt.Commands) != 1 || stt.Commands[0] != "compact" || stt.PermissionMode != "default" || stt.Account == "" {
		t.Fatalf("status: %+v", stt)
	}
	// 모르는 request_id 의 응답은 모르는 프레임이다 (FR-APS-8).
	if _, ok := p.Decode([]byte(`{"type":"control_response","response":{"subtype":"success","request_id":"nope","response":{}}}`), st); ok {
		t.Fatal("모르는 대기표를 아는 척했다")
	}

	frame, err := p.Control(ControlOp{Kind: "set_model", Value: "sonnet"}, st)
	if err != nil || !strings.Contains(string(frame), `"subtype":"set_model"`) || !strings.Contains(string(frame), `"model":"sonnet"`) {
		t.Fatalf("set_model: %s %v", frame, err)
	}
	json.Unmarshal(frame, &req)
	evs = decode1(t, p, st, `{"type":"control_response","response":{"subtype":"success","request_id":"`+req.RequestID+`","response":{}}}`)
	if kinds(evs) != "status" || evs[0].Status.Model != "sonnet" {
		t.Fatalf("set_model 성공은 모델 status 다: %s %+v", kinds(evs), evs)
	}
	frame, err = p.Control(ControlOp{Kind: "set_permission_mode", Value: "plan"}, st)
	if err != nil || !strings.Contains(string(frame), `"mode":"plan"`) {
		t.Fatalf("set_permission_mode: %s %v", frame, err)
	}
	json.Unmarshal(frame, &req)
	evs = decode1(t, p, st, `{"type":"control_response","response":{"subtype":"success","request_id":"`+req.RequestID+`","response":{"mode":"plan"}}}`)
	if kinds(evs) != "status" || evs[0].Status.PermissionMode != "plan" {
		t.Fatalf("set_permission_mode 성공: %+v", evs)
	}
	frame, err = p.Control(ControlOp{Kind: "set_max_thinking_tokens", Value: "1024"}, st)
	if err != nil || !strings.Contains(string(frame), `"max_thinking_tokens":1024`) {
		t.Fatalf("set_max_thinking_tokens: %s %v", frame, err)
	}
	if _, err := p.Control(ControlOp{Kind: "set_max_thinking_tokens", Value: "abc"}, st); err == nil {
		t.Fatal("숫자가 아닌 사고 예산이 통과했다")
	}
	if _, err := p.Control(ControlOp{Kind: "login"}, st); err != ErrUnsupported {
		t.Fatalf("없는 제어는 ErrUnsupported 다: %v", err)
	}
	// 오류 응답은 error 이벤트다.
	frame, _ = p.Control(ControlOp{Kind: "set_model", Value: "x"}, st)
	json.Unmarshal(frame, &req)
	evs = decode1(t, p, st, `{"type":"control_response","response":{"subtype":"error","request_id":"`+req.RequestID+`","error":"no such model"}}`)
	if kinds(evs) != "error" || !strings.Contains(evs[0].Text, "no such model") {
		t.Fatalf("제어 오류: %s %+v", kinds(evs), evs)
	}
	if !strings.Contains(string(p.Interrupt(st)), `"subtype":"interrupt"`) {
		t.Fatal("interrupt")
	}
}

// 세션 중 상태: 권한 모드 · 압축 · 신원 교체 · 자동 거부.
func TestClaudeProto_StatusResetDenied(t *testing.T) {
	p, st := protoOf(t)
	evs := decode1(t, p, st, `{"type":"system","subtype":"status","status":null,"permissionMode":"plan","uuid":"u","session_id":"`+claudeSID+`"}`)
	if kinds(evs) != "status" || evs[0].Status.PermissionMode != "plan" {
		t.Fatalf("permissionMode status: %+v", evs)
	}
	if evs := decode1(t, p, st, `{"type":"system","subtype":"status","status":"compacting","session_id":"`+claudeSID+`","uuid":"u"}`); len(evs) != 0 {
		t.Fatalf("compacting 은 이벤트가 아니다")
	}
	evs = decode1(t, p, st, `{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"`+claudeSID+`","uuid":"u"}`)
	if kinds(evs) != "status" || !evs[0].Status.Compacted {
		t.Fatalf("compact_result: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"system","subtype":"compact_boundary","session_id":"`+claudeSID+`","uuid":"u","compact_metadata":{"trigger":"manual","pre_tokens":27671,"post_tokens":4224}}`)
	if kinds(evs) != "status" || !evs[0].Status.Compacted {
		t.Fatalf("compact_boundary: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"conversation_reset","new_conversation_id":"new-sid","uuid":"u","session_id":"`+claudeSID+`"}`)
	if kinds(evs) != "reset" || evs[0].SessionID != "new-sid" || st.SessionID != "new-sid" {
		t.Fatalf("reset 은 신원을 바꾼다: %+v st=%s", evs, st.SessionID)
	}
	evs = decode1(t, p, st, `{"type":"system","subtype":"permission_denied","tool_name":"Bash","session_id":"new-sid","uuid":"u"}`)
	if kinds(evs) != "error" || evs[0].Tool != "Bash" {
		t.Fatalf("permission_denied: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"new-sid","total_cost_usd":0.001,"usage":{"input_tokens":0},"modelUsage":{},"terminal_reason":"aborted_streaming","uuid":"u"}`)
	if kinds(evs) != "usage,turn_end" || !evs[1].IsError || evs[1].Text != "aborted_streaming" {
		t.Fatalf("오류 result: %s %+v", kinds(evs), evs)
	}
}

// FR-APS-8: 모르는 프레임은 ok=false 다 — 조용히 삼키지 않는다.
func TestClaudeProto_Unknown(t *testing.T) {
	p, st := protoOf(t)
	for _, line := range []string{
		`{"type":"telemetry_blob","x":1}`,
		`{"type":"system","subtype":"never_seen"}`,
		`not json`,
		``,
	} {
		if _, ok := p.Decode([]byte(line), st); ok {
			t.Fatalf("모르는 프레임을 아는 척했다: %q", line)
		}
	}
}

// 프롬프트 프레임 · TUI 출구 argv.
func TestClaudeProto_PromptAndResume(t *testing.T) {
	p, st := protoOf(t)
	frames := p.Prompt("say PONG", st)
	if len(frames) != 1 {
		t.Fatalf("frames=%d", len(frames))
	}
	var fr struct {
		Type    string `json:"type"`
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(frames[0], &fr); err != nil || fr.Type != "user" || fr.Message.Role != "user" || fr.Message.Content != "say PONG" {
		t.Fatalf("prompt frame: %s %v", frames[0], err)
	}
	argv := p.TUIResume("sid-9")
	if strings.Join(argv, " ") != "claude --resume sid-9" {
		t.Fatalf("TUIResume: %v", argv)
	}
	if p.Cancel != nil {
		t.Fatal("claude 에는 Cancel 이 없다 — 없는 것을 선언하지 않는다 (D-U-6)")
	}
}
