package agentadapter

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// omp 의 프로토콜 표면 — `omp --mode rpc-ui`, stdio NDJSON (M8_UNIFIED_SRS §2.3.3 · §9.1
// U-1·U-4·U-5·U-7 · §9.3 ③, 실측 17.4.0 — P4 재실측은 M8_PROGRESS §2-27). `rpc-ui` 가
// 필수다: `rpc` 에서는 승인이 오류로 실패한다. 기본 `tools.approvalMode` 가 **yolo** 라
// `--approval-mode` 를 반드시 싣는다 (F-4).
//
// 프레임은 셋이다: 우리 명령의 **응답**(`type:"response"`, `id`·`command`·`success`) ·
// 세션 **이벤트**(`agent_start`·`message_update`·…) · **UI 요청**(`extension_ui_request`,
// 승인·질문·로그인 입력이 전부 이것이다 — 호스트가 답한다). 프로토콜 판은 1 이다 —
// 큰 프레임은 omp 가 줄여서(compact·shrink·overflow) 보내고, `rpc_chunk` 재조립은
// 판 2 의 것이라 쓰지 않는다.

// ompProto 는 ompAdapter.Proto 다.
var ompProto = Proto{
	Launch:    ompProtoLaunch,
	Handshake: ompHandshake,
	Decode:    ompDecode,
	Prompt:    ompPrompt,
	Approve:   ompApprove,
	Cancel:    ompCancel,
	Interrupt: ompInterrupt,
	Control:   ompControl,
	TUIResume: func(sessionID string) []string { return []string{"omp", "--resume", sessionID} },
	// PermissionModes 는 비운다 — 승인 정책은 기동 인자(`--approval-mode`)이고 세션 중에
	// 바꾸는 명령이 rpc 에 없다 (§9.3 ① "세션 중 전환 미확인").
}

// ompDefaultApproval 은 정책이 비었을 때의 값이다 — 가장 많이 묻는 쪽 (F-4).
const ompDefaultApproval = "always-ask"

// ompExt 는 이 어댑터의 사적 상태다 (ProtoState.Ext).
type ompExt struct {
	seq     int
	pending map[string]string // 우리 명령 id → command
	// inAgent 는 `agent_start`~`agent_end` 사이다. omp 의 `turn_*` 는 루프의 한 바퀴라
	// 공통 turn 은 agent 경계에서 난다.
	inAgent bool
	// ui 는 열린 UI 요청의 method 다 (답의 모양이 method 마다 다르다).
	ui map[string]string
}

func ompExtOf(st *ProtoState) *ompExt {
	if x, ok := st.Ext.(*ompExt); ok {
		return x
	}
	x := &ompExt{pending: map[string]string{}, ui: map[string]string{}}
	st.Ext = x
	return x
}

func (x *ompExt) nextID() string {
	x.seq++
	return "dm-" + strconv.Itoa(x.seq)
}

// ompProtoLaunch 는 §9.3 ③ 의 매핑이다. `--resume` 은 id 접두로도 된다 (실측).
func ompProtoLaunch(o LaunchOpts) []string {
	approval := o.Approval
	if approval == "" {
		approval = ompDefaultApproval
	}
	argv := []string{o.Bin, "--mode", "rpc-ui", "--approval-mode", approval}
	if o.Model != "" {
		argv = append(argv, "--model", o.Model)
	}
	if o.Resume != "" {
		argv = append(argv, "--resume", o.Resume)
	}
	return argv
}

// ompCommand 는 우리→omp 명령 프레임이다. 대기표를 남긴다.
func ompCommand(x *ompExt, typ string, body map[string]any) []byte {
	id := x.nextID()
	x.pending[id] = typ
	m := map[string]any{"id": id, "type": typ}
	for k, v := range body {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	return b
}

// ompHandshake 는 `get_state`(세션 신원·모델·컨텍스트 창) 와 `get_available_models`
// (FR-AGT-11) 다. 명령 목록은 omp 가 기동 때 `available_commands_update` 로 먼저 민다.
func ompHandshake(_ LaunchOpts, st *ProtoState) [][]byte {
	x := ompExtOf(st)
	return [][]byte{ompCommand(x, "get_state", nil), ompCommand(x, "get_available_models", nil)}
}

// ompPrompt 는 `prompt` 다. 슬래시 명령도 같은 길이며 omp 가 `command_output` 으로 답한다.
// 스트리밍 중이면 `streamingBehavior` 가 있어야 받아들이므로 steer 로 싣는다.
func ompPrompt(text string, st *ProtoState) [][]byte {
	x := ompExtOf(st)
	body := map[string]any{"message": text}
	if x.inAgent {
		body["streamingBehavior"] = "steer"
	}
	return [][]byte{ompCommand(x, "prompt", body)}
}

func ompInterrupt(st *ProtoState) []byte {
	return ompCommand(ompExtOf(st), "abort", nil)
}

// ompControl 은 `set_model{provider,modelId}`(값은 `provider/modelId`) 와
// `set_thinking_level` 이다. 권한 모드는 없다 (PermissionModes 비어 있음).
func ompControl(op ControlOp, st *ProtoState) ([]byte, error) {
	x := ompExtOf(st)
	switch op.Kind {
	case "set_model":
		provider, id, ok := strings.Cut(op.Value, "/")
		if !ok || provider == "" || id == "" {
			return nil, fmt.Errorf("set_model: %q 는 provider/modelId 가 아니다", op.Value)
		}
		return ompCommand(x, "set_model", map[string]any{"provider": provider, "modelId": id}), nil
	case "set_thinking_level":
		return ompCommand(x, "set_thinking_level", map[string]any{"level": op.Value}), nil
	}
	return nil, ErrUnsupported
}

// ompApprove 는 `extension_ui_response` 한 프레임이다 (NFR-C-4). method 마다 답의 모양이
// 다르다: select → value(선택지 문자열 그대로) · confirm → confirmed · input/editor → value(글).
func ompApprove(req ApprovalRequest, d Decision, st *ProtoState) ([]byte, error) {
	x := ompExtOf(st)
	method, open := x.ui[req.ID]
	if !open {
		return nil, ErrNotOpen
	}
	resp := map[string]any{"type": "extension_ui_response", "id": req.ID}
	switch method {
	case "confirm":
		switch d.Choice {
		case ChoiceAllow:
			resp["confirmed"] = true
		case ChoiceDeny:
			resp["confirmed"] = false
		default:
			return nil, fmt.Errorf("choice %q: 요청에 없는 선택지", d.Choice)
		}
	case "select":
		if req.Kind == ApprovalQuestion {
			if d.Choice == ChoiceDeny {
				resp["cancelled"] = true
				break
			}
			v, ok := d.Answers[req.Questions[0].Question]
			if !ok {
				return nil, fmt.Errorf("답이 없다: %q", req.Questions[0].Question)
			}
			resp["value"] = v
			break
		}
		var picked *ApprovalOption
		for i := range req.Options {
			if req.Options[i].ID == d.Choice {
				picked = &req.Options[i]
			}
		}
		if picked == nil {
			return nil, fmt.Errorf("choice %q: 요청에 없는 선택지", d.Choice)
		}
		var v string
		_ = json.Unmarshal(picked.Raw, &v)
		resp["value"] = v
	case "input", "editor":
		if d.Choice == ChoiceDeny {
			resp["cancelled"] = true
			break
		}
		v, ok := d.Answers[req.Questions[0].Question]
		if !ok {
			return nil, fmt.Errorf("답이 없다: %q", req.Questions[0].Question)
		}
		resp["value"] = v
	default:
		return nil, ErrUnsupported
	}
	delete(x.ui, req.ID)
	delete(st.Open, req.ID)
	b, _ := json.Marshal(resp)
	return b, nil
}

// ompCancel 은 답 없이 닫는다 — 종료 직전의 규약이다 (U-7: 로그인 `input` 을 열어 둔 채
// stdin 을 닫으면 재요청이 폭주했다).
func ompCancel(req ApprovalRequest, st *ProtoState) []byte {
	x := ompExtOf(st)
	delete(x.ui, req.ID)
	delete(st.Open, req.ID)
	b, _ := json.Marshal(map[string]any{"type": "extension_ui_response", "id": req.ID, "cancelled": true})
	return b
}

// ompFrame 은 세 종류의 합집합이다.
type ompFrame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Success *bool           `json:"success"`
	Error   string          `json:"error"`
	Data    json.RawMessage `json:"data"`
	// 세션 이벤트
	Message    json.RawMessage `json:"message"`
	AMEvent    json.RawMessage `json:"assistantMessageEvent"`
	IsTerminal *bool           `json:"isTerminal"`
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	Args       json.RawMessage `json:"args"`
	Result     json.RawMessage `json:"result"`
	IsError    bool            `json:"isError"`
	Text       string          `json:"text"`
	Level      string          `json:"level"`
	Commands   json.RawMessage `json:"commands"`
	Model      json.RawMessage `json:"model"`
	SessionID  string          `json:"sessionId"`
	// UI 요청 — message 는 위의 RawMessage 가 받는다 (여기서는 문자열이다).
	Method     string   `json:"method"`
	Title      string   `json:"title"`
	Options    []string `json:"options"`
	NotifyType string   `json:"notifyType"`
	URL        string   `json:"url"`
}

// ompDecode 는 한 줄을 공통 이벤트로 옮긴다 (FR-APS-2·3·8).
func ompDecode(line []byte, st *ProtoState) ([]Event, bool) {
	var fr ompFrame
	if err := json.Unmarshal(line, &fr); err != nil || fr.Type == "" {
		return nil, false
	}
	x := ompExtOf(st)
	sid := st.SessionID
	switch fr.Type {
	case "ready":
		return nil, true
	case "response":
		return ompDecodeResponse(fr, x, st)
	case "extension_ui_request":
		return ompDecodeUIRequest(fr, x, st)
	case "available_commands_update":
		return ompCommandsStatus(fr.Commands, sid)
	case "config_update":
		return []Event{ompModelStatus(fr.Model, sid)}, true
	case "session_info_update":
		if fr.SessionID != "" && fr.SessionID != st.SessionID {
			st.SessionID = fr.SessionID
			return []Event{{Kind: EvReset, SessionID: fr.SessionID}}, true
		}
		return nil, true
	case "agent_start":
		x.inAgent = true
		return []Event{{Kind: EvTurnStart, SessionID: sid}}, true
	case "agent_end":
		if fr.IsTerminal != nil && !*fr.IsTerminal {
			return nil, true
		}
		x.inAgent = false
		return []Event{{Kind: EvTurnEnd, SessionID: sid, Text: "completed"}}, true
	case "message_start", "turn_start", "turn_end", "model_changed", "thinking_level_changed",
		"auto_retry_start", "auto_retry_end", "retry_fallback_applied", "retry_fallback_succeeded",
		"ttsr_triggered", "todo_reminder", "todo_auto_clear", "goal_updated", "irc_message",
		"tool_execution_update", "prompt_result", "extension_error":
		return nil, true
	case "message_update":
		return ompDecodeMessageUpdate(fr, sid)
	case "message_end":
		return ompDecodeMessageEnd(fr, sid)
	case "tool_execution_start":
		return []Event{{Kind: EvToolStart, SessionID: sid, Tool: fr.ToolName, ToolUseID: fr.ToolCallID, Detail: ompArgsDetail(fr.Args)}}, true
	case "tool_execution_end":
		return []Event{{Kind: EvToolEnd, SessionID: sid, Tool: fr.ToolName, ToolUseID: fr.ToolCallID, Text: ompResultText(fr.Result), IsError: fr.IsError}}, true
	case "auto_compaction_start":
		return nil, true
	case "auto_compaction_end":
		return []Event{{Kind: EvStatus, SessionID: sid, Status: &ProtoStatus{Compacted: true}}}, true
	case "command_output":
		return []Event{{Kind: EvUser, SessionID: sid, Text: fr.Text}}, true
	case "notice":
		if fr.Level == "error" {
			var m struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(fr.Message, &m)
			return []Event{{Kind: EvError, SessionID: sid, Text: m.Message}}, true
		}
		return nil, true
	case "rpc_frame_error":
		return []Event{{Kind: EvError, SessionID: sid, Text: fr.Error}}, true
	}
	return nil, false
}

// ompDecodeResponse 는 우리 명령의 답이다. 대기표에 없는 id(unknown command 의 id 없는
// 응답 포함)는 모르는 프레임이다.
func ompDecodeResponse(fr ompFrame, x *ompExt, st *ProtoState) ([]Event, bool) {
	cmd, ok := x.pending[fr.ID]
	if !ok {
		return nil, false
	}
	delete(x.pending, fr.ID)
	sid := st.SessionID
	if fr.Success != nil && !*fr.Success {
		return []Event{{Kind: EvError, SessionID: sid, Text: cmd + ": " + fr.Error}}, true
	}
	switch cmd {
	case "get_state":
		var d struct {
			SessionID    string          `json:"sessionId"`
			Model        json.RawMessage `json:"model"`
			ContextUsage *struct {
				Tokens        int64 `json:"tokens"`
				ContextWindow int64 `json:"contextWindow"`
				// M9_SRS FR-M9-34: omp 는 **비율도 함께** 준다. 종전에는 읽지 않았다.
				// 창 크기를 모르는 판에서는 이것만이 컨텍스트를 말할 수 있다.
				//
				// **단위가 claude 와 다르다** — 여기는 퍼센트(0~100)이고 claude 의
				// `utilization` 은 비율(0~1)이다. 실측: `tokens 15685 / window 1048576`
				// 인 프레임의 `percent` 가 `1.5` 다. 계약은 `ProtoUsage.ContextRatio`
				// 하나(0.0~1.0)이므로 **맞추는 일은 어댑터가 한다** — 그것이 어댑터가
				// 있는 이유이며, 두 단위를 위로 흘리면 화면이 에이전트를 알아야 한다.
				Percent float64 `json:"percent"`
			} `json:"contextUsage"`
		}
		if err := json.Unmarshal(fr.Data, &d); err != nil || d.SessionID == "" {
			return nil, false
		}
		st.SessionID = d.SessionID
		evs := []Event{{Kind: EvSession, SessionID: d.SessionID, Status: ompModelStatus(d.Model, d.SessionID).Status}}
		if d.ContextUsage != nil {
			evs = append(evs, Event{Kind: EvUsage, SessionID: d.SessionID,
				Usage: &ProtoUsage{Tokens: d.ContextUsage.Tokens, ContextWindow: d.ContextUsage.ContextWindow,
					ContextRatio: d.ContextUsage.Percent / 100}})
		}
		return evs, true
	case "get_available_models":
		var d struct {
			Models []struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				Provider string `json:"provider"`
			} `json:"models"`
		}
		if err := json.Unmarshal(fr.Data, &d); err != nil {
			return nil, false
		}
		s := &ProtoStatus{}
		for _, m := range d.Models {
			s.Models = append(s.Models, ModelChoice{Value: m.Provider + "/" + m.ID, DisplayName: m.Name, Description: m.Provider})
		}
		if len(s.Models) == 0 {
			return nil, true
		}
		return []Event{{Kind: EvStatus, SessionID: sid, Status: s}}, true
	case "set_model":
		return []Event{ompModelStatus(fr.Data, sid)}, true
	}
	// prompt · abort · set_thinking_level: 성공이면 알릴 것이 없다.
	return nil, true
}

// ompModelStatus 는 모델 객체(`{id,provider,name,contextWindow}`)를 상태 이벤트로.
func ompModelStatus(raw json.RawMessage, sid string) Event {
	var m struct {
		ID       string `json:"id"`
		Provider string `json:"provider"`
	}
	_ = json.Unmarshal(raw, &m)
	s := &ProtoStatus{}
	if m.ID != "" {
		s.Model = m.Provider + "/" + m.ID
	}
	return Event{Kind: EvStatus, SessionID: sid, Status: s}
}

func ompCommandsStatus(raw json.RawMessage, sid string) ([]Event, bool) {
	var cs []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &cs); err != nil {
		return nil, false
	}
	s := &ProtoStatus{}
	for _, c := range cs {
		// M9_SRS FR-M9-45: omp 의 명령 목록은 **이름뿐**이다 (실측한 프레임에
		// 설명·인자 문법이 없다). 없는 것을 지어내지 않는다 (FR-APS-4) — 화면은
		// 빈 힌트를 그리지 않으므로 종전과 같은 모양으로 선다.
		s.Commands = append(s.Commands, ProtoCommand{Name: c.Name})
	}
	return []Event{{Kind: EvStatus, SessionID: sid, Status: s}}, true
}

// ompDecodeMessageUpdate 는 스트리밍 델타다 (`assistantMessageEvent`).
func ompDecodeMessageUpdate(fr ompFrame, sid string) ([]Event, bool) {
	var ev struct {
		Type     string `json:"type"`
		Delta    string `json:"delta"`
		ToolCall *struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"toolCall"`
	}
	if err := json.Unmarshal(fr.AMEvent, &ev); err != nil {
		return nil, false
	}
	switch ev.Type {
	case "text_delta":
		return []Event{{Kind: EvTextDelta, SessionID: sid, Text: ev.Delta}}, true
	case "thinking_delta":
		return []Event{{Kind: EvThinkingDelta, SessionID: sid, Text: ev.Delta}}, true
	case "toolcall_end":
		if ev.ToolCall == nil {
			return nil, true
		}
		return []Event{{Kind: EvToolStart, SessionID: sid, Tool: ev.ToolCall.Name, ToolUseID: ev.ToolCall.ID}}, true
	}
	return nil, true
}

// ompDecodeMessageEnd 는 메시지 스냅샷이다. assistant 는 블록을 공통 어휘로 옮기고,
// toolResult 는 도구 결과, user 는 우리가 보낸 것이라 비운다.
func ompDecodeMessageEnd(fr ompFrame, sid string) ([]Event, bool) {
	var m struct {
		Role       string          `json:"role"`
		Content    json.RawMessage `json:"content"`
		ToolCallID string          `json:"toolCallId"`
		ToolName   string          `json:"toolName"`
		IsError    bool            `json:"isError"`
		StopReason string          `json:"stopReason"`
		ErrMsg     string          `json:"errorMessage"`
		Model      string          `json:"model"`
		Provider   string          `json:"provider"`
		Usage      *struct {
			Input      int64 `json:"input"`
			Output     int64 `json:"output"`
			CacheRead  int64 `json:"cacheRead"`
			CacheWrite int64 `json:"cacheWrite"`
			Cost       *struct {
				Total float64 `json:"total"`
			} `json:"cost"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(fr.Message, &m); err != nil {
		return nil, false
	}
	switch m.Role {
	case "assistant":
		var evs []Event
		if blocks := ompBlocks(m.Content); blocks != nil {
			evs = append(evs, Event{Kind: EvMessage, SessionID: sid, Message: blocks})
		}
		if u := m.Usage; u != nil && (u.Input+u.CacheRead+u.CacheWrite > 0 || u.Output > 0) {
			pu := &ProtoUsage{Tokens: u.Input + u.CacheRead + u.CacheWrite, OutputTokens: u.Output, Model: m.Provider + "/" + m.Model}
			if u.Cost != nil {
				pu.CostUSD = u.Cost.Total
			}
			evs = append(evs, Event{Kind: EvUsage, SessionID: sid, Usage: pu})
		}
		if m.StopReason == "error" || m.StopReason == "aborted" {
			text := m.ErrMsg
			if text == "" {
				text = m.StopReason
			}
			evs = append(evs, Event{Kind: EvError, SessionID: sid, Text: text})
		}
		return evs, true
	case "toolResult":
		return []Event{{Kind: EvToolEnd, SessionID: sid, Tool: m.ToolName, ToolUseID: m.ToolCallID, Text: ompResultText(m.Content), IsError: m.IsError}}, true
	}
	return nil, true
}

// ompBlocks 는 omp 의 content 를 공통 블록 어휘로 — text · thinking · toolCall→tool_use.
func ompBlocks(raw json.RawMessage) json.RawMessage {
	var items []struct {
		Type      string          `json:"type"`
		Text      string          `json:"text"`
		Thinking  string          `json:"thinking"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		switch it.Type {
		case "text":
			out = append(out, map[string]any{"type": "text", "text": it.Text})
		case "thinking":
			out = append(out, map[string]any{"type": "thinking", "thinking": it.Thinking})
		case "toolCall":
			out = append(out, map[string]any{"type": "tool_use", "id": it.ID, "name": it.Name, "input": it.Arguments})
		}
	}
	if len(out) == 0 {
		return nil
	}
	b, _ := json.Marshal(out)
	return b
}

// ompResultText 는 도구 결과 content(`{type:text}` 배열 또는 문자열)를 글자로.
func ompResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var items []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &items) != nil {
		var r struct {
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(raw, &r) == nil && len(r.Content) > 0 {
			return ompResultText(r.Content)
		}
		return string(raw)
	}
	parts := make([]string, 0, len(items))
	for _, it := range items {
		if it.Type == "text" {
			parts = append(parts, it.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// ompArgsDetail 은 도구 인자에서 알람에 실을 한 줄을 — command · path 순.
func ompArgsDetail(raw json.RawMessage) string {
	var a struct {
		Command string `json:"command"`
		Path    string `json:"path"`
	}
	_ = json.Unmarshal(raw, &a)
	if a.Command != "" {
		return a.Command
	}
	return a.Path
}

// ompDecodeUIRequest 는 `extension_ui_request` 다. 승인은 `select` 에 `Allow tool: <name>`
// 제목과 `["Approve","Deny"]` 로 온다(소스 `wrapper.ts`) — 그것은 permission 이고, 그 밖의
// select·confirm·input·editor 는 question 이다 (FR-AGT-4). notify·setWidget·setStatus·
// setTitle·set_editor_text 는 답이 없는 표시이고, open_url 은 본문에 URL 을 싣는다.
func ompDecodeUIRequest(fr ompFrame, x *ompExt, st *ProtoState) ([]Event, bool) {
	sid := st.SessionID
	if fr.ID == "" {
		return nil, false
	}
	var msg string
	_ = json.Unmarshal(fr.Message, &msg)
	ar := ApprovalRequest{ID: fr.ID, Kind: ApprovalQuestion, Detail: fr.Title}
	switch fr.Method {
	case "select":
		if tool, detail, ok := ompApprovalTitle(fr.Title); ok && len(fr.Options) == 2 && fr.Options[0] == "Approve" && fr.Options[1] == "Deny" {
			ar.Kind = ApprovalPermission
			ar.Tool = tool
			ar.Detail = detail
			in, _ := json.Marshal(detail)
			ar.Input = in
			ar.Options = []ApprovalOption{
				{ID: ChoiceAllow, Label: "Approve", Raw: json.RawMessage(`"Approve"`)},
				{ID: ChoiceDeny, Label: "Deny", Raw: json.RawMessage(`"Deny"`)},
			}
			break
		}
		q := Question{Question: fr.Title}
		for _, o := range fr.Options {
			q.Options = append(q.Options, QuestionOption{Label: o})
		}
		ar.Questions = []Question{q}
	case "confirm":
		ar.Kind = ApprovalPermission
		ar.Detail = strings.TrimSpace(fr.Title + "\n" + msg)
		in, _ := json.Marshal(msg)
		ar.Input = in
		ar.Options = []ApprovalOption{
			{ID: ChoiceAllow, Label: "Yes", Raw: json.RawMessage(`true`)},
			{ID: ChoiceDeny, Label: "No", Raw: json.RawMessage(`false`)},
		}
	case "input", "editor":
		ar.Questions = []Question{{Question: fr.Title, FreeText: true}}
	case "notify":
		if fr.NotifyType == "error" {
			return []Event{{Kind: EvError, SessionID: sid, Text: msg}}, true
		}
		return []Event{{Kind: EvUser, SessionID: sid, Text: msg}}, true
	case "open_url":
		return []Event{{Kind: EvUser, SessionID: sid, Text: fr.URL}}, true
	case "setWidget", "setStatus", "setTitle", "set_editor_text", "cancel":
		return nil, true
	default:
		return nil, false
	}
	x.ui[ar.ID] = fr.Method
	st.Open[ar.ID] = ar
	return []Event{{Kind: EvApprovalOpen, SessionID: sid, Tool: ar.Tool, Detail: ar.Detail, Approval: &ar}}, true
}

// ompApprovalTitle 은 `Allow tool: <name>\n<details…>` 를 가른다 (`formatApprovalPrompt`).
func ompApprovalTitle(title string) (tool, detail string, ok bool) {
	const prefix = "Allow tool: "
	if !strings.HasPrefix(title, prefix) {
		return "", "", false
	}
	first, rest, _ := strings.Cut(title[len(prefix):], "\n")
	return strings.TrimSpace(first), strings.TrimSpace(rest), true
}
