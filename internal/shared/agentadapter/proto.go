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
	// Handshake 는 기동 직후 호스트가 먼저 보내는 프레임들이다. nil 이면 없다. opts 는
	// Launch 가 받은 것과 같다 — 기동 인자에 실리지 않는 것(codex 의 cwd·모델·재개는
	// `thread/start|resume` 요청의 것이다)이 여기서 프레임이 된다.
	Handshake func(opts LaunchOpts, st *ProtoState) [][]byte
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
	// Approval 은 기동 시 승인 정책이다 — 어댑터의 어휘 그대로 (§9.3 ⑥ F-4). 비어
	// 있으면 어댑터가 **안전한 쪽**을 고른다: 기본이 무승인(yolo)인 에이전트는 인자
	// 없이 띄우면 승인 요청이 한 번도 오지 않으므로, 그 어댑터는 이 값을 반드시 싣는다.
	// 정책을 기동 인자로 받지 않는 에이전트는 무시한다 (FR-APS-4 — 부재).
	Approval string
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
	// Kind 는 제어의 종류 — `set_model` · `set_permission_mode` · `set_max_thinking_tokens` ·
	// `set_thinking_level`. 어댑터마다 받는 것이 다르다 (FR-APS-4).
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
	// FreeText 는 선택지 없이 글로 답하는 질문이다 (omp `input`·`editor` UI 요청).
	// 답은 Decision.Answers[Question] 그대로다.
	FreeText bool `json:"freeText,omitempty"`
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
	EvMessage        EventKind = "message"         // 에이전트 메시지 스냅샷 (Message = content 블록들 — 아래 어휘)
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
//
// Message 는 블록 배열이며 어휘는 셋이다 — `{type:"text",text}` · `{type:"thinking",
// thinking}` · `{type:"tool_use",id,name,input}`. 어댑터가 자기 프로토콜의 블록을 이
// 셋으로 옮긴다 (FR-APS-7) — 뷰는 이 셋만 그린다.
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
//
// M9_SRS FR-M9-34 (사용자 지시 2026-09-14): **사용량의 모양은 에이전트마다 다르다.**
// *"사용량은 어떤 건 5시간/7주일, 어떤 건 1달 이렇게 되고, context window 도 어떤 건
// 사용토큰/총토큰, 어떤 건 % 로만 주니까."* 그래서 이 구조는 **절대값과 비율을 모두**
// 받고, 플랜 한도는 **주기가 가변인 목록**으로 받는다. 어댑터는 자기가 아는 것만 채운다.
type ProtoUsage struct {
	// Tokens 는 마지막 요청의 입력 컨텍스트다 (input + cache_creation + cache_read).
	Tokens        int64 `json:"tokens,omitempty"`
	OutputTokens  int64 `json:"outputTokens,omitempty"`
	ContextWindow int64 `json:"contextWindow,omitempty"`
	// ContextRatio 는 **창 크기를 모르고 비율만 아는** 어댑터의 자리다 (0.0~1.0).
	// 단위는 `run.ContextState.ContextRatio` 와 같다 — 두 벌이 되면 어느 쪽이 100 을
	// 뜻하는지 호출부마다 달라진다. 퍼센트로 주는 와이어는 **어댑터가 나눈다.**
	ContextRatio float64 `json:"contextRatio,omitempty"`
	// CacheRead·CacheWrite 는 종전에 **파싱하고 버리던** 값이다 (FR-M9-34).
	// `Tokens` 는 이 둘을 합산한 채로 두므로 뜻이 바뀌지 않는다.
	CacheRead  int64   `json:"cacheRead,omitempty"`
	CacheWrite int64   `json:"cacheWrite,omitempty"`
	CostUSD    float64 `json:"costUSD,omitempty"`
	Model      string  `json:"model,omitempty"`
	// Limits 는 플랜 한도다. **주기가 에이전트마다 다르므로 목록이다** — 5시간·주간·
	// 월간, 그 밖. 빈 목록은 "한도를 말하지 않는 에이전트" 이고 0% 가 아니다.
	Limits []ProtoLimit `json:"limits,omitempty"`
}

// ProtoLimit 은 플랜 한도 하나다 (FR-M9-34).
//
// 채워지는 조합이 에이전트마다 다르다 — claude 의 `rate_limit_event` 는 `Ratio` 와
// `ResetAt` 만 주고 총량을 주지 않는다. 총량을 주는 에이전트는 `Used`·`Total` 을
// 채운다. **비어 있는 것은 부재다** (FR-CBG-5: 모른다 ≠ 0).
type ProtoLimit struct {
	// Kind 는 주기의 이름이며 **어댑터가 정한다** (D-M9-23). 화면은 아는 것만
	// 번역하고 모르는 것은 Label 을 그대로 보인다 — 열거로 굳히면 새 주기를 쓰는
	// 에이전트의 값이 조용히 사라진다.
	Kind string `json:"kind"`
	// Label 은 화면이 Kind 를 모를 때 쓸 표시 이름이다. 비어 있으면 Kind 를 쓴다.
	Label   string  `json:"label,omitempty"`
	Used    float64 `json:"used,omitempty"`
	Total   float64 `json:"total,omitempty"`
	Ratio   float64 `json:"ratio,omitempty"`
	ResetAt int64   `json:"resetAt,omitempty"`
}

// ProtoStatus 는 세션의 설정 상태다 (FR-AGT-11). 비어 있는 필드는 "이 이벤트가 그것을
// 말하지 않았다" 다 — 소비자는 채워진 것만 덮어쓴다.
type ProtoStatus struct {
	Model          string         `json:"model,omitempty"`
	PermissionMode string         `json:"permissionMode,omitempty"`
	Models         []ModelChoice  `json:"models,omitempty"`
	Commands       []ProtoCommand `json:"commands,omitempty"`
	Account        string         `json:"account,omitempty"`
	Compacted      bool           `json:"compacted,omitempty"`
}

// ProtoCommand 은 그 에이전트가 받는 `/` 명령 하나다 (M9_SRS FR-M9-45 / M9-B26).
//
// **이름만으로는 쓸 수 없다.** 사용자가 못 하는 것은 명령을 보내는 일이 아니라
// **무엇을 보낼지 아는** 일이다 — `/config` 만 보고 `key=value` 를 알 길이 없다.
// 그 답은 프로토콜이 이미 보내는데(실측 2026-09-14: `initialize` 의 68개 중 23개가
// 인자 문법을 싣는다) 종전에는 이름만 남기고 버렸다.
type ProtoCommand struct {
	Name string `json:"name"`
	// Description 은 한 줄 설명이다.
	Description string `json:"description,omitempty"`
	// ArgumentHint 는 인자의 문법 그대로다 — `key=value` · `<low|medium|high>` ·
	// `[on|off]`. **빈 값은 "인자를 받지 않는다"** 이고, 그때 화면은 그 자리를
	// 비운다. `<args>` 로 채우면 없는 문법을 지어내는 것이다 (FR-CBG-5).
	ArgumentHint string `json:"argumentHint,omitempty"`
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
