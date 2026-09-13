package agentadapter

import (
	"encoding/json"
	"errors"
)

// 프로토콜 표면 (M8_UNIFIED_SRS §3.4.1 묶음 P, FR-APS-1~10 · §9.3 ③).
//
// 터미널 표면(`Launch`·`HookParse`·…)과 **나란한** 자리다 — 서로를 대체하지 않는다
// (FR-U-3). 에이전트 하나의 모든 차이(기동 인자·프레임 스키마·승인 규약·재개)는
// `Proto` 의 함수 안에서 끝나고, 소비자(서버 해석층·브라우저)는 공통 이벤트만 안다
// (FR-U-1·FR-APS-7).

// ErrUnsupported 는 그 에이전트에 없는 제어다 (FR-AGT-11). 빈 성공으로 답하지
// 않는다 — 모른다와 괜찮다는 다르다 (FR-APS-4).
var ErrUnsupported = errors.New("unsupported")

// ErrNotOpen 은 열린 승인 요청이 아니다 — 이미 답했거나 모르는 id 다 (FR-APS-5).
var ErrNotOpen = errors.New("approval_not_open")

// Proto 는 프로토콜 표면의 선언이다 (FR-APS-9). `Adapter.Proto` 가 nil 이면 이
// 에이전트는 에이전트 도구로 뜰 수 없다 — 소비자는 그것을 부재로 받는다 (FR-APS-4).
type Proto struct {
	// Launch 는 프로토콜 모드 기동 argv 다. 프롬프트는 싣지 않는다 — 입력은
	// Prompt 가 프레임으로 만든다. opts.Bin 이 실행 파일이다 (§9.3 ② 의 전제).
	Launch func(opts LaunchOpts) []string
	// Handshake 는 기동 직후 호스트가 먼저 보내는 프레임들이다. nil 이면 없다.
	Handshake func(st *ProtoState) [][]byte
	// Decode 는 stdout 한 줄을 공통 이벤트로 옮긴다. ok=false 는 "모르는 프레임" —
	// 호출자가 원문을 이벤트 로그에 남기고 부재로 올린다 (FR-APS-8). st 는 갱신된다
	// (세션 신원 · 열린 요청 · 어댑터 사적 상태). 아는 프레임인데 이벤트가 없으면
	// (nil, true) 다.
	Decode func(line []byte, st *ProtoState) (evs []Event, ok bool)
	// Prompt 는 사용자 입력을 프레임으로 만든다. 슬래시 명령도 여기로 간다.
	Prompt func(text string, st *ProtoState) [][]byte
	// Approve 는 열린 승인 요청에 대한 답이다. d.Choice 는 요청이 준 선택지의 id
	// 중 하나 그대로다 (FR-AGT-5) — 어댑터가 그것을 프레임으로 옮기고 요청을 닫는다.
	// 질문(Kind=question)이면 d.Answers 가 답이다.
	Approve func(req ApprovalRequest, d Decision, st *ProtoState) ([]byte, error)
	// Cancel 은 열린 요청을 답 없이 닫는 프레임이다. 종료 직전에 보낸다 (U-7 omp).
	// nil 이면 그 에이전트에 없다.
	Cancel func(req ApprovalRequest, st *ProtoState) []byte
	// Interrupt 는 진행 중 턴을 멈춘다. nil 이면 그 에이전트에 없다.
	Interrupt func(st *ProtoState) []byte
	// Control 은 세션 중 설정 변경(모델·권한 모드·사고 예산)이다 (FR-AGT-11).
	// 어댑터가 지원하는 것만 받고 나머지는 ErrUnsupported 다.
	Control func(op ControlOp, st *ProtoState) ([]byte, error)
	// TUIResume 은 TUI 출구의 기동 argv 다 (FR-AGT-10) — 같은 세션을 터미널 탭에서.
	TUIResume func(sessionID string) []string
	// PermissionModes 는 `set_permission_mode` 가 받는 값의 순환 순서다 (FR-AGT-4a,
	// Shift+Tab). 비어 있으면 그 에이전트에 순환이 없다 — 메뉴에도 나타나지 않는다.
	PermissionModes []string
}

// LaunchOpts 는 프로토콜 기동의 입력이다.
type LaunchOpts struct {
	Bin, Cwd, Model string
	// Resume 은 세션 신원. 비어 있으면 새 세션.
	Resume string
	// PermissionMode 는 기동 시 권한 모드다. 비어 있으면 에이전트의 기본.
	PermissionMode string
}

// ProtoState 는 도구 하나의 프로토콜 상태다. 어댑터만 읽고 쓴다.
type ProtoState struct {
	SessionID string
	// Open 은 열린 승인 요청이다 (FR-APS-5). 키는 프로토콜의 요청 id.
	Open map[string]ApprovalRequest
	// Ext 는 어댑터 사적 상태다 (claude: 보낸 제어 요청의 대기표·턴 진행 여부).
	Ext any
}

// NewProtoState 는 빈 상태다.
func NewProtoState() *ProtoState {
	return &ProtoState{Open: map[string]ApprovalRequest{}}
}

// ControlOp 는 세션 중 제어 하나다 (FR-AGT-11).
type ControlOp struct {
	// Kind 는 제어의 종류 — `set_model` · `set_permission_mode` · `set_max_thinking_tokens`.
	Kind  string
	Value string
}

// 승인 요청의 종류 (FR-APS-5 · FR-AGT-4).
const (
	// ApprovalPermission 은 "이 도구를 이 입력으로 써도 되는가" 다.
	ApprovalPermission = "permission"
	// ApprovalQuestion 은 에이전트가 사용자에게 묻는 선택형 질문이다
	// (claude `AskUserQuestion` — 같은 통로로 온다).
	ApprovalQuestion = "question"
)

// 승인 선택지의 id. 프로토콜이 준 제안은 `suggestion:<i>` 다 (FR-AGT-5).
const (
	ChoiceAllow = "allow"
	ChoiceDeny  = "deny"
)

// ApprovalRequest 는 열린 승인 요청 하나다 (FR-APS-5).
type ApprovalRequest struct {
	// ID 는 프로토콜의 요청 id 그대로 (답에 되돌린다).
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Tool string `json:"tool,omitempty"`
	// Detail 은 명령·경로 — 알람의 내용이다 (FR-AAL-4).
	Detail      string `json:"detail,omitempty"`
	Description string `json:"description,omitempty"`
	// Input 은 도구 입력 원문이다. 브라우저가 그대로 보인다.
	Input json.RawMessage `json:"input,omitempty"`
	// Options 는 프로토콜이 준 선택지 그대로다 (FR-AGT-5). permission 에서만.
	Options []ApprovalOption `json:"options,omitempty"`
	// Questions 는 question 에서만.
	Questions []Question `json:"questions,omitempty"`
	// ToolUseID 는 이 요청이 딸린 도구 호출이다.
	ToolUseID string `json:"toolUseId,omitempty"`
}

// ApprovalOption 은 선택지 하나다. Raw 는 프로토콜의 제안 항목 원문 —
// 답에 그대로 되돌린다.
type ApprovalOption struct {
	ID    string          `json:"id"`
	Label string          `json:"label"`
	Raw   json.RawMessage `json:"raw,omitempty"`
}

// Question 은 선택형 질문 하나다.
type Question struct {
	Question    string           `json:"question"`
	Header      string           `json:"header,omitempty"`
	Options     []QuestionOption `json:"options"`
	MultiSelect bool             `json:"multiSelect,omitempty"`
}

// QuestionOption 은 질문의 선택지 하나다.
type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

// Decision 은 사용자의 답이다. permission 은 Choice, question 은 Answers
// (질문 본문 → 고른 라벨).
type Decision struct {
	Choice  string            `json:"choice,omitempty"`
	Answers map[string]string `json:"answers,omitempty"`
}

// EventKind 는 공통 이벤트의 종류다 (FR-APS-2·3). 활동 어휘는 여기서 파생한다
// (`Event.Activity`).
type EventKind string

const (
	EvSession        EventKind = "session"         // 세션 신원 (+모델·권한 모드)
	EvTurnStart      EventKind = "turn_start"      // 턴 시작 — 모델 요청이 나갔다
	EvTurnEnd        EventKind = "turn_end"        // 턴 종료 — Text 는 종료 사유
	EvTextDelta      EventKind = "text_delta"      // 본문 증분
	EvThinkingDelta  EventKind = "thinking_delta"  // 추론 증분
	EvMessage        EventKind = "message"         // 에이전트 메시지 스냅샷 (Message = content 블록들)
	EvUser           EventKind = "user"            // 사용자 쪽 텍스트 (우리가 보낸 프롬프트 · 로컬 명령 출력)
	EvToolStart      EventKind = "tool_start"      // 도구 호출 시작
	EvToolEnd        EventKind = "tool_end"        // 도구 결과
	EvApprovalOpen   EventKind = "approval_open"   // 승인 요청 열림 (Approval)
	EvApprovalClosed EventKind = "approval_closed" // 승인 요청 닫힘 (Approval.ID · Text 는 선택)
	EvUsage          EventKind = "usage"           // 사용량·컨텍스트 창·비용
	EvStatus         EventKind = "status"          // 모델·권한 모드·모델 목록·명령 목록·압축
	EvReset          EventKind = "reset"           // 신원 교체 (claude /clear)
	EvError          EventKind = "error"           // 오류 — Text 는 사유
	EvExit           EventKind = "exit"            // 프로세스 종료 (해석층이 낸다)
	EvRaw            EventKind = "raw"             // 모르는 프레임 원문 (FR-APS-8)
)

// Event 는 공통 이벤트다. Kind 별 값만 채워지고, 없는 것은 영값이 아니라 부재다
// (FR-APS-4) — 포인터·omitempty 가 그 뜻을 와이어에 남긴다.
type Event struct {
	Kind      EventKind        `json:"kind"`
	SessionID string           `json:"sessionId,omitempty"`
	Text      string           `json:"text,omitempty"`
	Tool      string           `json:"tool,omitempty"`
	ToolUseID string           `json:"toolUseId,omitempty"`
	Detail    string           `json:"detail,omitempty"`
	IsError   bool             `json:"isError,omitempty"`
	Approval  *ApprovalRequest `json:"approval,omitempty"`
	Usage     *ProtoUsage      `json:"usage,omitempty"`
	Status    *ProtoStatus     `json:"status,omitempty"`
	Message   json.RawMessage  `json:"message,omitempty"`
	Raw       json.RawMessage  `json:"raw,omitempty"`
}

// ProtoUsage 는 프레임이 말한 사용량이다 (FR-AGT-6 — 전사본을 읽지 않는다).
// 0 은 "모른다" 가 아니라 부재다 — 값이 없는 필드는 omitempty 로 빠진다.
type ProtoUsage struct {
	// Tokens 는 마지막 요청의 입력 컨텍스트다 (input + cache_creation + cache_read).
	Tokens        int64   `json:"tokens,omitempty"`
	OutputTokens  int64   `json:"outputTokens,omitempty"`
	ContextWindow int64   `json:"contextWindow,omitempty"`
	CostUSD       float64 `json:"costUSD,omitempty"`
	Model         string  `json:"model,omitempty"`
}

// ProtoStatus 는 세션의 설정 상태다 (FR-AGT-11). 비어 있는 필드는 "이 이벤트가 그것을
// 말하지 않았다" 다 — 소비자는 채워진 것만 덮어쓴다.
type ProtoStatus struct {
	Model          string        `json:"model,omitempty"`
	PermissionMode string        `json:"permissionMode,omitempty"`
	Models         []ModelChoice `json:"models,omitempty"`
	Commands       []string      `json:"commands,omitempty"`
	Account        string        `json:"account,omitempty"`
	Compacted      bool          `json:"compacted,omitempty"`
}

// ModelChoice 는 프로토콜이 준 모델 선택지 하나다 (FR-AGT-11 — 그대로 낸다).
type ModelChoice struct {
	Value       string `json:"value"`
	DisplayName string `json:"displayName,omitempty"`
	Description string `json:"description,omitempty"`
}

// Activity 는 이 이벤트가 말하는 활동 상태다 (FR-APS-2) — 어휘는 훅 표면의 것과
// 한 글자도 다르지 않다. ok=false 면 이 이벤트는 활동을 말하지 않는다.
func (e Event) Activity() (state string, ok bool) {
	switch e.Kind {
	case EvSession:
		return "idle", true
	case EvTurnStart, EvApprovalClosed:
		return "working", true
	case EvApprovalOpen:
		return "waiting", true
	case EvTurnEnd:
		return "done", true
	case EvExit:
		return "ended", true
	}
	return "", false
}

// HasProto 는 이 에이전트가 에이전트 도구로 뜰 수 있는가다 (FR-APS-9).
func (a Adapter) HasProto() bool { return a.Proto != nil }
