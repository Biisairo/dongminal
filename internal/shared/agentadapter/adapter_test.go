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

// FR-ADP-1 / 실측: 멤버는 보고·질문을 dmctl 로 해야 하는데, 기본 기동에서는 그
// 첫 명령이 승인 프롬프트에 걸려 무인 팀이 성립하지 않는다. 실제로 haiku 멤버를
// 띄워 확인했다 — 프리앰블대로 run report 를 만들었지만 승인 대기에서 멈췄다.
func TestMemberArgs_PreAuthorizeDmctlOnly(t *testing.T) {
	claude, _ := Get("claude")
	line := claude.LaunchLine("haiku", "안녕")

	if !strings.Contains(line, "--allowedTools") {
		t.Fatalf("멤버 기동줄이 dmctl 을 사전 허용하지 않는다: %q", line)
	}
	if !strings.Contains(line, "dmctl") {
		t.Fatalf("허용 대상에 dmctl 이 없다: %q", line)
	}
	// 최소 권한이어야 한다 — 전면 우회 플래그는 선언에 들어오면 안 된다.
	for _, banned := range []string{"bypassPermissions", "dangerously", "dontAsk"} {
		if strings.Contains(line, banned) {
			t.Fatalf("과도한 권한 플래그가 선언됐다: %q (%q)", banned, line)
		}
	}
}

// 실측으로 확인한 함정: --allowedTools 는 가변 인자(<tools...>)라 뒤따르는 위치
// 인자 프롬프트까지 삼킨다. 실제로 프리앰블이 도구 이름으로 먹혀 빈 프롬프트로
// 기동됐다. 구분자가 그것을 막는다.
func TestLaunchLine_SeparatorProtectsThePromptFromVariadicFlags(t *testing.T) {
	claude, _ := Get("claude")
	line := claude.LaunchLine("haiku", "프리앰블 본문")

	sep := strings.Index(line, " -- ")
	if sep < 0 {
		t.Fatalf("프롬프트 앞 구분자가 없다 — 가변 인자 플래그가 프롬프트를 삼킨다: %q", line)
	}
	// 구분자는 프롬프트 **바로 앞**이어야 한다. 플래그가 그 뒤에 오면 무의미하다.
	if !strings.HasPrefix(line[sep+4:], "'프리앰블 본문'") {
		t.Fatalf("구분자 뒤가 프롬프트가 아니다: %q", line[sep+4:])
	}
	if strings.Index(line, "--allowedTools") > sep {
		t.Fatalf("허용 플래그가 구분자 뒤에 있다 — 프롬프트로 먹힌다: %q", line)
	}
}

// 인자 값에도 셸 메타문자가 있다. Bash(dmctl:*) 의 괄호·별표가 전개되면
// 기동 자체가 깨지거나 엉뚱한 값이 전달된다.
func TestLaunchLine_QuotesMemberArgValues(t *testing.T) {
	claude, _ := Get("claude")
	line := claude.LaunchLine("", "x")
	if strings.Contains(line, "Bash(dmctl:*)") && !strings.Contains(line, "'Bash(dmctl:*)'") {
		t.Fatalf("인자 값이 인용되지 않아 셸이 전개한다: %q", line)
	}
}

// FR-CBG-1 / V-CBG-3: 훅이 실어 오는 컨텍스트 신호가 파서를 통과해야 한다.
// 지금까지 transcript_path 와 session_id 는 여기서 버려지고 있었다.
func TestParseClaudeHook_CarriesContextSignals(t *testing.T) {
	claude, _ := Get("claude")
	r, ok := claude.HookParse([]byte(
		`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},` +
			`"session_id":"s-1","transcript_path":"/tmp/t.jsonl"}`))
	if !ok {
		t.Fatal("PreToolUse 를 파서가 받아들이지 않았다")
	}
	if r.Transcript != "/tmp/t.jsonl" || r.SessionID != "s-1" {
		t.Fatalf("컨텍스트 신호가 유실됐다: %+v", r)
	}
	// 곁들이 값이 늘었다고 기존 매핑이 흔들리면 안 된다 (NFR-CBG-2).
	if r.State != "working" || r.Tool != "Bash" || r.Detail != "ls" {
		t.Fatalf("활동 매핑이 바뀌었다: %+v", r)
	}
	if r.Compacted {
		t.Fatal("PreToolUse 는 압축 신호가 아니다")
	}

	// V-CBG-3: transcript_path 가 없으면 **비어 있다.** 빈 문자열이 "모른다"이며,
	// 소비자가 이것을 0 바이트로 읽으면 안 된다.
	r, _ = claude.HookParse([]byte(`{"hook_event_name":"Stop"}`))
	if r.Transcript != "" || r.SessionID != "" {
		t.Fatalf("없는 신호를 파서가 지어냈다: %+v", r)
	}
}

// FR-CBG-1 / V-CBG-2: PreCompact 는 **확정 신호**다. 활동 상태는 종전대로
// working 을 유지하되 Compacted 가 선다.
func TestParseClaudeHook_PreCompactIsAConfirmedSignal(t *testing.T) {
	claude, _ := Get("claude")
	r, ok := claude.HookParse([]byte(`{"hook_event_name":"PreCompact","transcript_path":"/tmp/t.jsonl"}`))
	if !ok || r.State != "working" {
		t.Fatalf("PreCompact → working 이 깨졌다: %+v ok=%v", r, ok)
	}
	if !r.Compacted {
		t.Fatal("PreCompact 가 압축 신호를 세우지 않았다 (FR-CBG-1)")
	}
	// SubagentStop 은 같은 working 이지만 압축이 아니다 — 둘이 한 case 에
	// 묶여 있던 것을 갈랐으므로 그 경계를 고정한다.
	r, _ = claude.HookParse([]byte(`{"hook_event_name":"SubagentStop"}`))
	if r.State != "working" || r.Compacted {
		t.Fatalf("SubagentStop 이 압축으로 오인됐다: %+v", r)
	}
}

// FR-CBG-5 / O-2: 신호를 주지 않는 어댑터는 **비운다.** codex 는 컨텍스트를
// 추정할 근거가 없으므로 추정하지 않는다.
func TestParseCodexHook_ClaimsNoContextSignal(t *testing.T) {
	codex, _ := Get("codex")
	r, ok := codex.HookParse([]byte(`{"type":"agent-turn-complete"}`))
	if !ok {
		t.Fatal("codex turn-complete 가 파싱되지 않았다")
	}
	if r.Transcript != "" || r.SessionID != "" || r.Compacted {
		t.Fatalf("codex 가 갖지 않은 신호를 지어냈다: %+v", r)
	}
}
