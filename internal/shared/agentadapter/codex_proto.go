package agentadapter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// codex 의 프로토콜 표면 — `codex app-server`, stdio JSON-RPC 2.0 (M8_UNIFIED_SRS §2.3.3 ·
// §9.1 U-2·U-4·U-7 · §9.3 ③, 실측 0.154.0 — P4 재실측은 M8_PROGRESS §2-27). 공식 문서가
// experimental 이라 적은 표면이다 (R-1) — 스키마가 움직이면 이 파일 하나가 흡수한다
// (FR-APS-7). 정본은 `app-server generate-json-schema` 의 출력이다.
//
// 세 방향의 프레임이 한 줄씩 온다: 우리 요청의 **응답**(`id` + `result|error`) · 서버의
// **알림**(`method`, id 없음) · 서버→클라 **요청**(`id` + `method`, 승인이 여기로 온다).
// 한 프로세스가 여러 thread 를 들 수 있으나 한 도구는 **thread 하나**만 쓴다 (F-3).

// codexProto 는 codexAdapter.Proto 다.
var codexProto = Proto{
	Launch:    codexProtoLaunch,
	Handshake: codexHandshake,
	Decode:    codexDecode,
	Prompt:    codexPrompt,
	Approve:   codexApprove,
	// Cancel 은 없다 — 서버 요청은 답으로만 닫힌다. stdin EOF 가 종료다 (U-7).
	Interrupt: codexInterrupt,
	Control:   codexControl,
	TUIResume: func(sessionID string) []string { return []string{"codex", "resume", sessionID} },
	// `AskForApproval` 의 문자열 값 셋 (스키마). `granular` 객체 형은 순환에 두지 않는다.
	PermissionModes: []string{"untrusted", "on-request", "never"},
}

// codexExt 는 이 어댑터의 사적 상태다 (ProtoState.Ext).
type codexExt struct {
	seq     int
	pending map[string]codexPending // 우리 요청 id → 무엇을 물었나
	// threadID 는 이 도구의 thread 다 (F-3). turnID 는 진행 중(또는 마지막) 턴.
	threadID, turnID string
	inTurn           bool
	// model·approval 은 다음 `turn/start` 에 실을 재정의다 — codex 에는 세션 중 설정을
	// 바로 바꾸는 요청이 없다 (§9.3 ① "다음 turn/start").
	model, approval string
	// reqIDs 는 열린 서버 요청의 원문 id 다 (숫자·문자열 어느 쪽이든 그대로 되돌린다).
	reqIDs map[string]json.RawMessage
	// items 는 턴 안의 item 이다 — 승인 요청이 itemId 로만 가리키는 내용을 여기서 찾는다.
	items map[string]codexItem
	// questions 는 `item/tool/requestUserInput` 의 질문 본문 → 질문 id 다 (답은 id 로 간다).
	questions map[string]map[string]string
}

type codexPending struct {
	method string
}

type codexItem struct {
	kind    string
	detail  string
	changes json.RawMessage
}

func codexExtOf(st *ProtoState) *codexExt {
	if x, ok := st.Ext.(*codexExt); ok {
		return x
	}
	x := &codexExt{pending: map[string]codexPending{}, reqIDs: map[string]json.RawMessage{},
		items: map[string]codexItem{}, questions: map[string]map[string]string{}}
	st.Ext = x
	return x
}

func (x *codexExt) nextID() string {
	x.seq++
	return "dm-" + strconv.Itoa(x.seq)
}

// codexProtoLaunch 는 `app-server` 하나다 — 모델·재개·정책은 핸드셰이크의 요청에 실린다.
func codexProtoLaunch(o LaunchOpts) []string {
	return []string{o.Bin, "app-server"}
}

// codexRequest 는 우리→서버 요청 프레임이다. 대기표를 남긴다.
func codexRequest(x *codexExt, method string, params any) []byte {
	id := x.nextID()
	x.pending[id] = codexPending{method: method}
	m := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		m["params"] = params
	}
	b, _ := json.Marshal(m)
	return b
}

// codexHandshake 는 `initialize` → `initialized` → `thread/start|resume` 셋을 한 번에
// 보낸다 — 응답을 기다리지 않아도 순서대로 처리된다 (P4 실측). 그 뒤 `model/list` 로
// 모델 목록을 받는다 (FR-AGT-11). cwd 는 실어야 한다 — thread 의 작업 디렉터리는
// 프로세스가 아니라 요청의 것이다. 권한 모드는 `approvalPolicy` 다 (PermissionModes).
func codexHandshake(o LaunchOpts, st *ProtoState) [][]byte {
	x := codexExtOf(st)
	frames := [][]byte{
		codexRequest(x, "initialize", map[string]any{"clientInfo": map[string]any{"name": "dongminal", "version": "m8"}}),
		[]byte(`{"jsonrpc":"2.0","method":"initialized"}`),
	}
	p := map[string]any{}
	if o.Cwd != "" {
		p["cwd"] = o.Cwd
	}
	if o.Model != "" {
		p["model"] = o.Model
	}
	if o.PermissionMode != "" {
		p["approvalPolicy"] = o.PermissionMode
	}
	if o.Resume != "" {
		p["threadId"] = o.Resume
		frames = append(frames, codexRequest(x, "thread/resume", p))
	} else {
		frames = append(frames, codexRequest(x, "thread/start", p))
	}
	frames = append(frames, codexRequest(x, "model/list", map[string]any{}))
	return frames
}

// codexPrompt 는 `turn/start` 다. thread 를 아직 모르면(핸드셰이크 응답 전) 빈 threadId 로
// 보내 codex 의 오류 응답이 EvError 로 오게 한다 — 조용히 버리지 않는다 (FR-APS-8).
func codexPrompt(text string, st *ProtoState) [][]byte {
	x := codexExtOf(st)
	p := map[string]any{"threadId": x.threadID, "input": []map[string]any{{"type": "text", "text": text}}}
	if x.model != "" {
		p["model"] = x.model
		x.model = ""
	}
	if x.approval != "" {
		p["approvalPolicy"] = x.approval
		x.approval = ""
	}
	return [][]byte{codexRequest(x, "turn/start", p)}
}

func codexInterrupt(st *ProtoState) []byte {
	x := codexExtOf(st)
	return codexRequest(x, "turn/interrupt", map[string]any{"threadId": x.threadID, "turnId": x.turnID})
}

// codexControl 은 다음 `turn/start` 의 재정의를 적는다 — 지금 보낼 프레임은 없다.
// 빈 프레임(줄바꿈 하나)은 codex 가 무시한다 (P4 실측). 반영은 `thread/settings/updated`
// 가 알린다.
func codexControl(op ControlOp, st *ProtoState) ([]byte, error) {
	x := codexExtOf(st)
	switch op.Kind {
	case "set_model":
		x.model = op.Value
		return []byte{}, nil
	case "set_permission_mode":
		x.approval = op.Value
		return []byte{}, nil
	}
	return nil, ErrUnsupported
}

// codexApprove 는 서버 요청의 JSON-RPC 응답 한 프레임이다 (NFR-C-4). 선택지 id 는
// 요청이 만든 것 그대로이며 Raw 가 codex 의 decision 원문이다.
func codexApprove(req ApprovalRequest, d Decision, st *ProtoState) ([]byte, error) {
	x := codexExtOf(st)
	rawID, open := x.reqIDs[req.ID]
	if !open {
		return nil, ErrNotOpen
	}
	var result any
	switch {
	case req.Kind == ApprovalQuestion && d.Choice != ChoiceDeny:
		answers := map[string]any{}
		for q, a := range d.Answers {
			qid := x.questions[req.ID][q]
			if qid == "" {
				qid = q
			}
			answers[qid] = map[string]any{"answers": []string{a}}
		}
		result = map[string]any{"answers": answers}
	case req.Kind == ApprovalQuestion:
		// 질문의 거절 — 빈 답이다 (codex 에 "거절" 이 없다).
		result = map[string]any{"answers": map[string]any{}}
	default:
		var picked *ApprovalOption
		for i := range req.Options {
			if req.Options[i].ID == d.Choice {
				picked = &req.Options[i]
			}
		}
		if picked == nil {
			return nil, fmt.Errorf("choice %q: 요청에 없는 선택지", d.Choice)
		}
		result = map[string]any{"decision": json.RawMessage(picked.Raw)}
	}
	delete(x.reqIDs, req.ID)
	delete(x.questions, req.ID)
	delete(st.Open, req.ID)
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": rawID, "result": result})
	return b, nil
}

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
		ev := Event{Kind: EvTurnEnd, SessionID: sid, Text: p.Turn.Status, IsError: p.Turn.Status == "failed"}
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
			x.items[it.ID] = codexItem{kind: it.Type, detail: codexChangePaths(it.Changes), changes: it.Changes}
			return []Event{{Kind: EvToolStart, SessionID: sid, Tool: it.Type, ToolUseID: it.ID, Detail: codexChangePaths(it.Changes)}}, true
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
