package agentadapter

import "testing"

// FR-ATN-3a (2026-09-11 관측) — 배경 알림은 사용자 턴이 아니다.
//
// `UserPromptSubmit` 은 사람이 친 것과 배경 알림을 **구별하지 않는다.**
// 백그라운드 작업이 끝나 턴이 깨어날 때도 같은 훅이 오고, 그때 `prompt` 에는 그
// 알림의 본문이 실린다. 그것을 사용자 턴으로 읽으면 **알림 하나가 `done` 알람
// 하나를 낳는다** — 실제 세션에서 관측된 그 자리다.

func TestClaude_BackgroundPromptIsNotAUserTurn(t *testing.T) {
	cases := []struct {
		name   string
		prompt string
		want   bool // UserPrompt
	}{
		{"사람이 친 프롬프트", "이 파일을 고쳐줘", true},
		{"배경 작업 알림", "<task-notification>\n<task-id>abc</task-id>\n</task-notification>", false},
		{"시스템 알림", "<system-reminder>메모</system-reminder>", false},
		{"앞의 공백은 무시한다", "\n  <task-notification>x</task-notification>", false},
		// 표식이 **문장 안에** 있는 것은 사람이 그 말을 한 것이다 — 시작이 아니면
		// 가르지 않는다.
		{"본문 안의 표식은 사람의 말이다", "이 <task-notification> 이 뭐야?", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := []byte(`{"hook_event_name":"UserPromptSubmit","prompt":` + jsonQuote(tc.prompt) + `}`)
			rep, ok := parseClaudeHook(raw)
			if !ok {
				t.Fatalf("파싱되지 않았다")
			}
			if rep.UserPrompt != tc.want {
				t.Fatalf("UserPrompt=%v want %v (prompt=%q)", rep.UserPrompt, tc.want, tc.prompt)
			}
			// 활동 상태는 어느 쪽이든 working 이다 — 에이전트는 실제로 일을
			// 시작했고, 활동 패널의 어휘는 이 변경으로 달라지지 않는다 (FR-ATN-2).
			if rep.State != "working" {
				t.Fatalf("State=%q want working", rep.State)
			}
		})
	}
}

// 못 가르면 **울리는 쪽**이다 — 알람이 한 번 더 우는 것이 울려야 할 때 울지 않는
// 것보다 낫다.
func TestClaude_UnknownShapeStaysAUserTurn(t *testing.T) {
	raw := []byte(`{"hook_event_name":"UserPromptSubmit","prompt":"<unknown-envelope>x</unknown-envelope>"}`)
	rep, ok := parseClaudeHook(raw)
	if !ok || !rep.UserPrompt {
		t.Fatalf("모르는 모양을 배경으로 읽었다: ok=%v rep=%+v", ok, rep)
	}
}

func jsonQuote(s string) string {
	out := []byte{'"'}
	for _, r := range s {
		switch r {
		case '"':
			out = append(out, '\\', '"')
		case '\\':
			out = append(out, '\\', '\\')
		case '\n':
			out = append(out, '\\', 'n')
		default:
			out = append(out, string(r)...)
		}
	}
	return string(append(out, '"'))
}
