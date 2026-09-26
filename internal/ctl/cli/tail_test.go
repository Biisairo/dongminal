package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-6 (SHR-32) — tail 은 로그 끝에서 읽는다. 로그 상한은
// 64 MiB 이고 필요한 것은 20줄이다.
func TestTail_LastLines(t *testing.T) {
	p := filepath.Join(t.TempDir(), "log")
	os.WriteFile(p, []byte("a\nb\nc\nd\n"), 0o644)
	if got := tail(p, 2); got != "c\nd" {
		t.Fatalf("tail = %q", got)
	}
	if got := tail(p, 10); got != "a\nb\nc\nd" {
		t.Fatalf("짧은 파일 tail = %q", got)
	}
	if got := tail(filepath.Join(t.TempDir(), "없음"), 3); got != "" {
		t.Fatalf("없는 파일 = %q", got)
	}
}

// 큰 로그에서도 끝의 창만 읽는다 — 앞부분은 읽히지 않는다.
func TestTail_ReadsOnlyTheEnd(t *testing.T) {
	p := filepath.Join(t.TempDir(), "log")
	f, _ := os.Create(p)
	// 앞에는 끝 창보다 큰, 줄바꿈 없는 덩어리 — 통째로 읽고 Split 하면 그것이 첫 줄이 된다.
	f.WriteString(strings.Repeat("앞", tailWindow))
	f.WriteString("\n")
	for i := 0; i < 30; i++ {
		f.WriteString("line\n")
	}
	f.Close()
	got := tail(p, 20)
	if strings.Contains(got, "앞") || strings.Count(got, "line") != 20 {
		t.Fatalf("tail = %.80q…", got)
	}
}

func BenchmarkTail_BigLog(b *testing.B) {
	p := filepath.Join(b.TempDir(), "log")
	os.WriteFile(p, []byte(strings.Repeat("0123456789abcdef0123456789abcdef\n", 256*1024)), 0o644) // 8 MiB
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		tail(p, 20)
	}
}
