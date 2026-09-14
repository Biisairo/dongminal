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
	/**
	 * M9_SRS FR-M9-38 (M9-B21, 사용자 접수 2026-09-14 — *"permission mode 에도 auto
	 * 모드가 없어"*): **실측한 목록이다.**
	 *
	 *   이전 동작: `default`·`acceptEdits`·`plan` 셋
	 *   새  동작: CLI 가 받는 일곱
	 *   이유:     실측에서 그 세션의 **현재 모드가 `auto`** 였다(`initialize` 응답의
	 *             `current_permission_mode`). 순환 목록에 없는 값이 현재값이면
	 *             사용자는 그 모드로 **돌아갈 수 없다**
	 *
	 * 출처는 `claude --help` 의 choices 여섯이고, `default` 를 앞에 더했다 — choices
	 * 에는 없으나 **실측에서 받아들였다**(`--permission-mode default` 로 기동 성공).
	 *
	 * **프로토콜은 이 목록을 주지 않는다.** `initialize` 응답이 주는 것은 현재값
	 * 하나이며(실측), 그래서 이것은 선언이다 — 에이전트가 값을 바꾸면 여기가 낡는다.
	 */
	PermissionModes: []string{"default", "acceptEdits", "auto", "plan",
		"bypassPermissions", "dontAsk"},
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
