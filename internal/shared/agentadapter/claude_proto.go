package agentadapter

import (
	"encoding/json"
	"fmt"
	"regexp"
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
	Interrupt:       claudeInterrupt,
	Control:         claudeControl,
	TUIResume:       func(sessionID string) []string { return []string{"claude", "--resume", sessionID} },
	CommandFormFill: claudeCommandFormFill,
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
	// FR-M11-30 (M11-B28): **실측으로 확인했다** (§2.11 (4)).
	Attachments: true,
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
	// model 은 **이 세션이 도는 모델**이다 (M12_SRS FR-M12-6).
	//
	// `result.modelUsage` 에서 어느 항목이 이 대화의 것인지는 이 값으로만 가릴 수
	// 있다. 두 자리에서 온다: `init` 은 키와 같은 이름(`claude-opus-5[1m]`)을,
	// `message_start` 는 정본 이름(`claude-opus-5`)을 준다 — 그래서 되짚는 손도
	// 둘이다 (`claudePickModelUsage`).
	model string
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

// claudePrompt 는 프롬프트 프레임이다.
//
// M11_SRS FR-M11-30 (M11-B28): **첨부가 있으면 `content` 가 배열이다.**
//
//	이전 동작: `content` 를 **문자열로만** 보냈다 — 이미지를 실을 자리가 없었다
//	새  동작: 첨부가 있으면 `[image…, {type:text}]` 로 보낸다
//	이유:     막힌 것은 프로토콜이 아니라 이 한 줄이었다 (실측 §2.11 (4) — 8×8 빨강
//	          PNG 를 보내고 *"빨강"* 이라는 답을 받았다)
//
// 첨부가 없으면 **종전 그대로 문자열**이다. 배열로 바꾸면 이미 도는 모든 턴의 와이어가
// 함께 바뀌고, 그 변경은 이 요구가 요청한 것이 아니다.
//
// 이미지가 **앞**에 서는 것은 실측한 모양 그대로다 — 글이 그림을 가리킨다.
func claudePrompt(text string, atts []Attachment, st *ProtoState) [][]byte {
	var content any = text
	if len(atts) > 0 {
		blocks := make([]map[string]any, 0, len(atts)+1)
		for _, a := range atts {
			if a.MediaType == "" || a.Data == "" {
				continue
			}
			blocks = append(blocks, map[string]any{"type": "image",
				"source": map[string]any{"type": "base64", "media_type": a.MediaType, "data": a.Data}})
		}
		if len(blocks) > 0 {
			content = append(blocks, map[string]any{"type": "text", "text": text})
		}
	}
	b, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})
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
	// ParentToolUse 는 **이 프레임이 누구의 것인가**다 (M11_SRS FR-M11-49 / M11-B49).
	//
	// 서브에이전트의 진행은 **같은 스트림**으로 오고 이 필드만이 그것을 가른다 —
	// 값이 있으면 그 `Agent` 도구 호출 안에서 일어난 일이다 (실측 §2.13). 버리면
	// 서브에이전트의 프롬프트가 *사용자가 친 말*로, 그 도구가 *부모의 도구*로 선다.
	ParentToolUse string          `json:"parent_tool_use_id"`
	RequestID     string          `json:"request_id"`
	Request       json.RawMessage `json:"request"`
	Response      json.RawMessage `json:"response"`
	NewConv       string          `json:"new_conversation_id"`
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
	// Iterations 는 **그 턴의 마지막 요청**이다 (M12_SRS FR-M12-11, 실측 2026-09-16).
	//
	// `result` 의 최상위 `usage` 는 **턴 안의 요청들을 합한 값**이다. 도구를 세 번
	// 쓰는 턴을 재니 갈렸다:
	//
	//	usage           input 8  cache_creation 26049  cache_read 77517  → 103574
	//	iterations[-1]  input 2  cache_creation   105  cache_read 25944  →  26051
	//
	// 그래서 컨텍스트를 말할 때는 이쪽을 쓴다 — 합은 *이 턴이 얼마를 썼나* 이지
	// *지금 컨텍스트가 얼마인가* 가 아니다.
	Iterations []claudeUsage `json:"iterations"`
}

// last 는 컨텍스트를 말하는 요청이다 — `iterations` 의 마지막, 없으면 자기 자신
// (요청이 하나뿐인 턴).
func (u *claudeUsage) last() *claudeUsage {
	if u == nil {
		return nil
	}
	if n := len(u.Iterations); n > 0 {
		return &u.Iterations[n-1]
	}
	return u
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
	// CanonicalModel 은 판 표식이 빠진 이름이다 — `claude-opus-5[1m]` 의 정본은
	// `claude-opus-5` 다. `message_start` 가 주는 이름이 이쪽이라 되짚는 데 쓴다
	// (M12_SRS FR-M12-6, 실측 2026-09-16).
	CanonicalModel string `json:"canonicalModel"`
}

/*
고르는 화면 (M12_SRS FR-M12-4 / V-M12-9·10).

접수: *"여전히 /model, /config 같은 tui 들은 사용이 불가"* (M11-B11). **막힌 것은
명령이 아니다** — 둘 다 정상 응답하고 `init` 이 말하는 TUI 전용 명령에도 없다
(실측 M11_SRS §2.11 (5)). 막힌 것은 **고를 자리**다: 원본 TUI 에서 인자 없는
`/model` 은 선택 화면을 띄우는데 프로토콜은 사용법 텍스트를 돌려줄 뿐이다.

종전에는 그 사실이 **화면의 정규식**(`AGENT_PICK_CMD_RE`)과 **화면의 파서**
(`key=a|b|c`)에 적혀 있었다 (누수 L5·L6). 적을 자리가 계약에 없었기 때문이다.
*/

// claudeCommandForms 는 고르는 화면이 서는 명령들이다.
//
// **둘뿐이고 실측한 것이다** — `initialize` 가 주는 68개 중 인자 없이 선택 화면을
// 띄우는 것이 이 둘이다. 목록을 늘리려면 같은 방법으로 재고 여기에 적는다.
var claudeCommandForms = map[string]CommandForm{
	// 선택지는 `ProtoStatus.Models` 가 이미 준다 — 물을 것이 없다.
	//
	// **`Control` 이 이 변경의 요점이다**: 종전에는 고른 값이 `/model <v>` 라는
	// **프롬프트 문자열**로 나갔고, 같은 일을 하는 메뉴는 `set_model` 제어로 나갔다.
	// 한 일에 손이 둘이면 한쪽만 고쳐진다 (누수 L7).
	"model": {Kind: "models", Control: "set_model"},
	// 키와 선택지는 **응답이 준다** — 우리가 목록을 지어내지 않는다. 대응하는
	// 제어가 없으므로 고른 값은 슬래시 명령으로 간다.
	"config": {Kind: "keyvalue", AwaitResponse: true},
}

// claudeAttachForms 는 명령 목록에 선언을 단다.
func claudeAttachForms(cmds []ProtoCommand) []ProtoCommand {
	for i := range cmds {
		if f, ok := claudeCommandForms[cmds[i].Name]; ok {
			form := f
			cmds[i].Form = &form
		}
	}
	return cmds
}

// claudeConfigKeyRe 는 `/config` 응답의 한 줄이다 — 들여쓴 `key=a|b|c`.
//
// 실측(M11_SRS §2.11 (5))에서 그 응답은 사용법 한 줄과 **들여쓴 키 목록**이다.
// 들여쓰기를 요구하는 것이 산문과 가르는 손이며, 그러지 않으면 본문의 아무 `=` 나
// 키로 읽는다.
var claudeConfigKeyRe = regexp.MustCompile(`^\s+([A-Za-z][\w.]*)=(\S.*)$`)

// claudeCommandFormFill 은 `/config` 응답 텍스트를 폼의 줄들로 옮긴다.
//
// **모양이 아니면 빈 목록이다.** 그때 화면은 폼을 열지 않고 응답 텍스트가 그대로
// 선다 — 감춘 채 아무것도 열지 않으면 명령이 사라진 것으로 읽힌다 (FR-M11-40).
//
// **현재값은 되읽지 않는다**: 응답이 주는 것은 키와 선택지뿐이고, 보낸 값을
// *현재값* 으로 적으면 실패했을 때 그것이 거짓이 된다 (M11_SRS §7 의 갭).
func claudeCommandFormFill(name, response string) []FormField {
	if f, ok := claudeCommandForms[name]; !ok || f.Kind != "keyvalue" {
		return nil
	}
	var out []FormField
	for _, line := range strings.Split(response, "\n") {
		m := claudeConfigKeyRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		var vals []string
		for _, v := range strings.Split(m[2], "|") {
			if v = strings.TrimSpace(v); v != "" {
				vals = append(vals, v)
			}
		}
		if len(vals) == 0 {
			continue
		}
		out = append(out, FormField{Key: m[1], Values: vals})
	}
	return out
}
