package outbuf

import (
	"bytes"
	"testing"
)

// DAEMON_SESSION_KEEP_SRS FR-DSK-22: 되세운 스트림은 화면 내용과 누적 좌표를 잇는다.
func TestRestore_ContinuesCoordinates(t *testing.T) {
	s := Restore(16, []byte("hello"), 1000)
	if got := s.Offset(); got != 1000 {
		t.Fatalf("Offset = %d, want 1000", got)
	}
	if data, _ := s.Snapshot(); !bytes.Equal(data, []byte("hello")) {
		t.Fatalf("Snapshot = %q", data)
	}
	if _, end := s.Feed([]byte("!")); end != 1001 {
		t.Fatalf("Feed end = %d, want 1001", end)
	}
	if data, end, ok := s.Since(999); !ok || end != 1001 || string(data) != "o!" {
		t.Fatalf("Since(999) = %q %d %v", data, end, ok)
	}
}

// 화면 내용이 상한보다 길면 끝 쪽만 남긴다.
func TestRestore_KeepsTailWithinMax(t *testing.T) {
	s := Restore(4, []byte("abcdefgh"), 8)
	if data, _ := s.Snapshot(); string(data) != "efgh" {
		t.Fatalf("Snapshot = %q, want efgh", data)
	}
	if s.Offset() != 8 {
		t.Fatalf("Offset = %d", s.Offset())
	}
}
