package agentadapter

import (
	"strings"
	"testing"
)

// OMP_AGENT_SUPPORT_SRS §5.1 — 선언과 파서의 검증 V-OMP-1~8.
//
// 여기 적힌 값은 전부 실측이다 (SRS §2.1·2.3). 추측한 값은 비운다는 것이 이
// 패키지의 규약이므로(adapter.go 머리), 비어 있어야 하는 것도 함께 잰다.

// V-OMP-1
func TestIDs_IncludesOmp(t *testing.T) {
	got := IDs()
	want := map[string]bool{"claude": false, "codex": false, "omp": false}
	for _, id := range got {
		if _, ok := want[id]; ok {
			want[id] = true
		}
	}
	for id, seen := range want {
		if !seen {
			t.Fatalf("%s 선언이 없다: %v", id, got)
		}
	}
}

// V-OMP-2 · V-OMP-3 · V-OMP-4 · V-OMP-5 — 확정된 값과 **비어 있어야 하는 값**.
func TestOmpAdapter_ConfirmedValues(t *testing.T) {
	omp, err := Get("omp")
	if err != nil {
		t.Fatalf("Get(omp): %v", err)
	}
	if omp.DetectCmd != "omp" || len(omp.Launch) != 1 || omp.Launch[0] != "omp" {
		t.Fatalf("기동 커맨드가 omp 가 아니다: detect=%q launch=%v", omp.DetectCmd, omp.Launch)
	}
	if omp.ModelFlag != "--model" {
		t.Fatalf("ModelFlag = %q, 실측은 --model 이다", omp.ModelFlag)
	}
	if omp.PromptInjection != PromptArgv {
		t.Fatalf("프롬프트는 위치 인자다 (omp \"...\"), got %q", omp.PromptInjection)
	}
	// FR-OMP-3: 없는 함정에 구분자를 두지 않는다.
	if omp.ArgvSeparator != "" {
		t.Fatalf("ArgvSeparator 는 비어 있어야 한다: %q", omp.ArgvSeparator)
	}
	// FR-OMP-2: `/exit` 은 실측으로 확인됐다 (builtin-lifecycle.ts:513).
	if omp.ExitCommand != "/exit" {
		t.Fatalf("ExitCommand = %q, 실측은 /exit 이다", omp.ExitCommand)
	}
	// FR-OMP-4: session_start → idle 이 사다리 1단계를 성립시킨다.
	if !omp.Readiness.Hooks {
		t.Fatal("omp 는 생명주기 훅으로 준비완료를 안다")
	}
	if len(omp.Readiness.ScreenPatterns) != 0 {
		t.Fatalf("화면 패턴은 두지 않는다: %v", omp.Readiness.ScreenPatterns)
	}
	// FR-OMP-5: 플래그 이름만. 값(경로)은 런타임의 것이다.
	if !omp.PolicyInjection.SessionScoped {
		t.Fatal("정책 주입은 세션 스코프여야 한다 (FR-ADP-5)")
	}
	flags := strings.Join(omp.PolicyInjection.Flags, " ")
	for _, f := range []string{"--hook", "--plugin-dir"} {
		if !strings.Contains(flags, f) {
			t.Fatalf("PolicyInjection.Flags 에 %s 가 없다: %v", f, omp.PolicyInjection.Flags)
		}
	}
}

// V-OMP-3 — §2.3 의 매핑 그대로.
func TestParseOmpHook_MapsEvents(t *testing.T) {
	omp, _ := Get("omp")
	cases := []struct {
		payload string
		state   string
		tool    string
		prompt  bool
		compact bool
	}{
		{`{"event":"session_start"}`, "idle", "", false, false},
		{`{"event":"agent_start"}`, "working", "", true, false},
		{`{"event":"turn_start"}`, "working", "", false, false},
		{`{"event":"turn_end"}`, "working", "", false, false},
		{`{"event":"tool_call","tool":"bash","detail":"ls -al"}`, "working", "bash", false, false},
		{`{"event":"tool_result","tool":"read"}`, "working", "read", false, false},
		{`{"event":"compaction"}`, "working", "", false, true},
		{`{"event":"agent_end"}`, "done", "", false, false},
		{`{"event":"session_shutdown"}`, "ended", "", false, false},
	}
	for _, tc := range cases {
		rep, ok := omp.HookParse([]byte(tc.payload))
		if !ok {
			t.Fatalf("%s 를 파싱하지 못했다", tc.payload)
		}
		if rep.State != tc.state {
			t.Fatalf("%s → state %q, want %q", tc.payload, rep.State, tc.state)
		}
		if rep.Tool != tc.tool {
			t.Fatalf("%s → tool %q, want %q", tc.payload, rep.Tool, tc.tool)
		}
		if rep.UserPrompt != tc.prompt {
			t.Fatalf("%s → userPrompt %v, want %v", tc.payload, rep.UserPrompt, tc.prompt)
		}
		if rep.Compacted != tc.compact {
			t.Fatalf("%s → compacted %v, want %v", tc.payload, rep.Compacted, tc.compact)
		}
	}
}

// V-OMP-4 — 알 수 없는 이벤트와 깨진 JSON 은 상태를 지어내지 않는다.
func TestParseOmpHook_RejectsUnknown(t *testing.T) {
	omp, _ := Get("omp")
	for _, payload := range []string{
		`{"event":"ttsr_triggered"}`,
		`{"event":""}`,
		`{`,
		``,
	} {
		if rep, ok := omp.HookParse([]byte(payload)); ok {
			t.Fatalf("%q 를 받아들였다: %+v", payload, rep)
		}
	}
}

// V-OMP-5 — 실어 오지 않은 곁들이 값은 **빈 값**이다 (FR-CBG-5: 모른다 ≠ 괜찮다).
func TestParseOmpHook_LeavesContextEmpty(t *testing.T) {
	omp, _ := Get("omp")
	rep, ok := omp.HookParse([]byte(`{"event":"turn_start"}`))
	if !ok {
		t.Fatal("turn_start 를 파싱하지 못했다")
	}
	if rep.SessionID != "" || rep.Transcript != "" {
		t.Fatalf("없는 값을 채웠다: %+v", rep)
	}
	rep, ok = omp.HookParse([]byte(
		`{"event":"turn_start","sessionId":"s-1","transcript":"/tmp/s.jsonl"}`))
	if !ok || rep.SessionID != "s-1" || rep.Transcript != "/tmp/s.jsonl" {
		t.Fatalf("실어 온 값을 옮기지 못했다: %+v ok=%v", rep, ok)
	}
}

// V-OMP-6 — 남의 형식은 받지 않는다. 두 형식이 섞이면 어느 쪽이 진실인지 말할 수 없다.
func TestParseOmpHook_RejectsClaudePayload(t *testing.T) {
	omp, _ := Get("omp")
	if rep, ok := omp.HookParse([]byte(`{"hook_event_name":"Stop"}`)); ok {
		t.Fatalf("claude 페이로드를 받아들였다: %+v", rep)
	}
}

// V-OMP-7 — 멤버 기동줄의 `--config` 뒤에는 **치환된 절대 경로**가 온다.
func TestLaunchLine_OmpMemberConfigIsResolved(t *testing.T) {
	omp, _ := Get("omp")
	hooks := "/tmp/dm/bin/agent-hooks"
	line, err := omp.LaunchLine(hooks, "opus", "프리앰블 본문")
	if err != nil {
		t.Fatalf("LaunchLine: %v", err)
	}
	if strings.Contains(line, HooksDirToken) {
		t.Fatalf("토큰이 남았다: %s", line)
	}
	if !strings.Contains(line, "--config") || !strings.Contains(line, hooks+"/omp-member.yml") {
		t.Fatalf("멤버 오버레이가 실리지 않았다: %s", line)
	}
	// FR-OMP-23: 전면 우회를 싣지 않는다.
	for _, banned := range []string{"--auto-approve", "yolo", "--approval-mode"} {
		if strings.Contains(line, banned) {
			t.Fatalf("전면 우회(%s)가 기동줄에 있다: %s", banned, line)
		}
	}
}

// V-OMP-8 — 채울 자리를 주지 않으면 **오류**다. 조용히 타이핑되면 기동이 깨진다.
func TestLaunchLine_UnresolvedTokenIsAnError(t *testing.T) {
	omp, _ := Get("omp")
	if line, err := omp.LaunchLine("", "opus", "안녕"); err == nil {
		t.Fatalf("토큰을 채우지 못했는데 성공했다: %s", line)
	}
}

// V-OMP-9 — claude·codex 의 기동줄은 한 글자도 바뀌지 않는다 (NFR-OMP-2).
func TestLaunchLine_TokenlessAdaptersNeedNoPaths(t *testing.T) {
	for _, id := range []string{"claude", "codex"} {
		ad, _ := Get(id)
		if _, err := ad.LaunchLine("", "haiku", "안녕"); err != nil {
			t.Fatalf("%s 는 런타임 경로가 필요 없다: %v", id, err)
		}
	}
}
