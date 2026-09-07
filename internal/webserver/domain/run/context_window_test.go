package run

import "testing"

// UX_BATCH6_SRS 묶음 C — 컨텍스트 창의 근거.
//
// 접수한 말은 "1M 컨텍스트를 쓰는데 15% 를 70% 로 센다" 였고, 이어진 지시는
// "200, 1 이거 상수가 아니라 모델에 맞춰서" 였다.

// V-CTX-3 (FR-CTX-5): `[1m]` 접미어가 창을 정한다.
func TestWindowForModel_LongContextSuffix(t *testing.T) {
	for _, m := range []string{"claude-opus-5[1m]", "CLAUDE-OPUS-5[1M]", "claude-fable-5-1[1m]"} {
		got, ok := WindowForModel(m)
		if !ok || got != 1000000 {
			t.Errorf("%q → (%v, %v), want (1000000, true)", m, got, ok)
		}
	}
}

// V-CTX-3 (FR-CTX-5): 그 밖의 이름은 **답하지 않는다.** 기본값으로 단정하면 뒤의
// 넓히기가 "설정이 틀렸다" 와 "표에 없다" 를 구분하지 못한다.
func TestWindowForModel_UnknownSaysNothing(t *testing.T) {
	for _, m := range []string{"", "claude-opus-5", "claude-sonnet-5", "gpt-9", "  "} {
		if _, ok := WindowForModel(m); ok {
			t.Errorf("%q 가 창을 단정했다", m)
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
