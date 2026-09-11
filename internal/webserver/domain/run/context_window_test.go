package run

import "testing"

// UX_BATCH6_SRS 묶음 C — 컨텍스트 창의 근거.
//
// 접수한 말은 "1M 컨텍스트를 쓰는데 15% 를 70% 로 센다" 였고, 이어진 지시는
// "200, 1 이거 상수가 아니라 모델에 맞춰서" 였다.

// V-CTX-3 (FR-CTX-5b): claude 는 **언제나 답한다** — 기본이 있기 때문이다.
//
//	이전 계약 — 아는 이름만 답하고 그 밖은 모름
//	새 계약   — 기본이 1M 이고, 다른 크기인 판만 따로 적는다
//	이유     — 요즘 판의 기본이 1M 이다. 모름으로 두면 정책 기본값(200k)에서
//	           출발해 관측이 넘을 때까지 잘못된 비율을 보인다
//
// 모델 이름을 얻지 못한 관측도 기본으로 답한다 — 그 편이 200k 로 세는 것보다 옳다.
func TestWindowForModel_ClaudeAnswersWithDefault(t *testing.T) {
	for _, m := range []string{"", "  ", "claude-sonnet-5", "처음보는이름"} {
		got, ok := WindowForModel("claude", m)
		if !ok || got != 1000000 {
			t.Errorf("%q → (%v, %v), want (1000000, true)", m, got, ok)
		}
	}
}

// V-CTX-5a (FR-CTX-5b): 이름이 창을 밝히지 않는 판도 안다.
//
// `[1m]` 은 **예외 표기**이지 1M 의 조건이 아니다 — 접미어 없는 opus-5 기록이
// 97045건인데 붙은 것은 35건이다 (UX_BATCH6_SRS §2.7).
func TestWindowForModel_KnownModelWithoutSuffix(t *testing.T) {
	for _, m := range []string{"claude-opus-5", "CLAUDE-OPUS-5", "claude-opus-5-20260115"} {
		got, ok := WindowForModel("claude", m)
		if !ok || got != 1000000 {
			t.Errorf("%q → (%v, %v), want (1000000, true)", m, got, ok)
		}
	}
}

// V-AAC-23: 창을 말하지 않는 에이전트와 보고자를 모르는 관측은 **같은 답**이다.
func TestWindowForModel_UnknownReporterSaysNothing(t *testing.T) {
	for _, agent := range []string{"", "codex", "없는에이전트"} {
		if _, ok := WindowForModel(agent, "claude-opus-5[1m]"); ok {
			t.Errorf("agent=%q 가 창을 단정했다", agent)
		}
	}
}

// V-CTX-4 (FR-CTX-6): 창을 넘는 관측은 불가능한 관측이다 — 아는 다음 창으로 넓힌다.
func TestWidenWindow_StepsUp(t *testing.T) {
	if got := WidenWindow(200000, 202185); got != 1000000 {
		t.Errorf("200k 를 넘겼는데 넓히지 않았다: %v", got)
	}
	// 넘지 않았으면 그대로다.
	if got := WidenWindow(200000, 150000); got != 200000 {
		t.Errorf("넘지 않았는데 넓혔다: %v", got)
	}
	// 이미 넓은 창은 더 넓히지 않는다.
	if got := WidenWindow(1000000, 300000); got != 1000000 {
		t.Errorf("창이 줄었다: %v", got)
	}
}

// V-CTX-4 (FR-CTX-6b): 아는 목록의 마지막보다도 크면 관측값 자신이 창이 된다.
// 표에 없는 판을 만나도 100% 를 넘는 수를 보이지 않는다.
func TestWidenWindow_BeyondKnownList(t *testing.T) {
	if got := WidenWindow(1000000, 1500000); got != 1500000 {
		t.Errorf("목록 밖의 관측을 담지 못했다: %v", got)
	}
}
