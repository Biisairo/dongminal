package toolhub

import (
	"path/filepath"
	"strings"
	"testing"
)

// 시드의 원본은 그 셸이 **평소 쓰는** 자리다 (HOST_PARITY_SRS FR-HPR-16).
//
// PowerShell 만 홈 밑의 점파일이 아니다. 종전에는 이 갈래가 없어
// `~/.powershell_history` 라는 실재하지 않는 파일을 원본으로 삼았고, Windows
// 사용자는 새 도구마다 빈 기록을 받았다 (§2.5).
func TestUserHistFilePowerShellUsesPSReadLinePath(t *testing.T) {
	// V-HPR-13a
	t.Setenv("APPDATA", filepath.Join("C:", "Users", "foo", "AppData", "Roaming"))
	for _, shell := range []string{"powershell", "pwsh"} {
		got := userHistFile(shell)
		if !strings.HasSuffix(got, "ConsoleHost_history.txt") {
			t.Errorf("%s: %q — PSReadLine 의 자리가 아니다", shell, got)
		}
		if !strings.Contains(got, "PSReadLine") {
			t.Errorf("%s: %q — PSReadLine 디렉터리를 지나지 않는다", shell, got)
		}
	}
}

// APPDATA 가 없는 처지에서는 원본이 없다. 빈 값이어야 하며, 그때 시드는 조용히
// 지나간다 (NFR-HPR-3).
func TestUserHistFilePowerShellWithoutAppData(t *testing.T) {
	t.Setenv("APPDATA", "")
	if got := userHistFile("powershell"); got != "" {
		t.Fatalf("userHistFile = %q, want 빈 값", got)
	}
}

// zsh·bash 는 종전 그대로다 — 홈 밑의 점파일이다.
func TestUserHistFilePosixUnchanged(t *testing.T) {
	for _, shell := range []string{"zsh", "bash"} {
		want := filepath.Join(toolHome(), "."+shell+"_history")
		if got := userHistFile(shell); got != want {
			t.Errorf("%s: userHistFile = %q, want %q", shell, got, want)
		}
	}
}
