package agentadapter

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `claude_proto.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **들어오는 프레임을 읽는 일**이다. `claude_proto.go` 에 남은 것은
// **내보내는 일**(기동줄·핸드셰이크·프롬프트·승인·제어)이며, 프레임 스키마가 바뀌면
// 이쪽만 흔들린다 (FR-APS-7 — 바뀌면 이 파일 하나가 흡수한다).

// claudeDecode 는 stdout 한 줄을 공통 이벤트로 옮긴다 (FR-APS-2·3). 아는 프레임인데
// 이벤트가 없으면 (nil, true), 모르는 프레임은 (nil, false) 다 (FR-APS-8).
func claudeDecode(line []byte, st *ProtoState) ([]Event, bool) {
	var fr claudeFrame
	if err := json.Unmarshal(line, &fr); err != nil || fr.Type == "" {
		return nil, false
	}
	evs, ok := claudeDecodeFrame(fr, st)
	/**
	 * M11_SRS FR-M11-49 (M11-B49): **주인은 한 자리에서 단다.**
	 *
	 * 서브에이전트의 진행은 같은 스트림으로 오고 `parent_tool_use_id` 만이 그것을
	 * 가른다. 갈래마다 적으면 새 갈래가 생길 때 조용히 빠지므로 — 이 물결에서만
	 * 그런 자리를 셋 겪었다 — **나가는 길 하나**에서 일괄로 단다.
	 */
	if fr.ParentToolUse != "" {
		for i := range evs {
			evs[i].ParentToolUseID = fr.ParentToolUse
		}
	}
	return evs, ok
}

func claudeDecodeFrame(fr claudeFrame, st *ProtoState) ([]Event, bool) {
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
		// FR-M12-1~3: 블록을 공통 어휘로 옮긴다 — 브라우저가 claude 의 입력 키를
		// 알지 않아도 되게 한다.
		return []Event{{Kind: EvMessage, SessionID: fr.SessionID, Message: claudeAnnotateBlocks(m.Content)}}, true
	case "user":
		return claudeDecodeUser(fr)
	case "result":
		x.inTurn = false
		/**
		 * M12_SRS FR-M12-11 (V-M12-27): **컨텍스트는 마지막 요청의 것이다.**
		 *
		 * 최상위 `usage` 는 **턴 안의 요청들을 합한 값**이라 컨텍스트로 쓸 수 없다
		 * (실측 2026-09-16: 도구 셋을 쓴 턴에서 합 103574 · 순간 26051). 긴 세션에서
		 * 그 합이 창을 훌쩍 넘고, 접수한 *"462%"* 가 그 몫이다.
		 *
		 * **캐시도 같은 요청의 것을 싣는다** — 그래야 `Tokens = Input+CacheWrite+
		 * CacheRead` 가 화면에서 성립한다. 한쪽만 옮기면 나란히 적힌 수가 서로를
		 * 부정한다.
		 *
		 * **출력과 비용은 턴의 합이 옳다**: 그것은 *이 턴이 얼마를 썼나* 이지
		 * *지금 컨텍스트가 얼마인가* 가 아니다. 둘을 같은 규칙으로 밀지 않는다.
		 */
		last := fr.Usage.last()
		u := &ProtoUsage{Tokens: last.context(), CostUSD: fr.CostUSD}
		if last != nil {
			u.CacheRead, u.CacheWrite = last.CacheRead, last.CacheWrite
		}
		if fr.Usage != nil {
			u.OutputTokens = fr.Usage.Output
		}
		if name, mu, ok := claudePickModelUsage(fr.ModelUsage, x.model); ok {
			u.Model, u.ContextWindow = name, mu.ContextWindow
		}
		reason := fr.TermReason
		if reason == "" {
			reason = fr.Subtype
		}
		return []Event{
			{Kind: EvUsage, SessionID: fr.SessionID, Usage: u},
			{Kind: EvTurnEnd, SessionID: fr.SessionID, Text: reason, Outcome: claudeTurnOutcome(reason, fr.IsError)},
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
		// FR-M12-6: `modelUsage` 의 키와 같은 이름이 여기서만 온다.
		if fr.Model != "" {
			x.model = fr.Model
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
			// FR-M11-28: 추론 델타가 **실제로 싣는 것**이다 (실측 §2.11 (1)).
			// `thinking` 은 빈 문자열로 오고 이 수만 움직인다.
			Tokens int64 `json:"estimated_tokens"`
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
		// FR-M12-6: `init` 이 아직 안 왔으면 이 이름이라도 들고 있는다 — 정본 이름이라
		// `canonicalModel` 로 되짚는다. **키 이름을 덮지 않는다**: init 쪽이 더 정확하다.
		if ev.Message != nil && ev.Message.Model != "" && x.model == "" {
			x.model = ev.Message.Model
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
			return []Event{{Kind: EvThinkingDelta, SessionID: fr.SessionID,
				Text: ev.Delta.Thinking, ThinkingTokens: ev.Delta.Tokens}}, true
		case "input_json_delta", "signature_delta":
			return nil, true
		}
		return nil, false
	case "content_block_stop", "message_delta", "message_stop":
		return nil, true
	}
	return nil, false
}

// claudeHarnessPrefixes 는 하네스가 사용자의 자리에 끼우는 것들이다
// (M11_SRS FR-M11-25 / M11-B23).
//
// **실측한 목록이고 추측이 없다** (§2.11 (6)): 사용자의 전사본 여덟 벌(최대 2448줄)의
// `user` 항목을 전수로 훑어 센 여섯 종이다. 목록을 늘리려면 같은 방법으로 세고 여기에
// 적는다 — 형식을 짐작해 더하면 사용자의 진짜 말이 조용히 사라진다.
var claudeHarnessPrefixes = []string{
	"<local-command-caveat>",
	"<local-command-stdout>",
	"<command-name>",
	"<command-message>",
	"<command-args>",
	"<task-notification>",
	"[Request interrupted by user",
}

// claudeHarnessText 는 그 글이 하네스의 것인가다.
//
// **첫 토큰으로 판정한다.** 실측에서 여섯 전부 자기 항목을 통째로 차지했고 사용자의
// 말과 섞인 경우가 없었다. 그래서 **항목을 통째로 버리거나 통째로 남기거나** 둘 중
// 하나이며, 본문을 잘라 내는 손을 만들지 않는다 — 그 손은 사용자가 마커를 인용한 글을
// 함께 자른다.
func claudeHarnessText(s string) bool {
	t := strings.TrimSpace(s)
	for _, p := range claudeHarnessPrefixes {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
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
		if claudeHarnessText(text) {
			return nil, true
		}
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
			if claudeHarnessText(it.Text) {
				continue
			}
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

// claudePickModelUsage 는 `result.modelUsage` 에서 **이 세션의 모델**을 고른다
// (M12_SRS FR-M12-6 / V-M12-15~17).
//
// **종전 주석은 *"보통 하나다"* 였고 그것이 틀렸다** (실측 2026-09-16): claude Code 가
// 제목 생성 등에 haiku 를 함께 쓰므로 항목이 거의 언제나 **둘**이다.
//
//	claude-haiku-4-5-20251001  contextWindow  200000
//	claude-opus-5[1m]          contextWindow 1000000
//
// 종전 코드는 사전순 첫 항목을 골랐고(`h` < `o`), 그래서 **opus 대화의 토큰을 haiku 의
// 창으로 나누었다** — 접수한 *"300% 넘게"* 가 그 몫이다. 분자(`usage`)는 턴별이라
// 옳았고 틀린 것은 분모다.
//
// 되짚는 손이 둘인 것은 이름이 자리마다 다르기 때문이다 — `init` 은 키와 같은
// `claude-opus-5[1m]`, `message_start` 는 정본 `claude-opus-5` 를 준다.
//
// **못 찾으면 고르지 않는다** (D-M12-3): 남의 창으로 그리느니 창을 비운다. 그때
// 화면은 토큰만 적는다 (`agent.ctx_unknown`) — 그것이 300% 보다 정확하다.
func claudePickModelUsage(m map[string]claudeModelUsage, model string) (string, claudeModelUsage, bool) {
	if len(m) == 0 {
		return "", claudeModelUsage{}, false
	}
	if model == "" {
		// 세션 모델을 아직 모른다 (`init` 전). 항목이 하나뿐이면 그것이 그 턴의
		// 전부이므로 고르고, 여럿이면 **고르지 않는다** — 사전순으로 집던 종전
		// 동작이 곧 이 결함이었다.
		if len(m) == 1 {
			for k, v := range m {
				return k, v, true
			}
		}
		return "", claudeModelUsage{}, false
	}
	if v, ok := m[model]; ok {
		return model, v, true
	}
	// 키가 안 맞으면 정본 이름으로 되짚는다. 여러 항목이 같은 정본을 말할 수는
	// 없으나(판마다 키가 다르다) 순서를 고정해 결정적으로 고른다.
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		if m[k].CanonicalModel == model {
			return k, m[k], true
		}
	}
	return "", claudeModelUsage{}, false
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
			// FR-M9-45: **이름만 받던 자리다.** `description`·`argumentHint` 가
			// 함께 오는 것을 실측으로 확인했고(2026-09-14), 그것이 화면에서
			// "무엇을 넣어야 하는가" 를 말한다.
			Commands []ProtoCommand `json:"commands"`
			Models   []ModelChoice  `json:"models"`
			Account  *struct {
				Email        string `json:"email"`
				Subscription string `json:"subscriptionType"`
			} `json:"account"`
			PermMode string `json:"current_permission_mode"`
		}
		if err := json.Unmarshal(resp.Response, &r); err != nil {
			return nil, false
		}
		// FR-M12-4: 고르는 화면이 서는 명령에 **선언을 단다.** 종전에는 그 사실이
		// 화면의 정규식에 적혀 있었다 (누수 L5).
		s := &ProtoStatus{Models: r.Models, PermissionMode: r.PermMode, Commands: claudeAttachForms(r.Commands)}
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

// claudeParseHistory 는 전사본 JSONL 한 줄의 뜻이다 (M9_SRS FR-M9-41).
//
// **스트림과 전사본은 형식이 겹친다** (실측 2026-09-14): 전사본의 `user`·`assistant`
// 줄은 `message` 아래에 스트림과 같은 모양의 content 를 싣는다. 그래서 여기서 하는
// 일은 옮기는 것이 아니라 **고르는 것**이다 — 그 둘만 통과시키고 나머지는 모르는
// 줄로 둔다.
//
// `claudeDecode` 를 그대로 부르지 않는 이유는 그것이 `ProtoState` 를 **고치기**
// 때문이다 (`claudeExtOf`·`st.SessionID`·`st.Open`). 기록을 읽는 일은 살아 있는
// 세션의 상태를 건드리지 않아야 한다 — 과거의 신원이 현재를 덮으면 재개한 세션이
// 자기가 누구인지 잃는다.
//
// 통과시키지 않는 것들 (실측한 전사본의 나머지): `attachment` · `file-history-snapshot` ·
// `summary` · `system` · `queue-operation` · `cost-state`. 살림살이는 대화가 아니다.
func claudeParseHistory(line string) ([]Event, bool) {
	var fr claudeFrame
	if err := json.Unmarshal([]byte(line), &fr); err != nil {
		return nil, false
	}
	switch fr.Type {
	case "assistant":
		var m struct {
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(fr.Message, &m); err != nil || len(m.Content) == 0 {
			return nil, false
		}
		// 재생(전사본)도 같은 어휘여야 한다 — 두 길이 다른 것을 주면 화면이 갈린다.
		return []Event{{Kind: EvMessage, Message: claudeAnnotateBlocks(m.Content)}}, true
	case "user":
		evs, ok := claudeDecodeUser(fr)
		if !ok || len(evs) == 0 {
			return nil, false
		}
		return evs, true
	}
	return nil, false
}

// claudeTurnOutcome 은 claude 의 종료 사유를 공통 어휘로 옮긴다 (M12_SRS FR-M12-23).
//
// **`is_error` 로는 가를 수 없다** (실측 2026-09-16): 사용자가 `Esc` 로 끊은 턴도,
// 도구를 거절한 턴도 `is_error:true` 에 `subtype:"error_during_execution"` 으로 온다.
// 가르는 것은 `terminal_reason` 이며 CLI 2.1.273 의 어휘가 접두사로 이미 갈라 준다:
//
//	aborted_streaming · aborted_tools · aborted_by_mock   ← 사람이 멈췄다
//	error_during_execution · error_max_turns · error_max_budget_usd
//	  · error_max_structured_output_retries               ← 오류
//
// 접두사로 보는 이유는 **어휘가 는다**는 것이 이번 결함의 원인이기 때문이다 —
// `aborted_tools` 는 종전 열거에 없어 오류로 떨어졌다. 모르는 사유는 `is_error` 가
// 마지막 갈래이며, 그것마저 없으면 끝까지 간 것이다.
func claudeTurnOutcome(reason string, isErr bool) TurnOutcome {
	switch {
	case strings.HasPrefix(reason, "aborted"):
		return OutcomeStopped
	case strings.HasPrefix(reason, "error"), isErr:
		return OutcomeError
	}
	return OutcomeCompleted
}
