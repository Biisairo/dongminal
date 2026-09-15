package agentadapter

import (
	"encoding/json"
	"fmt"
	"strconv"
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
// 첨부는 받지 않는다 (FR-M11-30 — `Proto.Attachments` 가 거짓이다).
func codexPrompt(text string, _ []Attachment, st *ProtoState) [][]byte {
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
