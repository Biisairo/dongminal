package agentadapter

import "testing"

// V-AAC-20 (FR-CTX-5b): **예외 표가 기본을 이긴다.**
//
// `claudeModelWindows` 는 지금 비어 있으므로(아는 예외가 없다) 바깥에서는 기본값과
// 구분되지 않는다. 그 구분을 여기서 잰다 — 표가 비었다는 사실이 규칙이 없다는
// 뜻으로 굳으면, 다른 크기의 판을 등록하는 날 그 자리가 동작하는지 아무도 모른다.
func TestClaudeContextWindow_ExceptionBeatsDefault(t *testing.T) {
	saved := claudeModelWindows
	t.Cleanup(func() { claudeModelWindows = saved })
	claudeModelWindows = []struct {
		prefix string
		window float64
	}{{"claude-tiny", 200000}}

	if got, ok := claudeContextWindow("claude-tiny-20260115"); !ok || got != 200000 {
		t.Fatalf("예외를 쓰지 않았다: (%v, %v)", got, ok)
	}
	// 표에 없는 이름은 기본이다.
	if got, ok := claudeContextWindow("claude-opus-5"); !ok || got != claudeWindowDefault {
		t.Fatalf("기본을 쓰지 않았다: (%v, %v)", got, ok)
	}
}

// 빈 표에서는 무엇을 물어도 기본이다 — 지금의 실제 배선이 그것이다.
func TestClaudeContextWindow_DefaultIsOneMillion(t *testing.T) {
	if claudeWindowDefault != 1000000 {
		t.Fatalf("기본 창 = %v, want 1000000", claudeWindowDefault)
	}
	if got, ok := claudeContextWindow(""); !ok || got != 1000000 {
		t.Fatalf("모델을 모르는 관측 → (%v, %v), want (1000000, true)", got, ok)
	}
}
