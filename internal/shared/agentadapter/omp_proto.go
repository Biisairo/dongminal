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
// 첨부는 받지 않는다 — `Proto.Attachments` 가 거짓이므로 화면이 먼저 막는다
// (FR-M11-30: 재지 않은 것을 받는 척하지 않는다).
func ompPrompt(text string, _ []Attachment, st *ProtoState) [][]byte {
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
