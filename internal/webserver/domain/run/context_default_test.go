package run

import "testing"

// FR-OPT-10-2 (DOM-30): 기본 창 크기는 아는 창의 첫 칸과 한 값이다 — 두 자리에
// 적혀 있으면 한쪽만 고쳐진다.
func TestDefaultWindowTokensSingleSource(t *testing.T) {
	if DefaultWindowTokens != contextWindows[0] {
		t.Fatalf("DefaultWindowTokens=%v contextWindows[0]=%v", DefaultWindowTokens, contextWindows[0])
	}
	if got := DefaultContextPolicy().LimitTokens; got != DefaultWindowTokens {
		t.Fatalf("LimitTokens=%v, want %v", got, DefaultWindowTokens)
	}
	if DefaultWindowTokens != 200000 {
		t.Fatalf("기본 창 크기가 바뀌었다: %v", DefaultWindowTokens)
	}
}
