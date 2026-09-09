//go:build !windows

package toolhub

// TOOL_HISTORY_ISOLATION_SRS TC-THI-9 — POSIX 권한 비트를 갖는 OS 에서만 뜻이 있다.
// 파일을 나누는 것이 이 저장소의 관례다 (installpaths_posix_test.go 와 같은 자리).

import (
	"os"
	"path/filepath"
	"testing"
)

// TC-THI-9: 권한 — 디렉터리 0700, 파일 0600 (FR-THI-4, NFR-THI-1).
func TestHistFile_Permissions(t *testing.T) {
	home, th := setHomes(t)
	if err := os.WriteFile(filepath.Join(th, ".zsh_history"), []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := histEnv(t, "tool-a", "/bin/zsh")["HISTFILE"]

	di, err := os.Stat(filepath.Join(home, toolHistDir))
	if err != nil {
		t.Fatal(err)
	}
	if got := di.Mode().Perm(); got != 0o700 {
		t.Fatalf("디렉터리 권한=%o want 700", got)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Fatalf("파일 권한=%o want 600", got)
	}
}
