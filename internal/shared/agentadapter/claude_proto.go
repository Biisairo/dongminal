package agentadapter

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// claude 의 프로토콜 표면 — stream-json 양방향 (M8_UNIFIED_SRS §2.3.4 · §9.3 ③,
// 실측 2.1.270). 프레임 스키마는 공개 계약이 아니다 (R-2) — 바뀌면 이 파일 하나가
// 흡수한다 (FR-APS-7).

// claudeProto 는 claudeAdapter.Proto 다.
var claudeProto = Proto{
	Launch:    claudeProtoLaunch,
	Handshake: claudeHandshake,
	Decode:    claudeDecode,
	Prompt:    claudePrompt,
	Approve:   claudeApprove,
	// Cancel 은 없다 — claude 는 열린 요청을 답 없이 닫는 프레임이 없다. stdin EOF 가
	// 곧 종료다 (§9.1 U-7). 없는 것을 빈 함수로 두지 않는다 (D-U-6).
	Interrupt: claudeInterrupt,
	Control:   claudeControl,
	TUIResume: func(sessionID string) []string { return []string{"claude", "--resume", sessionID} },
	// TUI 의 Shift+Tab 순서다 (FR-AGT-4a). `bypassPermissions` 는 설정으로 켜야 나타나는
	// 값이라 순환에 두지 않는다 — 실을 수 있는 값은 `--permission-mode` 의 선택지다.
	PermissionModes: []string{"default", "acceptEdits", "plan"},
}

// claudeExt 는 이 어댑터의 사적 상태다 (ProtoState.Ext).
type claudeExt struct {
	// pending 은 우리가 보낸 제어 요청의 대기표다 — request_id → 무엇을 물었나.
	// 응답 프레임은 request_id 만 되돌리므로 이것 없이는 뜻을 알 수 없다.
	pending map[string]claudePending
	seq     int
	// inTurn 은 턴이 진행 중인가다. `status:requesting` 은 모델 요청마다 오므로
	// 첫 것만 turn_start 다 — 턴의 끝은 `result` 하나다.
	inTurn bool
}

type claudePending struct {
	subtype string
	value   string
}

func claudeExtOf(st *ProtoState) *claudeExt {
	if x, ok := st.Ext.(*claudeExt); ok {
		return x
	}
	x := &claudeExt{pending: map[string]claudePending{}}
	st.Ext = x
	return x
}

func (x *claudeExt) nextID() string {
	x.seq++
	return "dm-" + strconv.Itoa(x.seq)
}

// claudeProtoLaunch 는 §9.3 ③ 의 매핑이다. `--permission-prompt-tool stdio` 는 헬프에
// 없는 값이다 (FR-APS-10, R-2).
func claudeProtoLaunch(o LaunchOpts) []string {
	argv := []string{o.Bin, "-p", "--output-format", "stream-json", "--input-format", "stream-json",
		"--include-partial-messages", "--verbose", "--permission-prompt-tool", "stdio"}
	if o.Model != "" {
		argv = append(argv, "--model", o.Model)
	}
	if o.Resume != "" {
		argv = append(argv, "--resume", o.Resume)
	}
	if o.PermissionMode != "" {
		argv = append(argv, "--permission-mode", o.PermissionMode)
	}
	return argv
}

// controlRequest 는 호스트→CLI 제어 프레임이다. 대기표를 남긴다.
func claudeControlRequest(st *ProtoState, subtype, value string, body map[string]any) []byte {
	x := claudeExtOf(st)
	id := x.nextID()
	x.pending[id] = claudePending{subtype: subtype, value: value}
	req := map[string]any{"subtype": subtype}
	for k, v := range body {
		req[k] = v
	}
	b, _ := json.Marshal(map[string]any{"type": "control_request", "request_id": id, "request": req})
	return b
}

// claudeHandshake 는 `initialize` 하나다 — 모델 목록·명령 목록·계정·권한 모드를 준다
// (FR-AGT-11). 실측한 모양 그대로 `hooks:{}` 를 싣는다.
func claudeHandshake(_ LaunchOpts, st *ProtoState) [][]byte {
	return [][]byte{claudeControlRequest(st, "initialize", "", map[string]any{"hooks": map[string]any{}})}
}

func claudePrompt(text string, st *ProtoState) [][]byte {
	b, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}})
	return [][]byte{b}
}

func claudeInterrupt(st *ProtoState) []byte {
	return claudeControlRequest(st, "interrupt", "", nil)
}

// claudeControl 은 실측한 셋만 받는다 (§9.3 ① "모델 선택 — 세션 중"·"권한/plan 모드").
func claudeControl(op ControlOp, st *ProtoState) ([]byte, error) {
	switch op.Kind {
	case "set_model":
		return claudeControlRequest(st, op.Kind, op.Value, map[string]any{"model": op.Value}), nil
	case "set_permission_mode":
		return claudeControlRequest(st, op.Kind, op.Value, map[string]any{"mode": op.Value}), nil
	case "set_max_thinking_tokens":
		n, err := strconv.Atoi(op.Value)
		if err != nil {
			return nil, fmt.Errorf("set_max_thinking_tokens: %w", err)
		}
		return claudeControlRequest(st, op.Kind, op.Value, map[string]any{"max_thinking_tokens": n}), nil
	}
	return nil, ErrUnsupported
}

// claudeApprove 는 `control_response` 한 프레임이다 (NFR-C-4). 선택지는 요청이 준 것
// 그대로다 — `suggestion:<i>` 는 그 제안 항목을 `updatedPermissions` 로 되돌린다
// (§2.3.4 P3 재실측 ②).
func claudeApprove(req ApprovalRequest, d Decision, st *ProtoState) ([]byte, error) {
	if _, open := st.Open[req.ID]; !open {
		return nil, ErrNotOpen
	}
	var input any
	if len(req.Input) > 0 {
		_ = json.Unmarshal(req.Input, &input)
	}
	inner := map[string]any{}
	switch {
	case req.Kind == ApprovalQuestion && d.Choice != ChoiceDeny:
		m, _ := input.(map[string]any)
		if m == nil {
			m = map[string]any{}
		}
		m["answers"] = d.Answers
		inner["behavior"] = "allow"
		inner["updatedInput"] = m
	case d.Choice == ChoiceAllow:
		inner["behavior"] = "allow"
		inner["updatedInput"] = input
	case d.Choice == ChoiceDeny:
		inner["behavior"] = "deny"
		inner["message"] = "Denied by user"
	case strings.HasPrefix(d.Choice, "suggestion:"):
		var picked *ApprovalOption
		for i := range req.Options {
			if req.Options[i].ID == d.Choice {
				picked = &req.Options[i]
			}
		}
		if picked == nil {
			return nil, fmt.Errorf("choice %q: 요청에 없는 선택지", d.Choice)
		}
		inner["behavior"] = "allow"
		inner["updatedInput"] = input
		inner["updatedPermissions"] = []json.RawMessage{picked.Raw}
	default:
		return nil, fmt.Errorf("choice %q: 요청에 없는 선택지", d.Choice)
	}
	delete(st.Open, req.ID)
	b, _ := json.Marshal(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": req.ID, "response": inner,
	}})
	return b, nil
}

// claudeFrame 은 한 줄이 가질 수 있는 필드의 합집합이다. 프레임 종류마다 채워지는
// 것이 다르고, 없는 것은 영값이다.
type claudeFrame struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	SessionID string          `json:"session_id"`
	UUID      string          `json:"uuid"`
	Model     string          `json:"model"`
	PermMode  string          `json:"permissionMode"`
	Status    *string         `json:"status"`
	Compact   string          `json:"compact_result"`
	ToolName  string          `json:"tool_name"`
	Event     json.RawMessage `json:"event"`
	Message   json.RawMessage `json:"message"`
	RequestID string          `json:"request_id"`
	Request   json.RawMessage `json:"request"`
	Response  json.RawMessage `json:"response"`
	NewConv   string          `json:"new_conversation_id"`
	// result
	IsError    bool                        `json:"is_error"`
	Result     string                      `json:"result"`
	CostUSD    float64                     `json:"total_cost_usd"`
	Usage      *claudeUsage                `json:"usage"`
	RateLimit  *claudeRateLimit            `json:"rate_limit_info"`
	ModelUsage map[string]claudeModelUsage `json:"modelUsage"`
	TermReason string                      `json:"terminal_reason"`
	StopReason string                      `json:"stop_reason"`
}

// claudeRateLimit 은 `rate_limit_event` 가 싣는 플랜 한도다 (M9_SRS FR-M9-34).
//
// **`unifiedWindows` 는 키가 가변이다** — 지금 오는 것은 `five_hour`·`seven_day` 이나
// 그 목록이 계약은 아니다. 그래서 map 으로 받고 `ProtoLimit` 목록으로 옮긴다.
// 값은 **총량 없이 비율만** 준다 (`utilization` 0.0~1.0).
//
// 종전에는 이 프레임을 `return nil, true` 로 **알아본 뒤 버렸다.** 그래서 D-M9-22 가
// "프로토콜이 주지 않는다" 를 적었고 그 문장이 틀렸다 (`M9_PROGRESS` §2-23).
type claudeRateLimit struct {
	Windows map[string]claudeRateWindow `json:"unifiedWindows"`
}

type claudeRateWindow struct {
	Utilization float64 `json:"utilization"`
	ResetsAt    int64   `json:"resetsAt"`
}

// limits 는 가변 키의 map 을 **결정적 순서의** 목록으로 옮긴다.
//
// 정렬이 없으면 map 순회의 무작위성이 그대로 화면 순서가 되어, 같은 값이 매번 다른
// 자리에 선다. 짧은 주기가 먼저다(`ResetAt` 오름차순) — 사용자가 먼저 볼 것이 그것이다.
// 같은 시각이면 이름으로 가른다.
func (rl *claudeRateLimit) limits() []ProtoLimit {
	if rl == nil || len(rl.Windows) == 0 {
		return nil
	}
	out := make([]ProtoLimit, 0, len(rl.Windows))
	for kind, w := range rl.Windows {
		out = append(out, ProtoLimit{Kind: kind, Ratio: w.Utilization, ResetAt: w.ResetsAt})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ResetAt != out[j].ResetAt {
			return out[i].ResetAt < out[j].ResetAt
		}
		return out[i].Kind < out[j].Kind
	})
	return out
}

type claudeUsage struct {
	Input      int64 `json:"input_tokens"`
	CacheWrite int64 `json:"cache_creation_input_tokens"`
	CacheRead  int64 `json:"cache_read_input_tokens"`
	Output     int64 `json:"output_tokens"`
}

func (u *claudeUsage) context() int64 {
	if u == nil {
		return 0
	}
	return u.Input + u.CacheWrite + u.CacheRead
}

type claudeModelUsage struct {
	CostUSD       float64 `json:"costUSD"`
	ContextWindow int64   `json:"contextWindow"`
}

// claudeDecode 는 stdout 한 줄을 공통 이벤트로 옮긴다 (FR-APS-2·3). 아는 프레임인데
// 이벤트가 없으면 (nil, true), 모르는 프레임은 (nil, false) 다 (FR-APS-8).
func claudeDecode(line []byte, st *ProtoState) ([]Event, bool) {
	var fr claudeFrame
	if err := json.Unmarshal(line, &fr); err != nil || fr.Type == "" {
		return nil, false
	}
	x := claudeExtOf(st)
	switch fr.Type {
	case "system":
		return claudeDecodeSystem(fr, x, st)
	case "stream_event":
		return claudeDecodeStream(fr, x)
	case "assistant":
		var m struct {
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(fr.Message, &m); err != nil {
			return nil, false
		}
		return []Event{{Kind: EvMessage, SessionID: fr.SessionID, Message: m.Content}}, true
	case "user":
		return claudeDecodeUser(fr)
	case "result":
		x.inTurn = false
		u := &ProtoUsage{Tokens: fr.Usage.context(), CostUSD: fr.CostUSD}
		if fr.Usage != nil {
			u.OutputTokens = fr.Usage.Output
			// FR-M9-34: 오는데 버리던 둘. `Tokens` 는 이 둘을 합산한 채로 두므로
			// 기존 컨텍스트 % 의 뜻이 바뀌지 않는다.
			u.CacheRead, u.CacheWrite = fr.Usage.CacheRead, fr.Usage.CacheWrite
		}
		if name, mu, ok := claudePickModelUsage(fr.ModelUsage); ok {
			u.Model, u.ContextWindow = name, mu.ContextWindow
		}
		reason := fr.TermReason
		if reason == "" {
			reason = fr.Subtype
		}
		return []Event{
			{Kind: EvUsage, SessionID: fr.SessionID, Usage: u},
			{Kind: EvTurnEnd, SessionID: fr.SessionID, Text: reason, IsError: fr.IsError},
		}, true
	case "control_request":
		return claudeDecodeControlRequest(fr, st)
	case "control_response":
		return claudeDecodeControlResponse(fr, x, st)
	case "conversation_reset":
		if fr.NewConv == "" {
			return nil, false
		}
		st.SessionID = fr.NewConv
		return []Event{{Kind: EvReset, SessionID: fr.NewConv}}, true
	case "rate_limit_event":
		// FR-M9-34: 종전에는 여기서 버렸다. 한도를 말하지 않는 판(빈 창 목록)에서는
		// **아무것도 내지 않는다** — 빈 목록을 이벤트로 내면 받는 쪽이 "한도가 0" 과
		// "한도를 모른다" 를 가르지 못한다 (FR-CBG-5).
		lim := fr.RateLimit.limits()
		if len(lim) == 0 {
			return nil, true
		}
		return []Event{{Kind: EvUsage, SessionID: fr.SessionID,
			Usage: &ProtoUsage{Limits: lim}}}, true
	}
	return nil, false
}

func claudeDecodeSystem(fr claudeFrame, x *claudeExt, st *ProtoState) ([]Event, bool) {
	switch fr.Subtype {
	case "init":
		if fr.SessionID != "" {
			st.SessionID = fr.SessionID
		}
		return []Event{{Kind: EvSession, SessionID: fr.SessionID,
			Status: &ProtoStatus{Model: fr.Model, PermissionMode: fr.PermMode}}}, true
	case "status":
		var evs []Event
		if fr.Status != nil && *fr.Status == "requesting" && !x.inTurn {
			x.inTurn = true
			evs = append(evs, Event{Kind: EvTurnStart, SessionID: fr.SessionID})
		}
		if fr.PermMode != "" {
			evs = append(evs, Event{Kind: EvStatus, SessionID: fr.SessionID, Status: &ProtoStatus{PermissionMode: fr.PermMode}})
		}
		if fr.Compact != "" {
			evs = append(evs, Event{Kind: EvStatus, SessionID: fr.SessionID, Status: &ProtoStatus{Compacted: true}})
		}
		return evs, true
	case "compact_boundary":
		return []Event{{Kind: EvStatus, SessionID: fr.SessionID, Status: &ProtoStatus{Compacted: true}}}, true
	case "permission_denied":
		return []Event{{Kind: EvError, SessionID: fr.SessionID, Tool: fr.ToolName, Text: "permission_denied"}}, true
	case "hook_started", "hook_progress", "hook_response", "thinking_tokens":
		return nil, true
	}
	return nil, false
}

func claudeDecodeStream(fr claudeFrame, x *claudeExt) ([]Event, bool) {
	var ev struct {
		Type    string `json:"type"`
		Index   int    `json:"index"`
		Message *struct {
			Model string       `json:"model"`
			Usage *claudeUsage `json:"usage"`
		} `json:"message"`
		Block *struct {
			Type string `json:"type"`
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"content_block"`
		Delta *struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"delta"`
	}
	if err := json.Unmarshal(fr.Event, &ev); err != nil {
		return nil, false
	}
	switch ev.Type {
	case "message_start":
		var evs []Event
		if !x.inTurn {
			x.inTurn = true
			evs = append(evs, Event{Kind: EvTurnStart, SessionID: fr.SessionID})
		}
		if ev.Message != nil && ev.Message.Usage != nil {
			mu := ev.Message.Usage
			evs = append(evs, Event{Kind: EvUsage, SessionID: fr.SessionID,
				Usage: &ProtoUsage{Tokens: mu.context(), Model: ev.Message.Model,
					CacheRead: mu.CacheRead, CacheWrite: mu.CacheWrite}})
		}
		return evs, true
	case "content_block_start":
		if ev.Block != nil && ev.Block.Type == "tool_use" {
			return []Event{{Kind: EvToolStart, SessionID: fr.SessionID, Tool: ev.Block.Name, ToolUseID: ev.Block.ID}}, true
		}
		return nil, true
	case "content_block_delta":
		if ev.Delta == nil {
			return nil, true
		}
		switch ev.Delta.Type {
		case "text_delta":
			return []Event{{Kind: EvTextDelta, SessionID: fr.SessionID, Text: ev.Delta.Text}}, true
		case "thinking_delta":
			return []Event{{Kind: EvThinkingDelta, SessionID: fr.SessionID, Text: ev.Delta.Thinking}}, true
		case "input_json_delta", "signature_delta":
			return nil, true
		}
		return nil, false
	case "content_block_stop", "message_delta", "message_stop":
		return nil, true
	}
	return nil, false
}

// claudeDecodeUser 는 도구 결과(배열 content)와 로컬 명령 출력(문자열 content)을 가른다.
func claudeDecodeUser(fr claudeFrame) ([]Event, bool) {
	var m struct {
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(fr.Message, &m); err != nil {
		return nil, false
	}
	var text string
	if json.Unmarshal(m.Content, &text) == nil {
		return []Event{{Kind: EvUser, SessionID: fr.SessionID, Text: text}}, true
	}
	var items []struct {
		Type      string          `json:"type"`
		ToolUseID string          `json:"tool_use_id"`
		Content   json.RawMessage `json:"content"`
		IsError   bool            `json:"is_error"`
		Text      string          `json:"text"`
	}
	if err := json.Unmarshal(m.Content, &items); err != nil {
		return nil, false
	}
	var evs []Event
	for _, it := range items {
		switch it.Type {
		case "tool_result":
			evs = append(evs, Event{Kind: EvToolEnd, SessionID: fr.SessionID, ToolUseID: it.ToolUseID,
				Text: claudeResultText(it.Content), IsError: it.IsError})
		case "text":
			evs = append(evs, Event{Kind: EvUser, SessionID: fr.SessionID, Text: it.Text})
		}
	}
	return evs, true
}

// claudeResultText 는 tool_result 의 content — 문자열 또는 {type:text} 배열 — 를 글자로.
func claudeResultText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var items []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &items) != nil {
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

// claudePickModelUsage 는 `result.modelUsage` 에서 대표 항목을 고른다 — 보통 하나다.
// 둘 이상이면 이름순 첫 것이다 (결정적).
func claudePickModelUsage(m map[string]claudeModelUsage) (string, claudeModelUsage, bool) {
	if len(m) == 0 {
		return "", claudeModelUsage{}, false
	}
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	return names[0], m[names[0]], true
}

// claudeDecodeControlRequest 는 CLI→호스트 요청이다. 아는 것은 `can_use_tool` 하나
// (FR-APS-10) — 승인과 질문이 같은 통로로 온다 (FR-AGT-4).
func claudeDecodeControlRequest(fr claudeFrame, st *ProtoState) ([]Event, bool) {
	var req struct {
		Subtype     string            `json:"subtype"`
		ToolName    string            `json:"tool_name"`
		Input       json.RawMessage   `json:"input"`
		Description string            `json:"description"`
		Suggestions []json.RawMessage `json:"permission_suggestions"`
		ToolUseID   string            `json:"tool_use_id"`
	}
	if err := json.Unmarshal(fr.Request, &req); err != nil || req.Subtype != "can_use_tool" || fr.RequestID == "" {
		return nil, false
	}
	ar := ApprovalRequest{ID: fr.RequestID, Kind: ApprovalPermission, Tool: req.ToolName,
		Description: req.Description, Input: req.Input, ToolUseID: req.ToolUseID,
		Detail: claudeToolDetail(req.ToolName, req.Input)}
	var q struct {
		Questions []Question `json:"questions"`
	}
	if json.Unmarshal(req.Input, &q) == nil && len(q.Questions) > 0 {
		ar.Kind = ApprovalQuestion
		ar.Questions = q.Questions
		if ar.Detail == "" {
			ar.Detail = q.Questions[0].Question
		}
	} else {
		ar.Options = []ApprovalOption{{ID: ChoiceAllow, Label: ChoiceAllow}, {ID: ChoiceDeny, Label: ChoiceDeny}}
		for i, s := range req.Suggestions {
			ar.Options = append(ar.Options, ApprovalOption{ID: "suggestion:" + strconv.Itoa(i), Label: claudeSuggestionLabel(s), Raw: s})
		}
	}
	st.Open[ar.ID] = ar
	return []Event{{Kind: EvApprovalOpen, SessionID: st.SessionID, Tool: ar.Tool, Detail: ar.Detail, Approval: &ar}}, true
}

// claudeSuggestionLabel 은 제안 항목의 내용을 한 줄로 — 프로토콜의 어휘 그대로다.
func claudeSuggestionLabel(raw json.RawMessage) string {
	var s struct {
		Type        string   `json:"type"`
		Mode        string   `json:"mode"`
		Directories []string `json:"directories"`
		Destination string   `json:"destination"`
		Rules       []struct {
			ToolName    string `json:"toolName"`
			RuleContent string `json:"ruleContent"`
		} `json:"rules"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return string(raw)
	}
	var what string
	switch s.Type {
	case "setMode":
		what = s.Mode
	case "addDirectories":
		what = strings.Join(s.Directories, ", ")
	case "addRules":
		parts := make([]string, 0, len(s.Rules))
		for _, r := range s.Rules {
			if r.RuleContent != "" {
				parts = append(parts, r.ToolName+"("+r.RuleContent+")")
			} else {
				parts = append(parts, r.ToolName)
			}
		}
		what = strings.Join(parts, ", ")
	default:
		return string(raw)
	}
	if s.Destination != "" {
		return s.Type + " " + what + " (" + s.Destination + ")"
	}
	return s.Type + " " + what
}

// claudeDecodeControlResponse 는 우리가 보낸 제어의 답이다. 대기표에 없는 request_id
// 는 모르는 프레임이다 (FR-APS-8).
func claudeDecodeControlResponse(fr claudeFrame, x *claudeExt, st *ProtoState) ([]Event, bool) {
	var resp struct {
		Subtype   string          `json:"subtype"`
		RequestID string          `json:"request_id"`
		Error     string          `json:"error"`
		Response  json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(fr.Response, &resp); err != nil {
		return nil, false
	}
	p, ok := x.pending[resp.RequestID]
	if !ok {
		return nil, false
	}
	delete(x.pending, resp.RequestID)
	if resp.Subtype == "error" {
		return []Event{{Kind: EvError, Text: p.subtype + ": " + resp.Error}}, true
	}
	switch p.subtype {
	case "initialize":
		var r struct {
			Commands []struct {
				Name string `json:"name"`
			} `json:"commands"`
			Models  []ModelChoice `json:"models"`
			Account *struct {
				Email        string `json:"email"`
				Subscription string `json:"subscriptionType"`
			} `json:"account"`
			PermMode string `json:"current_permission_mode"`
		}
		if err := json.Unmarshal(resp.Response, &r); err != nil {
			return nil, false
		}
		s := &ProtoStatus{Models: r.Models, PermissionMode: r.PermMode}
		for _, c := range r.Commands {
			s.Commands = append(s.Commands, c.Name)
		}
		if r.Account != nil {
			s.Account = strings.TrimSpace(r.Account.Email + " " + r.Account.Subscription)
		}
		// EvSession 인데 SessionID 가 빈 이유 (M8_UNIFIED_SRS D-C-16): 실제 claude 의
		// `system:init` 은 첫 프롬프트 뒤에 온다 — 첫 턴 전에는 신원이 없다. 그러나 이
		// 응답이 왔으면 프롬프트를 받을 준비는 됐다(`idle`). 신원은 부재로 둔다 (FR-APS-4);
		// 재개(`--resume`)로 띄웠으면 호출자가 이미 안다.
		return []Event{{Kind: EvSession, SessionID: st.SessionID, Status: s}}, true
	case "set_model":
		return []Event{{Kind: EvStatus, Status: &ProtoStatus{Model: p.value}}}, true
	case "set_permission_mode":
		return []Event{{Kind: EvStatus, Status: &ProtoStatus{PermissionMode: p.value}}}, true
	}
	// interrupt · set_max_thinking_tokens: 성공이면 알릴 것이 없다.
	return nil, true
}
