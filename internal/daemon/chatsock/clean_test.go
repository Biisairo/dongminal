package chatsock

import "testing"

// REFACTOR3_DEFECTS_SRS TC-RD3-70: bidi 재정렬·zero-width(Cf)도 지운다.
// 이전에는 제어 문자만 지워 같은 규칙의 다른 일곱 자리와 달랐다.
func TestClean_StripsFormatChars(t *testing.T) {
	if got := clean("a‮b​c\x07d�"); got != "abcd" {
		t.Fatalf("clean=%q want %q", got, "abcd")
	}
}
