package lsp

import "testing"

// FR-OPT-10-2 (DOM-30): 경로 표에 없으면 exe 키는 이름 있는 기본값이다.
func TestExeKeyDefault(t *testing.T) {
	s := &Service{paths: map[string]string{"go": "/opt/gopls"}}
	if defaultExeKey != "default" {
		t.Fatalf("defaultExeKey = %q — 세션 키의 값이 바뀌었다", defaultExeKey)
	}
	if got := s.exeKeyLocked("ts"); got != defaultExeKey {
		t.Fatalf("exeKeyLocked(ts) = %q", got)
	}
	if got := s.exeKeyLocked("go"); got != "/opt/gopls" {
		t.Fatalf("exeKeyLocked(go) = %q", got)
	}
}
