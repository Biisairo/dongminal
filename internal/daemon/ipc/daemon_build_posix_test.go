//go:build !windows

package ipc

// DAEMON_STALENESS_SRS FR-DFP-4 의 권한 — POSIX 권한 비트를 갖는 OS 에서만 뜻이
// 있다. 파일을 나누는 것이 이 저장소의 관례다 (history_perm_posix_test.go 와
// 같은 자리) — 윈도우에서 `0600` 을 기대하면 OS 가 `0666` 을 답하고, 그때 지는
// 것은 제품이 아니라 검사다.

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// 지문 파일은 `paned.pid` 와 같은 권한이다 — 홈 안의 것은 그 사용자만 읽는다
// (04-secops P1-6). 같은 호스트의 다른 UID 가 이 홈의 것을 읽을 이유가 없다.
func TestFPPerm(t *testing.T) {
	home := t.TempDir()
	sock := shortPath(t, "d.sock")
	buildPath := filepath.Join(home, "paned.build")

	ps := NewPanedServer(toolhub.NewToolManager(home, nil), sock, "")
	ps.SetDaemonBuild(buildPath, "deadbeef12")
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	defer ps.Close()

	st, err := os.Stat(buildPath)
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("권한 %04o, want 0600", perm)
	}
}
