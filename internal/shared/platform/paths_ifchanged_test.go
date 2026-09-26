package platform

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-5-5 (SHR-12): 설치물 쓰기.

// 내용이 같으면 파일을 바꾸지 않는다 — 살아 있는 셸이 source 하는 파일을 부팅마다
// 다시 쓰지 않는다.
func TestWriteFileIfChangedSkipsSameContent(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hook.sh")
	if err := WriteFileIfChanged(p, []byte("a"), 0o755); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(p)
	if err := WriteFileIfChanged(p, []byte("a"), 0o755); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(p)
	if !os.SameFile(before, after) {
		t.Fatal("같은 내용인데 파일을 교체했다")
	}
}

// 내용이 다르면 원자적으로 바꾼다(교체) — 제자리에서 자르고 쓰지 않는다.
func TestWriteFileIfChangedReplacesAtomically(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hook.sh")
	if err := os.WriteFile(p, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(p)
	// Windows 의 os.Stat 은 파일 ID 를 SameFile 이 처음 불릴 때 **경로로** 읽는다.
	// 교체 뒤에 읽으면 before 도 새 파일의 ID 를 갖게 되므로 지금 고정한다.
	os.SameFile(before, before)
	if err := WriteFileIfChanged(p, []byte("new"), 0o755); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "new" {
		t.Fatalf("내용=%q", b)
	}
	if os.SameFile(before, after) {
		t.Fatal("제자리에서 덮어썼다 — 읽는 쪽이 잘린 파일을 볼 수 있다")
	}
	if runtime.GOOS != "windows" && after.Mode().Perm() != 0o755 {
		t.Fatalf("mode=%v want 0755", after.Mode().Perm())
	}
}

// 내용이 같아도 권한이 다르면 맞춘다.
func TestWriteFileIfChangedFixesMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("windows 는 실행 비트가 없다")
	}
	p := filepath.Join(t.TempDir(), "hook.sh")
	if err := os.WriteFile(p, []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileIfChanged(p, []byte("a"), 0o755); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o755 {
		t.Fatalf("mode=%v want 0755", st.Mode().Perm())
	}
}
