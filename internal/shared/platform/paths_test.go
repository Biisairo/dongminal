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

// V-LWP-1·2 (FR-LWP-3·4): Windows 의 실행 가능 판정은 **확장자**다.
//
// 이름만으로 하는 판정이므로 build tag 없이 컴파일되고, **darwin 호스트에서도**
// 검증된다 (이 패키지 머리말 §4.2). 개발 호스트에서 볼 수 없는 것을 CI 왕복으로만
// 확인하면 한 번에 하나씩밖에 배우지 못한다.
func TestWinExecutableName(t *testing.T) {
	const custom = ".EXE;.PY"
	cases := []struct {
		path    string
		pathext string
		want    bool
	}{
		// 기본 PATHEXT (빈 값이면 Windows 자신의 기본을 쓴다).
		{`C:\lsp\bin\gopls.exe`, "", true},
		{`C:\lsp\bin\gopls.EXE`, "", true},
		{`C:\lsp\node_modules\.bin\tsserver.cmd`, "", true},
		{`C:\x\a.bat`, "", true},
		{`C:\x\a.com`, "", true},
		// 확장자가 없으면 Windows 는 실행하지 못한다 — npm 이 함께 놓는 sh
		// 스크립트가 이 자리다.
		{`C:\lsp\node_modules\.bin\tsserver`, "", false},
		{`C:\x\a.ps1`, "", false},
		{`C:\x\a.txt`, "", false},
		// PATHEXT 를 사용자가 바꿨으면 그것을 따른다.
		{`C:\x\a.py`, custom, true},
		{`C:\x\a.cmd`, custom, false},
		// 구분자 주변의 공백과 점 없는 표기도 받아들인다.
		{`C:\x\a.py`, "EXE ; PY", true},
	}
	for _, c := range cases {
		if got := winExecutableName(c.path, c.pathext); got != c.want {
			t.Fatalf("winExecutableName(%q, %q) = %v, want %v", c.path, c.pathext, got, c.want)
		}
	}
}

// V-LWP-3 (FR-LWP-4): 어느 판정이든 디렉터리는 실행 파일이 아니다. 없는 경로도
// 마찬가지다 — 그것을 서버로 삼으면 기동이 우리 버그로 보이는 실패로 죽는다.
func TestIsExecutableRejectsDirAndMissing(t *testing.T) {
	dir := t.TempDir()
	for _, p := range []Paths{posixPaths{}, windowsPaths{}} {
		if p.IsExecutable(dir) {
			t.Fatalf("%T 가 디렉터리를 실행 파일이라 했다", p)
		}
		if p.IsExecutable(filepath.Join(dir, "nope.exe")) {
			t.Fatalf("%T 가 없는 경로를 실행 파일이라 했다", p)
		}
		if p.IsExecutable("") {
			t.Fatalf("%T 가 빈 경로를 실행 파일이라 했다", p)
		}
	}
}

// V-LWP-3 (FR-LWP-2): POSIX 의 판정은 바뀌지 않았다 — 실행 비트가 서야 한다.
func TestPosixIsExecutableNeedsExecBit(t *testing.T) {
	if Current().OS == Windows {
		t.Skip("Windows 는 권한 비트를 갖지 않는다 (FR-LWP-3)")
	}
	dir := t.TempDir()
	plain := filepath.Join(dir, "plain")
	if err := os.WriteFile(plain, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if (posixPaths{}).IsExecutable(plain) {
		t.Fatal("실행 비트 없는 파일을 실행 가능이라 했다")
	}
	exe := filepath.Join(dir, "exe")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !(posixPaths{}).IsExecutable(exe) {
		t.Fatal("실행 비트 있는 파일을 실행 불가라 했다")
	}
}

// FR-XPL-5: `file://` URI 의 모양은 OS 마다 다르다. **두 갈래 모두 어느
// 호스트에서도 검증된다** — 어댑터에 build tag 가 없기 때문이다 (§4.2).
//
// 종전에는 이 판단이 `lsp/session.go` 안의 `runtime.GOOS` 였고, 그래서 Windows
// 갈래는 CI 왕복으로만 확인할 수 있었다.
func TestFileURIShapePerOS(t *testing.T) {
	cases := []struct {
		name string
		p    Paths
		path string
		want string
	}{
		// POSIX 의 절대경로는 이미 `/` 로 시작한다.
		{"posix", posixPaths{}, "/a/b.go", "file:///a/b.go"},
		// Windows 는 드라이브 문자로 시작하므로 `/` 를 하나 더한다. 더하지
		// 않으면 `file://C:/a/b.go` 가 되어 `C:` 가 **호스트**로 읽힌다.
		{"windows", windowsPaths{}, `C:\a\b.go`, "file:///C:/a/b.go"},
	}
	for _, c := range cases {
		if got := c.p.FileURI(c.path); got != c.want {
			t.Fatalf("%s: FileURI(%q) = %q, want %q", c.name, c.path, got, c.want)
		}
	}
}

// 왕복이 경로를 바꾸지 않는다. 공백과 한글이 요점이다 — URI 를 손으로 이어
// 붙이면 그런 경로에서 서버가 우리가 말한 파일을 못 찾는다.
func TestFileURIRoundTripPerOS(t *testing.T) {
	cases := []struct {
		name  string
		p     Paths
		paths []string
	}{
		{"posix", posixPaths{}, []string{"/a/b/c.go", "/a/b c/d.go", "/a/한글/e.go"}},
		{"windows", windowsPaths{}, []string{`C:\a\b.go`, `C:\a b\c.go`, `C:\한글\e.go`}},
	}
	for _, c := range cases {
		for _, want := range c.paths {
			u := c.p.FileURI(want)
			got, err := c.p.PathFromFileURI(u)
			if err != nil {
				t.Fatalf("%s: %q → %q → 실패: %v", c.name, want, u, err)
			}
			if got != want {
				t.Fatalf("%s: 왕복이 경로를 바꿨다: %q → %q → %q", c.name, want, u, got)
			}
		}
	}
}

// `file:` 이 아닌 것은 오류다. 침묵하고 빈 경로를 내면 그 다음 실패가 "정의가
// 없다" 로 보이고, 원인이 URI 였다는 사실이 사라진다.
func TestPathFromFileURIRejectsNonFile(t *testing.T) {
	for _, p := range []Paths{posixPaths{}, windowsPaths{}} {
		for _, uri := range []string{"", "http://x/a.go", "::not a uri::"} {
			if _, err := p.PathFromFileURI(uri); err == nil {
				t.Fatalf("%T 가 %q 를 받아들였다", p, uri)
			}
		}
	}
}
