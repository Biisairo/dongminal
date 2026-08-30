package platform

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/testpath"
)

func TestWindowsLogFileUsesLocalAppData(t *testing.T) {
	env := func(k string) string {
		if k == "LOCALAPPDATA" {
			return filepath.Join("C:", "Users", "u", "AppData", "Local")
		}
		return ""
	}
	got := windowsLogFile(env, func() string { return "T:" })
	want := filepath.Join("C:", "Users", "u", "AppData", "Local", "dongminal", "dongminal.log")
	if got != want {
		t.Fatalf("windowsLogFile = %q, want %q", got, want)
	}
}

// LOCALAPPDATA 가 없는 환경(서비스 계정 등)에서도 로그 자리는 있어야 한다.
func TestWindowsLogFileFallsBackToTemp(t *testing.T) {
	got := windowsLogFile(func(string) string { return "" }, func() string { return filepath.Join("C:", "Temp") })
	want := filepath.Join("C:", "Temp", "dongminal.log")
	if got != want {
		t.Fatalf("windowsLogFile = %q, want %q", got, want)
	}
}

func TestCopyExecutable(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	dst := filepath.Join(dir, "dst")
	if err := os.WriteFile(src, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := copyExecutable(src, dst); err != nil {
		t.Fatalf("copyExecutable: %v", err)
	}
	blob, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(blob) != "payload" {
		t.Fatalf("내용 = %q", blob)
	}
	// 권한 비트는 NTFS 에 없다 — Go 는 모든 파일을 -rw-rw-rw- 로 보고한다.
	// 내용 복사는 어느 OS 에서나 검증하고, 실행 비트만 조건부로 본다
	// (FR-WTP-31: 이식 가능한 절반을 함께 빼지 않는다).
	if !testpath.PermChecked() {
		return
	}
	fi, err := os.Stat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm()&0o111 == 0 {
		t.Fatalf("실행 권한이 없다: %v", fi.Mode())
	}
}

// 이미 있는 대상을 덮어쓸 수 있어야 한다 — 바이너리가 갱신되면 매 기동마다
// 같은 자리에 다시 쓴다.
func TestCopyExecutableOverwrites(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	dst := filepath.Join(dir, "dst")
	if err := os.WriteFile(src, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("old-and-longer"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := copyExecutable(src, dst); err != nil {
		t.Fatalf("copyExecutable: %v", err)
	}
	blob, _ := os.ReadFile(dst)
	if string(blob) != "new" {
		t.Fatalf("내용 = %q — 잘린 덮어쓰기가 아니다", blob)
	}
}

func TestCurrentIsStable(t *testing.T) {
	a, b := Current(), Current()
	if a.OS != b.OS {
		t.Fatalf("OS 가 호출마다 다르다: %q vs %q", a.OS, b.OS)
	}
	if a.Paths == nil || a.Browser == nil {
		t.Fatal("Current() 가 채우지 않은 필드가 있다")
	}
	switch a.OS {
	case Darwin, Linux, WSL, Windows:
	default:
		t.Fatalf("알 수 없는 OSKind: %q", a.OS)
	}
}

func TestExeSuffixMatchesBuild(t *testing.T) {
	got := Current().Paths.ExeSuffix()
	want := ""
	if Current().OS == Windows {
		want = ".exe"
	}
	if got != want {
		t.Fatalf("ExeSuffix = %q, want %q", got, want)
	}
}
