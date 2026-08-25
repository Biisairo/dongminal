// Package agentadapter는 에이전트별 지식을 선언 테이블 하나로 모은다
// (RUN_ORCHESTRATION_SRS 묶음 A, FR-ADP-1~6).
//
// 이전에는 이 지식이 두 군데로 흩어져 있었다 — 훅 파서는 dmctl_activity.go 의
// `switch agent` 에 박혀 있었고, 기동 커맨드·정책 주입·종료 지시는 **코드에 아예
// 없이 스킬 산문에만** 있었다. 에이전트를 하나 붙이려면 파일을 고쳐야 했고,
// 산문 쪽은 코드와 드리프트해도 아무도 몰랐다.
//
// **이 패키지는 정책을 담지 않는다** (FR-ADP-6). "무엇을 왜 어떤 순서로"는 스킬의
// 몫이고, 여기는 "이 에이전트를 어떻게 띄우고 어떻게 상태를 읽는가"만 답한다.
//
// 검증 대상은 Claude Code 다 (D-D). codex 선언은 유지하되 best-effort 이며,
// 확인하지 못한 값은 추측해 채우지 않고 비워 둔다 — 틀린 플래그는 기동 자체를
// 깨뜨리므로 없는 것보다 나쁘다.
package agentadapter

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// ErrUnknownAgent 는 열거된 거부 사유다. 알 수 없는 에이전트 id 로 조용히
// 성공하거나 기본 에이전트로 폴백하지 않는다 (FR-ADP-3).
var ErrUnknownAgent = errors.New("unknown_agent")

// Report 는 에이전트 훅 이벤트(stdin JSON)를 파싱한 결과다. 값은 서버의
// 활동 상태 어휘를 그대로 쓴다 — working / waiting / done / idle / ended.
type Report struct {
	State  string
	Tool   string
	Detail string
}

// PromptInjection 은 초기 프롬프트를 에이전트에 전달하는 방식이다.
type PromptInjection string

const (
	// PromptArgv: 기동 커맨드의 위치 인자로 싣는다.
	PromptArgv PromptInjection = "argv"
	// PromptStdinAfterStart: 기동 후 준비완료를 기다렸다가 붙여넣는다.
	PromptStdinAfterStart PromptInjection = "stdin-after-start"
)

// PolicyInjection 은 세션 스코프 정책(훅·스킬)을 주입하는 방식이다 (FR-ADP-5).
//
// 값(경로)은 런타임에 정해지므로 여기엔 **플래그 이름만** 둔다. 실제 주입은
// internal/runtime 의 셸 래퍼가 하고, 그 래퍼가 이 선언과 어긋나지 않는지는
// runtime 패키지의 대조 테스트가 지킨다.
type PolicyInjection struct {
	// Flags 는 기동 커맨드에 덧붙는 세션 스코프 인자의 이름들이다.
	Flags []string
	// SessionScoped 는 사용자의 영구 설정(~/.claude/settings.json 등)을 건드리지
	// 않는가다. 참조 구현은 영구 설정에 쓰는 대가로 설치 잠금·소유자 신원·드리프트
	// 검출 기계를 떠안는다. 우리는 그 비용을 지지 않기로 했다.
	SessionScoped bool
}

// Readiness 는 이 에이전트의 준비완료를 무엇으로 아는가다.
type Readiness struct {
	// Hooks 는 생명주기 훅이 준비완료(idle)를 알려주는가다. 참이면 FR-STA-4
	// 사다리 1단계에서 판정이 끝난다.
	Hooks bool

	// ScreenPatterns 는 FR-STA-4 사다리 **2단계**(어댑터가 선언한 준비완료 화면
	// 패턴)의 자리다. **지금 소비자가 없다** — evaluateWait 는 1·3단계만 구현하고
	// 있고, 이 자리를 채우는 것은 후속이다.
	//
	// 비워 두는 것이 의도다. 화면 패턴은 사용자가 하단 스테이터스라인 하나만
	// 붙여도 깨지며, 그것은 FR-SKL-2 가 team 스킬의 화면 fingerprint 를 삭제
	// 대상으로 삼는 이유와 정확히 같다. 선언으로 옮긴다고 안 깨지지 않는다.
	// 훅이 없는 에이전트는 3단계(출력 3초 정적)로 판정된다.
	ScreenPatterns []string
}

// Adapter 는 에이전트 하나의 선언이다 (FR-ADP-1).
type Adapter struct {
	// ID 는 dmctl 과 Run 레코드가 쓰는 에이전트 식별자다.
	ID string
	// DetectCmd 는 PATH 탐지에 쓰는 실행 파일명이다.
	DetectCmd string
	// Launch 는 기동 커맨드와 고정 인자다.
	Launch []string
	// ModelFlag 는 모델을 지목하는 플래그다. 비어 있으면 이 에이전트의 모델
	// 지정 방법을 확인하지 못했다는 뜻이며, 기동줄에서 조용히 생략된다.
	ModelFlag string
	// PromptInjection 은 초기 프롬프트 전달 방식이다.
	PromptInjection PromptInjection
	// PolicyInjection 은 세션 스코프 정책 주입 방식이다.
	PolicyInjection PolicyInjection
	// HookParse 는 훅 stdin JSON 을 활동 보고로 바꾼다. 이 필드가 `switch agent`
	// 를 대체한다 (FR-ADP-2).
	HookParse func([]byte) (Report, bool)
	// Readiness 는 준비완료 판정의 근거다.
	Readiness Readiness
	// ExitCommand 는 정중한 종료 지시다. Run 정리에서 조정자가 이것을 보낸 뒤
	// 탭을 닫는다 (FR-RUN-11a). 비어 있으면 확인된 종료 지시가 없다는 뜻이다.
	ExitCommand string
}

// registry 는 선언 전부다. 에이전트를 추가한다는 것은 여기 한 줄을 더하는 것이며,
// 다른 파일을 고치는 일이 아니다.
var registry = map[string]Adapter{
	claudeAdapter.ID: claudeAdapter,
	codexAdapter.ID:  codexAdapter,
}

// Get 은 에이전트 id 로 어댑터를 찾는다. 알 수 없는 id 는 명확한 오류다 —
// 조용한 성공도, 기본 에이전트로의 폴백도 하지 않는다 (FR-ADP-3).
func Get(id string) (Adapter, error) {
	if ad, ok := registry[id]; ok {
		return ad, nil
	}
	return Adapter{}, fmt.Errorf("%w: %q (알려진 것: %s)", ErrUnknownAgent, id, strings.Join(IDs(), ", "))
}

// IDs 는 선언된 에이전트 id 를 정렬해 낸다.
func IDs() []string {
	out := make([]string, 0, len(registry))
	for id := range registry {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// LaunchLine 은 도구의 셸에 그대로 타이핑할 기동 명령줄이다.
//
// 프롬프트는 **홑따옴표**로 감싼다. 지금까지 쓰던 큰따옴표 + 역슬래시 이스케이프는
// `"`·`$`·백틱·역슬래시를 각각 처리해야 하고 하나만 빠져도 셸이 프롬프트 본문을
// 전개해 버린다. 홑따옴표 안에서는 개행을 포함해 어떤 문자도 특수하지 않으며,
// 홑따옴표 자신만 닫았다 이스케이프하고 다시 여는 형태로 바꿔 주면 된다.
//
// promptInjection 이 argv 가 아니면 프롬프트를 싣지 않는다 — 받지 않는 자리에
// 밀어 넣으면 조용히 유실되거나 기동이 깨진다. 그 경우 호출자가 준비완료를
// 기다렸다가 별도로 붙여넣어야 한다 (FR-PRE-8).
func (a Adapter) LaunchLine(model, prompt string) string {
	parts := append([]string{}, a.Launch...)
	if model != "" && a.ModelFlag != "" {
		parts = append(parts, a.ModelFlag, model)
	}
	line := strings.Join(parts, " ")
	if a.PromptInjection == PromptArgv && prompt != "" {
		line += " " + shellQuote(prompt)
	}
	return line
}

// shellQuote wraps s in single quotes so no shell expansion can touch it.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
