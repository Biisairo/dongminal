package toolhub

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// 2026-09-16 — **모르는 자리를 상대경로로 만들지 않는다.**
//
// 종전에는 `filepath.Join(os.Getenv(DONGMINAL_HOME), "bin")` 이었고, 그 변수가
// 비면 결과가 **`bin`** 이었다. 그 값은 두 자리로 흘렀다:
//
//	셸 훅   — 도구의 cwd 기준으로 풀린다. 사용자의 저장소에 같은 이름의 파일이
//	          있으면 그것이 실행된다 (임의 코드 실행)
//	PATH    — 그 자리가 얹혀 cwd 의 실행 파일이 우선될 수 있다
//
// Windows 에서 PowerShell 이 `\` 앞을 모듈 이름으로 읽어
// `.: The module 'bin' could not be loaded.` 를 빨갛게 찍으며 드러났다.
func TestToolBinDir_EmptyHomeIsEmptyNotRelative(t *testing.T) {
	t.Setenv(dmenv.EnvHome, "")
	if got := toolBinDir(); got != "" {
		t.Fatalf("toolBinDir() = %q — 빈 홈은 빈 값이어야 한다 (상대경로 금지)", got)
	}
}

func TestToolBinDir_KnownHomeIsAbsoluteJoin(t *testing.T) {
	home := t.TempDir()
	t.Setenv(dmenv.EnvHome, home)
	want := filepath.Join(home, "bin")
	if got := toolBinDir(); got != want {
		t.Fatalf("toolBinDir() = %q, want %q", got, want)
	}
}

// PATH 에 **빈 조각을 얹지 않는다.** `PATH=…:` 의 끝 구분자 뒤는 POSIX 에서
// "현재 디렉터리" 로 읽힌다 — 자리를 모르는 것이 cwd 를 뒤지는 근거가 될 수 없다.
func TestToolPath_EmptyBinDirAddsNothing(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	if got := toolPath(""); got != "/usr/bin" {
		t.Fatalf("toolPath(\"\") = %q — 아무것도 더하지 않아야 한다", got)
	}
	if got := toolPath("/x/bin"); !strings.HasSuffix(got, string(os.PathListSeparator)+"/x/bin") {
		t.Fatalf("toolPath(/x/bin) = %q — 아는 자리는 끝에 붙는다", got)
	}
}
