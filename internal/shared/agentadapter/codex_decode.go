package agentadapter

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `codex_proto.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **들어오는 프레임을 읽는 일**이다 (JSON-RPC 응답·통지·서버 요청).
// `codex_proto.go` 에 남은 것은 내보내는 일이며, 스키마가 바뀌면 이쪽만 흔들린다.

// codexFrame 은 세 방향의 합집합이다.
type codexFrame struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (f codexFrame) hasID() bool {
	return len(f.ID) > 0 && !bytes.Equal(f.ID, []byte("null"))
}

// codexIDKey 는 원문 id 의 문자열 키다 — 숫자 5 와 문자열 "5" 가 같은 키를 갖지만 한
// 프로세스 안에서 codex 는 한 종류만 쓴다.
func codexIDKey(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(bytes.TrimSpace(raw))
}

// codexDecode 는 한 줄을 공통 이벤트로 옮긴다 (FR-APS-2·3·8).
func codexDecode(line []byte, st *ProtoState) ([]Event, bool) {
	var fr codexFrame
	if err := json.Unmarshal(line, &fr); err != nil {
		return nil, false
	}
	x := codexExtOf(st)
	switch {
	case fr.Method != "" && fr.hasID():
		return codexDecodeServerRequest(fr, x, st)
	case fr.Method != "":
		return codexDecodeNotification(fr, x, st)
	case fr.hasID():
		return codexDecodeResponse(fr, x, st)
	}
	return nil, false
}

// codexDecodeResponse 는 우리 요청의 답이다. 대기표에 없는 id 는 모르는 프레임이다.
func codexDecodeResponse(fr codexFrame, x *codexExt, st *ProtoState) ([]Event, bool) {
	key := codexIDKey(fr.ID)
	p, ok := x.pending[key]
	if !ok {
		return nil, false
	}
	delete(x.pending, key)
	if fr.Error != nil {
		// 살아 있는 프로세스에 핸드셰이크를 다시 보내면(서버 재시동의 채택, D-C-14) `initialize` 만
		// "Already initialized" 로 거절된다 — 그 뒤 `thread/resume`·`model/list` 는 정상이다 (P5
		// 실측). 그 한 오류는 부재다.
		if p.method == "initialize" && strings.Contains(fr.Error.Message, "Already initialized") {
			return nil, true
		}
		return []Event{{Kind: EvError, SessionID: st.SessionID, Text: p.method + ": " + fr.Error.Message}}, true
	}
	switch p.method {
	case "thread/start", "thread/resume":
		var r struct {
			Thread struct {
				ID    string `json:"id"`
				Model string `json:"model"`
			} `json:"thread"`
			Model          string          `json:"model"`
			ApprovalPolicy json.RawMessage `json:"approvalPolicy"`
		}
		if err := json.Unmarshal(fr.Result, &r); err != nil || r.Thread.ID == "" {
			return nil, false
		}
		x.threadID = r.Thread.ID
		st.SessionID = r.Thread.ID
		model := r.Model
		if model == "" {
			model = r.Thread.Model
		}
		return []Event{{Kind: EvSession, SessionID: r.Thread.ID,
			Status: &ProtoStatus{Model: model, PermissionMode: codexApprovalWord(r.ApprovalPolicy)}}}, true
	case "model/list":
		var r struct {
			Data []struct {
				ID          string `json:"id"`
				Model       string `json:"model"`
				DisplayName string `json:"displayName"`
				Description string `json:"description"`
				Hidden      bool   `json:"hidden"`
			} `json:"data"`
		}
		if err := json.Unmarshal(fr.Result, &r); err != nil {
			return nil, false
		}
		s := &ProtoStatus{}
		for _, m := range r.Data {
			if m.Hidden {
				continue
			}
			v := m.Model
			if v == "" {
				v = m.ID
			}
			s.Models = append(s.Models, ModelChoice{Value: v, DisplayName: m.DisplayName, Description: m.Description})
		}
		if len(s.Models) == 0 {
			return nil, true
		}
		return []Event{{Kind: EvStatus, SessionID: st.SessionID, Status: s}}, true
	case "turn/start":
		var r struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if json.Unmarshal(fr.Result, &r) == nil && r.Turn.ID != "" {
			x.turnID = r.Turn.ID
		}
		return nil, true
	}
	// initialize · turn/interrupt: 성공이면 알릴 것이 없다.
	return nil, true
}

// codexApprovalWord 는 `AskForApproval` 을 한 단어로 — 문자열이면 그대로, `granular`
// 객체면 그 이름이다.
func codexApprovalWord(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	if len(raw) > 0 && bytes.Contains(raw, []byte("granular")) {
		return "granular"
	}
	return ""
}

// codexDecodeNotification 은 서버의 알림이다. 아는 것은 이벤트로, 나머지 알림은 아는
// 프레임이되 이벤트가 없다 (nil, true) — JSON-RPC 알림은 스키마가 아는 형태다.
func codexDecodeNotification(fr codexFrame, x *codexExt, st *ProtoState) ([]Event, bool) {
	sid := st.SessionID
	switch fr.Method {
	case "turn/started":
		var p struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		_ = json.Unmarshal(fr.Params, &p)
		if p.Turn.ID != "" {
			x.turnID = p.Turn.ID
		}
		if x.inTurn {
			return nil, true
		}
		x.inTurn = true
		return []Event{{Kind: EvTurnStart, SessionID: sid}}, true
	case "turn/completed":
		var p struct {
			Turn struct {
				Status string `json:"status"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"turn"`
		}
		_ = json.Unmarshal(fr.Params, &p)
		x.inTurn = false
		// FR-M12-23: 종류는 **상태**에서 나온다 — 아래에서 Text 가 오류 문장으로
		// 갈릴 수 있으므로, 문장을 보는 갈래는 메시지가 바뀔 때마다 틀린다.
		ev := Event{Kind: EvTurnEnd, SessionID: sid, Text: p.Turn.Status, Outcome: codexTurnOutcome(p.Turn.Status)}
		if p.Turn.Error != nil && p.Turn.Error.Message != "" {
			ev.Text = p.Turn.Error.Message
		}
		return []Event{ev}, true
	case "error":
		var p struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
			WillRetry bool `json:"willRetry"`
		}
		if err := json.Unmarshal(fr.Params, &p); err != nil {
			return nil, false
		}
		text := p.Error.Message
		if p.WillRetry {
			text += " (retrying)"
		}
		return []Event{{Kind: EvError, SessionID: sid, Text: text}}, true
	case "item/started", "item/completed":
		return codexDecodeItem(fr, x, sid)
	case "item/agentMessage/delta":
		var p struct {
			Delta string `json:"delta"`
		}
		_ = json.Unmarshal(fr.Params, &p)
		return []Event{{Kind: EvTextDelta, SessionID: sid, Text: p.Delta}}, true
	case "item/reasoning/summaryTextDelta", "item/reasoning/textDelta":
		var p struct {
			Delta string `json:"delta"`
		}
		_ = json.Unmarshal(fr.Params, &p)
		return []Event{{Kind: EvThinkingDelta, SessionID: sid, Text: p.Delta}}, true
	case "thread/tokenUsage/updated":
		var p struct {
			TokenUsage struct {
				Last struct {
					Input  int64 `json:"inputTokens"`
					Output int64 `json:"outputTokens"`
				} `json:"last"`
				ContextWindow int64 `json:"modelContextWindow"`
			} `json:"tokenUsage"`
		}
		if err := json.Unmarshal(fr.Params, &p); err != nil {
			return nil, false
		}
		u := p.TokenUsage
		return []Event{{Kind: EvUsage, SessionID: sid,
			Usage: &ProtoUsage{Tokens: u.Last.Input, OutputTokens: u.Last.Output, ContextWindow: u.ContextWindow}}}, true
	case "thread/settings/updated":
		var p struct {
			Settings struct {
				Model          string          `json:"model"`
				ApprovalPolicy json.RawMessage `json:"approvalPolicy"`
			} `json:"threadSettings"`
		}
		if err := json.Unmarshal(fr.Params, &p); err != nil {
			return nil, false
		}
		return []Event{{Kind: EvStatus, SessionID: sid,
			Status: &ProtoStatus{Model: p.Settings.Model, PermissionMode: codexApprovalWord(p.Settings.ApprovalPolicy)}}}, true
	case "thread/compacted":
		return []Event{{Kind: EvStatus, SessionID: sid, Status: &ProtoStatus{Compacted: true}}}, true
	case "serverRequest/resolved":
		// 우리가 답하지 않은 요청이 닫혔다 (턴 중단 등). 열려 있으면 닫는다.
		var p struct {
			RequestID json.RawMessage `json:"requestId"`
		}
		_ = json.Unmarshal(fr.Params, &p)
		key := codexIDKey(p.RequestID)
		req, open := st.Open[key]
		if !open {
			return nil, true
		}
		delete(st.Open, key)
		delete(x.reqIDs, key)
		delete(x.questions, key)
		return []Event{{Kind: EvApprovalClosed, SessionID: sid, Text: "resolved",
			Approval: &ApprovalRequest{ID: key, Kind: req.Kind, Tool: req.Tool}}}, true
	}
	return nil, true
}

// codexDecodeItem 은 `item/started`·`item/completed` 다. 종류마다 도구 호출·결과·메시지
// 스냅샷으로 옮기고, 승인 요청이 itemId 로 가리킬 내용을 남긴다.
func codexDecodeItem(fr codexFrame, x *codexExt, sid string) ([]Event, bool) {
	var p struct {
		Item struct {
			Type    string          `json:"type"`
			ID      string          `json:"id"`
			Text    string          `json:"text"`
			Command string          `json:"command"`
			Output  string          `json:"aggregatedOutput"`
			Exit    *int            `json:"exitCode"`
			Status  string          `json:"status"`
			Changes json.RawMessage `json:"changes"`
			Server  string          `json:"server"`
			Tool    string          `json:"tool"`
			Summary []string        `json:"summary"`
			Error   *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"item"`
	}
	if err := json.Unmarshal(fr.Params, &p); err != nil || p.Item.Type == "" {
		return nil, false
	}
	it := p.Item
	started := fr.Method == "item/started"
	switch it.Type {
	case "agentMessage":
		if started {
			return nil, true
		}
		b, _ := json.Marshal([]map[string]any{{"type": "text", "text": it.Text}})
		return []Event{{Kind: EvMessage, SessionID: sid, Message: b}}, true
	case "reasoning":
		if started || len(it.Summary) == 0 {
			return nil, true
		}
		b, _ := json.Marshal([]map[string]any{{"type": "thinking", "thinking": strings.Join(it.Summary, "\n")}})
		return []Event{{Kind: EvMessage, SessionID: sid, Message: b}}, true
	case "commandExecution":
		if started {
			x.items[it.ID] = codexItem{kind: it.Type, detail: it.Command}
			return []Event{{Kind: EvToolStart, SessionID: sid, Tool: it.Type, ToolUseID: it.ID, Detail: it.Command}}, true
		}
		delete(x.items, it.ID)
		isErr := it.Status == "failed" || (it.Exit != nil && *it.Exit != 0)
		return []Event{{Kind: EvToolEnd, SessionID: sid, Tool: it.Type, ToolUseID: it.ID, Text: it.Output, IsError: isErr}}, true
	case "fileChange":
		if started {
			paths := codexChangePaths(it.Changes)
			x.items[it.ID] = codexItem{kind: it.Type, detail: paths, changes: it.Changes}
			// M12_SRS FR-M12-2: 편집이라는 **사실**은 옮기고, 줄은 옮기지 않는다 —
			// codex 의 `changes` 는 경로만 준다 (D-M11-4: 주지 않는 값은 지어내지
			// 않는다). 화면은 `Added`·`Removed` 가 빈 것을 보고 파일 이름만 적는다.
			return []Event{{Kind: EvToolStart, SessionID: sid, Tool: it.Type, ToolUseID: it.ID,
				Detail: paths, Edit: &ToolEdit{File: paths}}}, true
		}
		delete(x.items, it.ID)
		return []Event{{Kind: EvToolEnd, SessionID: sid, Tool: it.Type, ToolUseID: it.ID, Text: it.Status, IsError: it.Status == "failed"}}, true
	case "mcpToolCall":
		name := it.Server + "/" + it.Tool
		if started {
			return []Event{{Kind: EvToolStart, SessionID: sid, Tool: name, ToolUseID: it.ID}}, true
		}
		text := it.Status
		if it.Error != nil {
			text = it.Error.Message
		}
		return []Event{{Kind: EvToolEnd, SessionID: sid, Tool: name, ToolUseID: it.ID, Text: text, IsError: it.Status == "failed" || it.Error != nil}}, true
	}
	// userMessage(우리가 보낸 것) · plan · webSearch · contextCompaction 등: 알림은 안다.
	return nil, true
}

// codexChangePaths 는 fileChange 의 경로들을 한 줄로.
func codexChangePaths(raw json.RawMessage) string {
	var ch []struct {
		Path string `json:"path"`
	}
	if json.Unmarshal(raw, &ch) != nil {
		return ""
	}
	parts := make([]string, 0, len(ch))
	for _, c := range ch {
		parts = append(parts, c.Path)
	}
	return strings.Join(parts, ", ")
}

// codexDecodeServerRequest 는 서버→클라 요청이다. 승인 셋과 질문 하나를 안다 — 나머지
// (`mcpServer/elicitation/request`·`item/tool/call`·`account/chatgptAuthTokens/refresh`·
// `attestation/generate`·옛 `applyPatchApproval`·`execCommandApproval`)는 모르는 프레임으로
// 남긴다 (FR-APS-8): 답이 가지 않아 codex 가 그 자리에서 기다린다는 사실이 원문으로 보인다.
func codexDecodeServerRequest(fr codexFrame, x *codexExt, st *ProtoState) ([]Event, bool) {
	key := codexIDKey(fr.ID)
	var p struct {
		ItemID    string            `json:"itemId"`
		Command   string            `json:"command"`
		Cwd       string            `json:"cwd"`
		Reason    string            `json:"reason"`
		GrantRoot string            `json:"grantRoot"`
		Amendment []string          `json:"proposedExecpolicyAmendment"`
		Perms     json.RawMessage   `json:"permissions"`
		Questions []json.RawMessage `json:"questions"`
	}
	if err := json.Unmarshal(fr.Params, &p); err != nil {
		return nil, false
	}
	ar := ApprovalRequest{ID: key, Kind: ApprovalPermission, ToolUseID: p.ItemID, Description: p.Reason}
	accept := func(extra ...ApprovalOption) {
		ar.Options = []ApprovalOption{
			{ID: ChoiceAllow, Label: "accept", Raw: json.RawMessage(`"accept"`)},
			{ID: ChoiceDeny, Label: "decline", Raw: json.RawMessage(`"decline"`)},
		}
		ar.Options = append(ar.Options, extra...)
	}
	sugg := func(i int, label string, raw string) ApprovalOption {
		return ApprovalOption{ID: "suggestion:" + strconv.Itoa(i), Label: label, Raw: json.RawMessage(raw)}
	}
	switch fr.Method {
	case "item/commandExecution/requestApproval":
		ar.Tool = "commandExecution"
		ar.Detail = p.Command
		if ar.Detail == "" {
			ar.Detail = x.items[p.ItemID].detail
		}
		in, _ := json.Marshal(map[string]any{"command": ar.Detail, "cwd": p.Cwd})
		ar.Input = in
		extra := []ApprovalOption{sugg(0, "acceptForSession", `"acceptForSession"`)}
		if len(p.Amendment) > 0 {
			am, _ := json.Marshal(map[string]any{"acceptWithExecpolicyAmendment": map[string]any{"execpolicy_amendment": p.Amendment}})
			extra = append(extra, sugg(1, "acceptWithExecpolicyAmendment "+strings.Join(p.Amendment, " "), string(am)))
		}
		extra = append(extra, sugg(len(extra), "cancel", `"cancel"`))
		accept(extra...)
	case "item/fileChange/requestApproval":
		ar.Tool = "fileChange"
		it := x.items[p.ItemID]
		ar.Detail = it.detail
		if p.GrantRoot != "" {
			ar.Detail = strings.TrimSpace(ar.Detail + " " + p.GrantRoot)
		}
		if len(it.changes) > 0 {
			in, _ := json.Marshal(map[string]any{"changes": it.changes})
			ar.Input = in
		}
		accept(sugg(0, "acceptForSession", `"acceptForSession"`), sugg(1, "cancel", `"cancel"`))
	case "item/permissions/requestApproval":
		ar.Tool = "permissions"
		ar.Detail = p.Reason
		ar.Input = p.Perms
		// 답은 `{permissions, scope}` 다 — 허용은 요청한 권한 그대로 turn 범위, 제안은 session 범위.
		turn, _ := json.Marshal(map[string]any{"permissions": p.Perms, "scope": "turn"})
		sess, _ := json.Marshal(map[string]any{"permissions": p.Perms, "scope": "session"})
		none, _ := json.Marshal(map[string]any{"permissions": map[string]any{}, "scope": "turn"})
		ar.Options = []ApprovalOption{
			{ID: ChoiceAllow, Label: "accept (turn)", Raw: turn},
			{ID: ChoiceDeny, Label: "decline", Raw: none},
			sugg(0, "accept (session)", string(sess)),
		}
	case "item/tool/requestUserInput":
		ar.Kind = ApprovalQuestion
		ar.Tool = "requestUserInput"
		qmap := map[string]string{}
		for _, raw := range p.Questions {
			var q struct {
				ID       string `json:"id"`
				Header   string `json:"header"`
				Question string `json:"question"`
				Options  []struct {
					Label       string `json:"label"`
					Description string `json:"description"`
				} `json:"options"`
			}
			if json.Unmarshal(raw, &q) != nil || q.Question == "" {
				continue
			}
			cq := Question{Question: q.Question, Header: q.Header, FreeText: len(q.Options) == 0}
			for _, o := range q.Options {
				cq.Options = append(cq.Options, QuestionOption{Label: o.Label, Description: o.Description})
			}
			ar.Questions = append(ar.Questions, cq)
			qmap[q.Question] = q.ID
		}
		if len(ar.Questions) == 0 {
			return nil, false
		}
		ar.Detail = ar.Questions[0].Question
		x.questions[key] = qmap
	default:
		return nil, false
	}
	x.reqIDs[key] = append(json.RawMessage(nil), fr.ID...)
	st.Open[key] = ar
	return []Event{{Kind: EvApprovalOpen, SessionID: st.SessionID, Tool: ar.Tool, Detail: ar.Detail, Approval: &ar}}, true
}

// codexTurnOutcome 은 codex 의 `turn.status` 를 공통 어휘로 옮긴다 (M12_SRS FR-M12-23).
// 어휘는 셋이다 — `completed`·`interrupted`·`failed` (§7: codex 는 실측하지 않았다 —
// 근거는 어댑터가 따르는 JSON 스키마다).
func codexTurnOutcome(status string) TurnOutcome {
	switch status {
	case "interrupted":
		return OutcomeStopped
	case "failed":
		return OutcomeError
	}
	return OutcomeCompleted
}
