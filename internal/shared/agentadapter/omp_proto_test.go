package agentadapter

import (
	"encoding/json"
	"strings"
	"testing"
)

// M8_UNIFIED_SRS §3.4.1 묶음 P — omp rpc-ui 해석층 (FR-APS-2·3·5·8, V-1 의 "형태", P4).
// 프레임은 P4 실측(17.4.0, `/tmp/m8-spike/p4/omp-*.jsonl`)과 소스(`rpc-types.ts`·
// `wrapper.ts`·`pi-ai/types.ts`)에서 **형태만** 옮겼다 — 내용은 PONG 류다 (NFR-C-1).
// 승인 `select` 와 도구 실행은 자격증명이 없어 라이브로 못 봤다 — 소스의 모양이다.

const ompSID = "01a09b1e-c536-7000-bace-1f2b42353904"

func ompProtoOf(t *testing.T) (*Proto, *ProtoState) {
	t.Helper()
	ad, err := Get("omp")
	if err != nil {
		t.Fatal(err)
	}
	if ad.Proto == nil {
		t.Fatal("omp 는 프로토콜 표면이 있어야 한다 (P4)")
	}
	return ad.Proto, NewProtoState()
}

func ompReady(t *testing.T) (*Proto, *ProtoState) {
	t.Helper()
	p, st := ompProtoOf(t)
	p.Handshake(LaunchOpts{}, st)
	decode1(t, p, st, `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576}`)
	decode1(t, p, st, `{"id":"dm-1","type":"response","command":"get_state","success":true,"data":{"sessionId":"`+ompSID+`","model":{"id":"fake-1","provider":"fakeco","name":"Fake One","contextWindow":1048576},"contextUsage":{"tokens":15685,"contextWindow":1048576,"percent":1.5},"thinkingLevel":"high","isStreaming":false}}`)
	return p, st
}

// F-4: `--mode rpc-ui --approval-mode <정책>` 을 반드시 싣는다. 비면 always-ask.
func TestOmpProto_Launch(t *testing.T) {
	p, _ := ompProtoOf(t)
	argv := p.Launch(LaunchOpts{Bin: "/opt/bin/agent", Cwd: "/w"})
	if got := strings.Join(argv, " "); got != "/opt/bin/agent --mode rpc-ui --approval-mode always-ask" {
		t.Fatalf("argv: %s", got)
	}
	argv = p.Launch(LaunchOpts{Bin: "/b", Approval: "write", Model: "fakeco/fake-1", Resume: "01a09b1e-c536"})
	if got := strings.Join(argv, " "); got != "/b --mode rpc-ui --approval-mode write --model fakeco/fake-1 --resume 01a09b1e-c536" {
		t.Fatalf("argv: %s", got)
	}
	// PermissionMode 는 omp 에 없다 — 실리지 않는다 (부재).
	argv = p.Launch(LaunchOpts{Bin: "/b", PermissionMode: "plan"})
	if strings.Contains(strings.Join(argv, " "), "plan") {
		t.Fatalf("permission mode 는 omp 의 것이 아니다: %v", argv)
	}
	if len(p.PermissionModes) != 0 {
		t.Fatal("omp 는 세션 중 권한 순환이 없다")
	}
}

// 핸드셰이크 get_state → 세션 신원·모델·컨텍스트 창 (U-5). 명령 목록은 omp 가 민다.
func TestOmpProto_HandshakeState(t *testing.T) {
	p, st := ompProtoOf(t)
	hs := p.Handshake(LaunchOpts{}, st)
	if len(hs) != 2 || !strings.Contains(string(hs[0]), `"type":"get_state"`) || !strings.Contains(string(hs[1]), `"type":"get_available_models"`) {
		t.Fatalf("handshake: %q", hs)
	}
	if evs := decode1(t, p, st, `{"type":"ready","protocolVersion":1}`); len(evs) != 0 {
		t.Fatalf("ready: %v", evs)
	}
	evs := decode1(t, p, st, `{"id":"dm-1","type":"response","command":"get_state","success":true,"data":{"sessionId":"`+ompSID+`","model":{"id":"fake-1","provider":"fakeco","name":"Fake One","contextWindow":1048576},"contextUsage":{"tokens":15685,"contextWindow":1048576,"percent":1.5}}}`)
	if kinds(evs) != "session,usage" || evs[0].SessionID != ompSID || evs[0].Status.Model != "fakeco/fake-1" {
		t.Fatalf("session: %+v", evs)
	}
	if evs[1].Usage.Tokens != 15685 || evs[1].Usage.ContextWindow != 1048576 {
		t.Fatalf("usage: %+v", evs[1].Usage)
	}
	if st.SessionID != ompSID {
		t.Fatalf("st.SessionID=%q", st.SessionID)
	}
	evs = decode1(t, p, st, `{"id":"dm-2","type":"response","command":"get_available_models","success":true,"data":{"models":[{"id":"fake-1","name":"Fake One","provider":"fakeco"},{"id":"fake-2","name":"Fake Two","provider":"fakeco"}]}}`)
	if kinds(evs) != "status" || len(evs[0].Status.Models) != 2 || evs[0].Status.Models[1].Value != "fakeco/fake-2" {
		t.Fatalf("models: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"available_commands_update","commands":[{"name":"compact","source":"builtin"},{"name":"model","source":"builtin"}]}`)
	if kinds(evs) != "status" || cmdNames(evs[0].Status.Commands) != "compact,model" {
		t.Fatalf("commands: %+v", evs)
	}
	// 대기표에 없는 응답 — unknown command 는 id 없이 온다 (실측).
	if _, ok := p.Decode([]byte(`{"type":"response","command":"bogus_command","success":false,"error":"Unknown command: bogus_command"}`), st); ok {
		t.Fatal("id 없는 응답을 안다고 했다")
	}
}

// 턴: prompt 응답 → agent_start → 델타 → message_end(사용량) → agent_end (isTerminal).
func TestOmpProto_Turn(t *testing.T) {
	p, st := ompReady(t)
	frames := p.Prompt("say PONG", nil, st)
	var cmd struct {
		ID, Type, Message string
		Streaming         string `json:"streamingBehavior"`
	}
	_ = json.Unmarshal(frames[0], &cmd)
	if cmd.Type != "prompt" || cmd.Message != "say PONG" || cmd.Streaming != "" {
		t.Fatalf("prompt: %s", frames[0])
	}
	if evs := decode1(t, p, st, `{"id":"`+cmd.ID+`","type":"response","command":"prompt","success":true}`); len(evs) != 0 {
		t.Fatalf("prompt ack: %v", evs)
	}
	evs := decode1(t, p, st, `{"type":"agent_start"}`)
	if kinds(evs) != "turn_start" {
		t.Fatalf("agent_start: %v", kinds(evs))
	}
	// 스트리밍 중의 프롬프트는 steer 다.
	if fr := p.Prompt("more", nil, st); !strings.Contains(string(fr[0]), `"streamingBehavior":"steer"`) {
		t.Fatalf("steer: %s", fr[0])
	}
	for _, line := range []string{`{"type":"turn_start"}`, `{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"say PONG"}]}}`,
		`{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"say PONG"}],"timestamp":1}}`} {
		if evs, ok := p.Decode([]byte(line), st); !ok || len(evs) != 0 {
			t.Fatalf("%s → %v %v", line, evs, ok)
		}
	}
	evs = decode1(t, p, st, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"PO"},"message":{"role":"assistant","content":[]}}`)
	if kinds(evs) != "text_delta" || evs[0].Text != "PO" {
		t.Fatalf("delta: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hm"},"message":{"role":"assistant","content":[]}}`)
	if kinds(evs) != "thinking_delta" {
		t.Fatalf("thinking: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"PONG"}],"api":"x","provider":"fakeco","model":"fake-1","usage":{"input":10,"output":5,"cacheRead":1000,"cacheWrite":100,"totalTokens":1115,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.001}},"stopReason":"stop","timestamp":1}}`)
	if kinds(evs) != "message,usage" {
		t.Fatalf("message_end: %v", kinds(evs))
	}
	if !strings.Contains(string(evs[0].Message), `"thinking":"hm"`) || !strings.Contains(string(evs[0].Message), `"text":"PONG"`) {
		t.Fatalf("blocks: %s", evs[0].Message)
	}
	if u := evs[1].Usage; u.Tokens != 1110 || u.OutputTokens != 5 || u.CostUSD != 0.001 || u.Model != "fakeco/fake-1" {
		t.Fatalf("usage: %+v", u)
	}
	evs = decode1(t, p, st, `{"type":"turn_end","message":{"role":"assistant","content":[]},"toolResults":[]}`)
	if len(evs) != 0 {
		t.Fatalf("omp 의 turn_end 는 루프의 한 바퀴다: %v", evs)
	}
	if evs, _ := p.Decode([]byte(`{"type":"agent_end","messages":[],"isTerminal":false}`), st); len(evs) != 0 {
		t.Fatalf("isTerminal:false 는 끝이 아니다: %v", evs)
	}
	evs = decode1(t, p, st, `{"type":"agent_end","messages":[]}`)
	if kinds(evs) != "turn_end" || evs[0].IsError {
		t.Fatalf("agent_end: %+v", evs)
	}
	if a, _ := evs[0].Activity(); a != "done" {
		t.Fatalf("→ done, got %q", a)
	}
	if fr := p.Prompt("after", nil, st); strings.Contains(string(fr[0]), "steer") {
		t.Fatalf("턴 뒤의 프롬프트는 보통 프롬프트다: %s", fr[0])
	}
	// 오류 턴 (실측: 401) — message_end 가 stopReason:error 를 든다.
	evs = decode1(t, p, st, `{"type":"message_end","message":{"role":"assistant","content":[],"api":"x","provider":"fakeco","model":"fake-1","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0},"stopReason":"error","errorStatus":401,"errorMessage":"401 Invalid API Key","timestamp":1}}`)
	if kinds(evs) != "error" || !strings.Contains(evs[0].Text, "401") {
		t.Fatalf("error turn: %+v", evs)
	}
}

// 도구 실행과 승인 (`Allow tool: bash` select) — FR-APS-5 · FR-AGT-5.
func TestOmpProto_ToolAndApproval(t *testing.T) {
	p, st := ompReady(t)
	evs := decode1(t, p, st, `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"tc-1","name":"bash","arguments":{"command":"touch fake.txt"}}},"message":{"role":"assistant","content":[]}}`)
	if kinds(evs) != "tool_start" || evs[0].Tool != "bash" || evs[0].ToolUseID != "tc-1" {
		t.Fatalf("toolcall_end: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc-1","name":"bash","arguments":{"command":"touch fake.txt"}}],"api":"x","provider":"fakeco","model":"fake-1","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2},"stopReason":"toolUse","timestamp":1}}`)
	if kinds(evs) != "message,usage" || !strings.Contains(string(evs[0].Message), `"type":"tool_use"`) || !strings.Contains(string(evs[0].Message), `"name":"bash"`) {
		t.Fatalf("toolCall 블록: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"extension_ui_request","id":"157e1506","method":"select","title":"Allow tool: bash\nCommand: touch fake.txt","options":["Approve","Deny"]}`)
	if kinds(evs) != "approval_open" {
		t.Fatalf("approval: %v", kinds(evs))
	}
	ar := evs[0].Approval
	if ar.Kind != ApprovalPermission || ar.Tool != "bash" || ar.Detail != "Command: touch fake.txt" || len(ar.Options) != 2 || ar.Options[0].ID != ChoiceAllow || ar.Options[1].ID != ChoiceDeny {
		t.Fatalf("request: %+v", ar)
	}
	if a, _ := evs[0].Activity(); a != "waiting" || evs[0].Tool != "bash" {
		t.Fatalf("waiting: %+v", evs[0])
	}
	frame, err := p.Approve(*ar, Decision{Choice: ChoiceAllow}, st)
	if err != nil || string(frame) != `{"id":"157e1506","type":"extension_ui_response","value":"Approve"}` {
		t.Fatalf("approve: %s %v", frame, err)
	}
	if len(st.Open) != 0 {
		t.Fatal("답한 요청은 닫힌다")
	}
	if _, err := p.Approve(*ar, Decision{Choice: ChoiceDeny}, st); err != ErrNotOpen {
		t.Fatalf("두 번째 답: %v", err)
	}
	decode1(t, p, st, `{"type":"extension_ui_request","id":"u2","method":"select","title":"Allow tool: edit\nPath: a.txt","options":["Approve","Deny"]}`)
	frame, _ = p.Approve(st.Open["u2"], Decision{Choice: ChoiceDeny}, st)
	if !strings.Contains(string(frame), `"value":"Deny"`) {
		t.Fatalf("deny: %s", frame)
	}
	// 실행과 결과.
	evs = decode1(t, p, st, `{"type":"tool_execution_start","toolCallId":"tc-1","toolName":"bash","args":{"command":"touch fake.txt"}}`)
	if kinds(evs) != "tool_start" || evs[0].Detail != "touch fake.txt" {
		t.Fatalf("exec start: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"tool_execution_end","toolCallId":"tc-1","toolName":"bash","result":{"content":[{"type":"text","text":"(no output)"}]},"isError":false}`)
	if kinds(evs) != "tool_end" || evs[0].Text != "(no output)" || evs[0].IsError {
		t.Fatalf("exec end: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"message_end","message":{"role":"toolResult","toolCallId":"tc-1","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false,"timestamp":1}}`)
	if kinds(evs) != "tool_end" || evs[0].Text != "ok" {
		t.Fatalf("toolResult: %+v", evs)
	}
	// 취소 — 종료 직전의 규약 (U-7).
	decode1(t, p, st, `{"type":"extension_ui_request","id":"u3","method":"select","title":"Allow tool: bash\nx","options":["Approve","Deny"]}`)
	if c := p.Cancel(st.Open["u3"], st); string(c) != `{"cancelled":true,"id":"u3","type":"extension_ui_response"}` || len(st.Open) != 0 {
		t.Fatalf("cancel: %s open=%d", c, len(st.Open))
	}
}

// 승인 아닌 위젯: 일반 select 는 질문, confirm 은 예/아니오, input 은 자유 입력 (FR-U-2 판정).
func TestOmpProto_QuestionConfirmInput(t *testing.T) {
	p, st := ompReady(t)
	evs := decode1(t, p, st, `{"type":"extension_ui_request","id":"q1","method":"select","title":"Pick a color","options":["Red","Blue"]}`)
	ar := evs[0].Approval
	if ar.Kind != ApprovalQuestion || len(ar.Questions) != 1 || ar.Questions[0].Question != "Pick a color" || len(ar.Questions[0].Options) != 2 {
		t.Fatalf("select question: %+v", ar)
	}
	frame, err := p.Approve(*ar, Decision{Answers: map[string]string{"Pick a color": "Blue"}}, st)
	if err != nil || !strings.Contains(string(frame), `"value":"Blue"`) {
		t.Fatalf("answer: %s %v", frame, err)
	}
	evs = decode1(t, p, st, `{"type":"extension_ui_request","id":"c1","method":"confirm","title":"Confirm","message":"Continue?","timeout":30000}`)
	ar = evs[0].Approval
	if ar.Kind != ApprovalPermission || ar.Detail != "Confirm\nContinue?" || len(ar.Options) != 2 {
		t.Fatalf("confirm: %+v", ar)
	}
	frame, _ = p.Approve(*ar, Decision{Choice: ChoiceDeny}, st)
	if !strings.Contains(string(frame), `"confirmed":false`) {
		t.Fatalf("confirm no: %s", frame)
	}
	evs = decode1(t, p, st, `{"type":"extension_ui_request","id":"i1","method":"input","title":"Paste the authorization code (or full redirect URL):","timeout":600000}`)
	ar = evs[0].Approval
	if ar.Kind != ApprovalQuestion || !ar.Questions[0].FreeText {
		t.Fatalf("input: %+v", ar)
	}
	frame, _ = p.Approve(*ar, Decision{Answers: map[string]string{ar.Questions[0].Question: "code-123"}}, st)
	if !strings.Contains(string(frame), `"value":"code-123"`) {
		t.Fatalf("input answer: %s", frame)
	}
	decode1(t, p, st, `{"type":"extension_ui_request","id":"i2","method":"editor","title":"Notes","prefill":""}`)
	frame, _ = p.Approve(st.Open["i2"], Decision{Choice: ChoiceDeny}, st)
	if !strings.Contains(string(frame), `"cancelled":true`) {
		t.Fatalf("editor cancel: %s", frame)
	}
	// 답 없는 표시들 — 로그인 흐름(open_url·notify)은 본문으로, 위젯은 조용히.
	evs = decode1(t, p, st, `{"type":"extension_ui_request","id":"o1","method":"open_url","url":"https://example.test/auth"}`)
	if kinds(evs) != "user" || evs[0].Text != "https://example.test/auth" {
		t.Fatalf("open_url: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"extension_ui_request","id":"n1","method":"notify","message":"Waiting for browser authentication...","notifyType":"info"}`)
	if kinds(evs) != "user" {
		t.Fatalf("notify: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"extension_ui_request","id":"n2","method":"notify","message":"bad","notifyType":"error"}`)
	if kinds(evs) != "error" {
		t.Fatalf("notify error: %+v", evs)
	}
	if evs := decode1(t, p, st, `{"type":"extension_ui_request","id":"w1","method":"setWidget","widgetKey":"autoresearch"}`); len(evs) != 0 {
		t.Fatalf("setWidget: %v", evs)
	}
	if len(st.Open) != 0 {
		t.Fatalf("표시는 열린 요청이 아니다: %d", len(st.Open))
	}
}

// 제어·인터럽트·로컬 명령·신원 교체·TUI 출구.
func TestOmpProto_ControlAndLocal(t *testing.T) {
	p, st := ompReady(t)
	fr, err := p.Control(ControlOp{Kind: "set_model", Value: "fakeco/fake-2"}, st)
	if err != nil || !strings.Contains(string(fr), `"provider":"fakeco"`) || !strings.Contains(string(fr), `"modelId":"fake-2"`) {
		t.Fatalf("set_model: %s %v", fr, err)
	}
	var cmd struct{ ID string }
	_ = json.Unmarshal(fr, &cmd)
	evs := decode1(t, p, st, `{"id":"`+cmd.ID+`","type":"response","command":"set_model","success":true,"data":{"id":"fake-2","provider":"fakeco","name":"Fake Two","contextWindow":1000}}`)
	if kinds(evs) != "status" || evs[0].Status.Model != "fakeco/fake-2" {
		t.Fatalf("set_model 응답: %+v", evs)
	}
	if _, err := p.Control(ControlOp{Kind: "set_model", Value: "nope"}, st); err == nil {
		t.Fatal("provider/modelId 가 아니면 오류")
	}
	fr, _ = p.Control(ControlOp{Kind: "set_thinking_level", Value: "high"}, st)
	_ = json.Unmarshal(fr, &cmd)
	if evs, _ := p.Decode([]byte(`{"id":"`+cmd.ID+`","type":"response","command":"set_thinking_level","success":true}`), st); len(evs) != 0 {
		t.Fatalf("thinking ack: %v", evs)
	}
	if _, err := p.Control(ControlOp{Kind: "set_permission_mode", Value: "x"}, st); err != ErrUnsupported {
		t.Fatalf("권한 모드는 없다: %v", err)
	}
	// 실패 응답은 오류 이벤트다 (실측: Model not found).
	fr, _ = p.Control(ControlOp{Kind: "set_model", Value: "nope/nope"}, st)
	_ = json.Unmarshal(fr, &cmd)
	evs = decode1(t, p, st, `{"id":"`+cmd.ID+`","type":"response","command":"set_model","success":false,"error":"Model not found: nope/nope"}`)
	if kinds(evs) != "error" || !strings.Contains(evs[0].Text, "Model not found") {
		t.Fatalf("error: %+v", evs)
	}
	if in := p.Interrupt(st); !strings.Contains(string(in), `"type":"abort"`) {
		t.Fatalf("abort: %s", in)
	}
	// 슬래시 명령의 답은 command_output 이다 (실측 `/model`).
	evs = decode1(t, p, st, `{"type":"command_output","text":"Current model: fakeco/fake-1"}`)
	if kinds(evs) != "user" || !strings.Contains(evs[0].Text, "Current model") {
		t.Fatalf("command_output: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"config_update","model":{"id":"fake-1","provider":"fakeco"},"thinkingLevel":"high"}`)
	if kinds(evs) != "status" || evs[0].Status.Model != "fakeco/fake-1" {
		t.Fatalf("config_update: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"session_info_update","title":"x","sessionId":"new-sid"}`)
	if kinds(evs) != "reset" || st.SessionID != "new-sid" {
		t.Fatalf("reset: %+v %q", evs, st.SessionID)
	}
	evs = decode1(t, p, st, `{"type":"auto_compaction_end","skipped":false}`)
	if kinds(evs) != "status" || !evs[0].Status.Compacted {
		t.Fatalf("compaction: %+v", evs)
	}
	evs = decode1(t, p, st, `{"type":"rpc_frame_error","error":"RPC frame exceeded the transport limit"}`)
	if kinds(evs) != "error" {
		t.Fatalf("frame error: %+v", evs)
	}
	if got := strings.Join(p.TUIResume(ompSID), " "); got != "omp --resume "+ompSID {
		t.Fatalf("tui: %s", got)
	}
}

// FR-APS-8: 모르는 프레임.
func TestOmpProto_Unknown(t *testing.T) {
	p, st := ompReady(t)
	for _, line := range []string{`{"type":"notice","level":"info","message":"xd://: mounted"}`, `{"type":"model_changed"}`, `{"type":"thinking_level_changed","thinkingLevel":"high"}`} {
		if evs, ok := p.Decode([]byte(line), st); !ok || len(evs) != 0 {
			t.Fatalf("%s → %v %v", line, evs, ok)
		}
	}
	for _, line := range []string{`{"type":"host_tool_call","id":"h1"}`, `{"type":"extension_ui_request","id":"z","method":"whatever"}`, `{"nope":1}`, `garbage`} {
		if _, ok := p.Decode([]byte(line), st); ok {
			t.Fatalf("모르는 프레임을 안다고 했다: %s", line)
		}
	}
}

// V-M9-34 (M9_SRS FR-M9-34): **비율만 아는 어댑터.**
//
// omp 의 `contextUsage` 는 `percent` 를 함께 주는데 종전에는 읽지 않았다. 창 크기를
// 모르는 판에서는 **그것만이 컨텍스트를 말할 수 있고**, 화면은 `tokens` 가 없으면
// 아무것도 그리지 않았다 — 그 자리가 영영 비었다.
func TestOmpProto_ContextRatioOnly(t *testing.T) {
	p, st := ompProtoOf(t)
	// 응답은 **대기표에 있는 id** 라야 아는 프레임이다 — 핸드셰이크가 그 표를 만든다.
	p.Handshake(LaunchOpts{}, st)
	decode1(t, p, st, `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1],"maxFrameBytes":1048576}`)
	// **단위는 퍼센트다** (0~100) — 실측 프레임의 `tokens/window` 가 그것을 말한다.
	// 계약(`ContextRatio`)은 0.0~1.0 이므로 어댑터가 나눈다.
	evs := decode1(t, p, st, `{"id":"dm-1","type":"response","command":"get_state","success":true,`+
		`"data":{"sessionId":"s-1","contextUsage":{"percent":55}}}`)
	var u *ProtoUsage
	for _, e := range evs {
		if e.Kind == EvUsage {
			u = e.Usage
		}
	}
	if u == nil {
		t.Fatalf("비율만 와도 사용량 이벤트가 서야 한다: %v", evs)
	}
	if u.ContextRatio != 0.55 {
		t.Fatalf("비율: %+v", u)
	}
	// 모르는 것은 0 으로 채우지 않는다 (FR-CBG-5).
	if u.Tokens != 0 || u.ContextWindow != 0 {
		t.Fatalf("오지 않은 절대값이 채워졌다: %+v", u)
	}
}

// cmdNames 는 명령 목록의 이름만 이어 붙인다 — omp 는 이름뿐이다 (FR-M9-45).
func cmdNames(cs []ProtoCommand) string {
	out := make([]string, 0, len(cs))
	for _, c := range cs {
		out = append(out, c.Name)
	}
	return strings.Join(out, ",")
}

// V-M12-31 (FR-M12-23): omp 의 `agent_end` 는 **끝까지 간 것**이다 — 중단은 `message_end`
// 의 `stopReason` 으로 따로 오고 그것은 이미 `EvError` 다.
func TestOmpProto_TurnOutcome(t *testing.T) {
	p, st := ompReady(t)
	evs := decode1(t, p, st, `{"type":"agent_end","isTerminal":true,"sessionId":"`+ompSID+`"}`)
	if kinds(evs) != "turn_end" || evs[0].Outcome != OutcomeCompleted {
		t.Fatalf("agent_end: %s %+v", kinds(evs), evs)
	}
}
