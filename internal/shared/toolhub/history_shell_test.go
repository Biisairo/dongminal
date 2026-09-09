package toolhub

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/testpath"
)

// installHooksForTest 는 훅 자산을 **설치된 자리**에 놓는다.
//
// zsh 에서 이것이 없으면 검사가 뜻을 잃는다. `/etc/zshrc` 가 `HISTFILE` 을
// `${ZDOTDIR:-$HOME}/.zsh_history` 로 덮으므로(SRS §2.2), 환경으로 심은 값을
// 되살리는 것은 `<ZDOTDIR>/.zshrc` 한 줄뿐이다. 그 줄이 실제로 이기는지가
// 이 검사의 대상이다.
func installHooksForTest(t *testing.T, instHome string) {
	t.Helper()
	src := filepath.Join("..", "runtime", "shellhooks", "posix", "zdotdir", ".zshrc")
	blob, err := os.ReadFile(src)
	if err != nil {
		t.Skipf("훅 원본을 읽지 못했다(%s): %v", src, err)
	}
	dir := filepath.Join(instHome, "bin", "zdotdir")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".zshrc"), blob, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TC-THI-20·23: 실제로 뜬 셸이 **자기** 히스토리 파일을 본다.
//
// 순수 함수 검사(history_test.go)만으로는 잡히지 않는 두 가지가 여기서 잡힌다 —
// `StartTool` 이 환경을 실제로 심는가, 그리고 zsh 의 rc 사슬을 지나고도 그 값이
// 남는가.
func TestStartTool_ShellSeesOwnHistFile(t *testing.T) {
	if !testpath.POSIXShell() {
		t.Skip("$HISTFILE 을 셸에게 되묻는 POSIX 문법이다")
	}
	instHome, iso := t.TempDir(), t.TempDir()
	t.Setenv(dmenv.EnvHome, instHome)
	t.Setenv(dmenv.EnvToolHome, iso)
	installHooksForTest(t, instHome)

	shell := platform.Current().Shell.Shell(filepath.Join(instHome, "bin")).Path
	want := "HF(" + filepath.Join(instHome, toolHistDir, "t-hist."+histShellName(shell)) + ")"

	p, err := StartTool("t-hist", "hist", iso, 80, 24, nil, nil, nil)
	if err != nil {
		t.Fatalf("StartTool: %v", err)
	}
	defer p.kill()

	time.Sleep(500 * time.Millisecond)
	if err := p.Write([]byte("printf 'HF(%s)\\n' \"$HISTFILE\"\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		blob, _ := p.Stream().Snapshot()
		if strings.Contains(string(blob), want) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	blob, _ := p.Stream().Snapshot()
	t.Fatalf("셸이 자기 히스토리를 보지 못했습니다. want %q, got:\n%s", want, blob)
}

// TC-THI-22: 도구를 써도 사용자(=도구 홈)의 히스토리는 변하지 않는다.
//
// 두 도구가 서로의 명령을 보지 않는다는 것(TC-THI-20)의 다른 쪽 면이다 — 공유
// 파일에 아무도 붙이지 않아야 그것이 성립한다.
func TestStartTool_LeavesSharedHistoryAlone(t *testing.T) {
	if !testpath.POSIXShell() {
		t.Skip("POSIX 셸 전용")
	}
	instHome, iso := t.TempDir(), t.TempDir()
	t.Setenv(dmenv.EnvHome, instHome)
	t.Setenv(dmenv.EnvToolHome, iso)
	installHooksForTest(t, instHome)

	shell := platform.Current().Shell.Shell(filepath.Join(instHome, "bin")).Path
	shared := filepath.Join(iso, "."+histShellName(shell)+"_history")
	if err := os.WriteFile(shared, []byte("original\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	p, err := StartTool("t-share", "share", iso, 80, 24, nil, nil, nil)
	if err != nil {
		t.Fatalf("StartTool: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	if err := p.Write([]byte("echo tool_only_command\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	p.kill()
	time.Sleep(500 * time.Millisecond)

	blob, err := os.ReadFile(shared)
	if err != nil {
		t.Fatalf("공유 히스토리를 읽지 못했다: %v", err)
	}
	if strings.Contains(string(blob), "tool_only_command") {
		t.Fatalf("도구의 명령이 공유 히스토리에 남았다:\n%s", blob)
	}
	// 시드는 **복사**다 — 원본이 사라지거나 잘리면 안 된다.
	if !strings.Contains(string(blob), "original") {
		t.Fatalf("공유 히스토리의 원래 내용이 사라졌다:\n%s", blob)
	}
}
