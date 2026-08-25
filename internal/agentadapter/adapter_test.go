package agentadapter

import (
	"errors"
	"strings"
	"testing"
)

// TC-ADP-2 / FR-ADP-3: an unknown agent id must fail clearly. Silent success
// and a fallback to some default agent are both forbidden.
func TestGet_UnknownAgentIsAClearError(t *testing.T) {
	_, err := Get("gpt-9")
	if err == nil {
		t.Fatal("알 수 없는 에이전트 id 가 성공했다 — 조용한 성공은 금지다")
	}
	if !errors.Is(err, ErrUnknownAgent) {
		t.Fatalf("열거된 사유여야 한다: %v", err)
	}
	// 메시지는 무엇이 틀렸고 무엇이 가능한지를 함께 말해야 한다.
	if !strings.Contains(err.Error(), "gpt-9") || !strings.Contains(err.Error(), "claude") {
		t.Fatalf("오류가 입력값과 선택지를 담지 않는다: %v", err)
	}
	if _, err := Get(""); !errors.Is(err, ErrUnknownAgent) {
		t.Fatalf("빈 id 도 명확히 거부해야 한다: %v", err)
	}
}

func TestGet_KnownAgents(t *testing.T) {
	for _, id := range IDs() {
		ad, err := Get(id)
		if err != nil {
			t.Fatalf("IDs() 가 낸 %q 를 Get 이 모른다: %v", id, err)
		}
		if ad.ID != id {
			t.Fatalf("%q → ID=%q", id, ad.ID)
		}
		if ad.DetectCmd == "" || len(ad.Launch) == 0 {
			t.Fatalf("%q: detectCmd·launch 는 비어 있을 수 없다 (FR-ADP-1)", id)
		}
		if ad.HookParse == nil {
			t.Fatalf("%q: hookParse 는 어댑터 필드다 (FR-ADP-2)", id)
		}
	}
	if len(IDs()) < 2 {
		t.Fatalf("claude·codex 두 선언이 모두 있어야 한다: %v", IDs())
	}
}

// FR-ADP-5 / TC-ADP-3: 정책 주입은 세션 스코프다. 사용자의 영구 설정을 고치는
// 선언이 레지스트리에 들어오면 여기서 걸린다.
func TestPolicyInjection_IsSessionScoped(t *testing.T) {
	for _, id := range IDs() {
		ad, _ := Get(id)
		if !ad.PolicyInjection.SessionScoped {
			t.Fatalf("%q: 정책 주입이 세션 스코프가 아니다 (FR-ADP-5)", id)
		}
		if len(ad.PolicyInjection.Flags) == 0 {
			t.Fatalf("%q: 정책 주입 플래그 선언이 비었다 (FR-ADP-1)", id)
		}
	}
}

// FR-STA-4 2단계는 아직 소비자가 없다. 패턴을 선언해 두면 아무도 읽지 않는
// 채로 참인 척하게 되므로, 비어 있음을 못박는다.
func TestReadiness_NoUnconsumedScreenPatterns(t *testing.T) {
	for _, id := range IDs() {
		ad, _ := Get(id)
		if len(ad.Readiness.ScreenPatterns) != 0 {
			t.Fatalf("%q: 화면 패턴에 소비자가 없다 — 선언하면 안 된다 (FR-STA-4 2단계 미구현)", id)
		}
	}
}

// FR-ADP-4 / D-D: 검증 대상은 Claude 다. 훅으로 준비완료를 아는 것은 claude 뿐이며,
// codex 는 agent-turn-complete 하나뿐이라 준비완료를 훅으로 알 수 없다.
func TestReadiness_HooksOnlyWhereTheAgentReportsIdle(t *testing.T) {
	claude, _ := Get("claude")
	if !claude.Readiness.Hooks {
		t.Fatal("claude 는 SessionStart→idle 을 준다 — 훅 기반이어야 한다")
	}
	codex, _ := Get("codex")
	if codex.Readiness.Hooks {
		t.Fatal("codex 의 표준 notify 는 agent-turn-complete 뿐이라 준비완료를 알 수 없다")
	}
}

// FR-ADP-2 / TC-ADP-1: 훅 파서는 어댑터 필드로 옮겨왔을 뿐 동작이 같아야 한다.
// 전수 회귀는 runtimebin/dmctl_activity_test.go 가 그대로 들고 있고, 여기서는
// 레지스트리 경유 조회가 같은 파서에 닿는지만 확인한다.
func TestHookParse_ReachedThroughTheRegistry(t *testing.T) {
	claude, _ := Get("claude")
	r, ok := claude.HookParse([]byte(`{"hook_event_name":"Notification"}`))
	if !ok || r.State != "waiting" {
		t.Fatalf("claude Notification → waiting, got %+v ok=%v", r, ok)
	}
	codex, _ := Get("codex")
	r, ok = codex.HookParse([]byte(`{"type":"agent-turn-complete"}`))
	if !ok || r.State != "done" {
		t.Fatalf("codex turn-complete → done, got %+v ok=%v", r, ok)
	}
	// 서로의 이벤트를 알아듣지 않는다 — 어댑터가 섞이면 여기서 걸린다.
	if _, ok := codex.HookParse([]byte(`{"hook_event_name":"Stop"}`)); ok {
		t.Fatal("codex 파서가 claude 이벤트를 받아들였다")
	}
}

// FR-PRE-1 의 전달 형태를 떠받치는 부분이다 — 프리앰블은 셸에 타이핑되므로
// 따옴표·`$`·백틱·개행이 원문 그대로 살아남아야 한다.
func TestLaunchLine_ArgvQuotingSurvivesShellMetacharacters(t *testing.T) {
	claude, _ := Get("claude")
	prompt := "요약: it's \"quoted\" $HOME `date`\n둘째 줄"
	line := claude.LaunchLine("sonnet", prompt)

	if !strings.HasPrefix(line, "claude ") {
		t.Fatalf("기동 커맨드로 시작해야 한다: %q", line)
	}
	if !strings.Contains(line, "--model sonnet") {
		t.Fatalf("모델 플래그가 없다: %q", line)
	}
	if strings.Contains(line, `\"quoted\"`) {
		t.Fatalf("이스케이프가 원문을 바꿨다: %q", line)
	}
	if !strings.Contains(line, "$HOME") || !strings.Contains(line, "`date`") {
		t.Fatalf("셸 전개를 막지 못했다: %q", line)
	}
	if !strings.Contains(line, "둘째 줄") {
		t.Fatalf("개행 뒤 본문이 사라졌다: %q", line)
	}
	// 홑따옴표는 '\'' 로 닫고 다시 여는 형태여야 한다.
	if !strings.Contains(line, `'\''`) {
		t.Fatalf("홑따옴표를 안전하게 처리하지 않았다: %q", line)
	}
}

func TestLaunchLine_OmitsModelWhenUnknown(t *testing.T) {
	claude, _ := Get("claude")
	if got := claude.LaunchLine("", "안녕"); strings.Contains(got, "--model") {
		t.Fatalf("모델을 지정하지 않았는데 플래그가 붙었다: %q", got)
	}
	// codex 의 모델 플래그는 이 환경에서 확인하지 못했다 (D-D). 확인되지 않은
	// 플래그를 명령줄에 넣으면 기동 자체가 깨지므로 조용히 생략해야 한다.
	codex, _ := Get("codex")
	if got := codex.LaunchLine("o3", "안녕"); strings.Contains(got, "o3") {
		t.Fatalf("codex 는 모델 플래그가 미검증이라 실어선 안 된다: %q", got)
	}
}

// promptInjection=stdin-after-start 인 에이전트는 프롬프트를 기동 인자로 받지
// 않는다. 그걸 argv 로 밀어 넣으면 조용히 유실되거나 기동이 깨진다.
func TestLaunchLine_StdinAfterStartCarriesNoPrompt(t *testing.T) {
	for _, id := range IDs() {
		ad, _ := Get(id)
		if ad.PromptInjection != PromptStdinAfterStart {
			continue
		}
		if got := ad.LaunchLine("", "비밀 프롬프트"); strings.Contains(got, "비밀 프롬프트") {
			t.Fatalf("%q: 기동줄에 프롬프트가 실렸다: %q", id, got)
		}
	}
}
