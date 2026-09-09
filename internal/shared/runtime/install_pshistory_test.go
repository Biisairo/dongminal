package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/platform"
)

// PowerShell 훅은 이 도구만의 히스토리를 되살린다
// (HOST_PARITY_SRS 묶음 E, FR-HPR-14).
//
// PSReadLine 은 `HISTFILE` 을 읽지 않는다 — 자기 경로를 쓰고, 그것을 바꾸는
// 길은 `Set-PSReadLineOption -HistorySavePath` 뿐이다. 그 배선이 없어서
// Windows 에서는 모든 도구가 히스토리 하나를 공유하고 있었다 (§2.5).
func TestPowerShellHookWiresHistorySavePath(t *testing.T) {
	// V-HPR-9
	src, err := shellhookFS.ReadFile("shellhooks/" + platform.WindowsHookRoot + "/" + platform.PowerShellHookFile)
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)

	if !strings.Contains(body, "Set-PSReadLineOption") {
		t.Fatal("HistorySavePath 배선이 없다 — 도구별 히스토리가 Windows 에서 무효다")
	}
	if !strings.Contains(body, "HistorySavePath") {
		t.Fatal("Set-PSReadLineOption 은 있으나 HistorySavePath 를 걸지 않는다")
	}
	// 값은 서버가 정한다 (FR-THI-20·D-7). 훅이 경로를 스스로 만들면 규칙이
	// 두 벌이 된다.
	if !strings.Contains(body, "DONGMINAL_HISTFILE") {
		t.Fatal("훅이 DONGMINAL_HISTFILE 을 딛지 않는다")
	}
	// 실패가 셸을 막지 않아야 한다 (FR-HPR-15).
	if !strings.Contains(body, "SilentlyContinue") && !strings.Contains(body, "try") {
		t.Fatal("PSReadLine 이 없는 처지를 견디는 장치가 없다")
	}
}

// 설치가 실제로 그 파일을 놓는지도 함께 본다 — 임베드만 옳고 전개가 빠지면 뜻이 없다.
func TestWindowsHookInstalledWithHistoryWiring(t *testing.T) {
	bin := t.TempDir()
	if err := unpackEmbedded(shellhookFS, "shellhooks/"+platform.WindowsHookRoot, bin); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(filepath.Join(bin, platform.PowerShellHookFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(blob), "HistorySavePath") {
		t.Fatal("전개된 훅에 HistorySavePath 가 없다")
	}
}
