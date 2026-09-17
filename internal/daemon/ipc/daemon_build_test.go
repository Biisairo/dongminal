package ipc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// DAEMON_STALENESS_SRS FR-DFP-4 — 도는 데몬이 자기 지문을 남긴다.
//
// 남기지 않으면 빌드 스크립트도 `start` 도 `health` 도 **소켓에 붙어야만**
// 도는 것이 무엇인지 알 수 있고, 그 경로는 데몬이 멎었을 때 — 판정이 가장
// 필요한 때 — 답하지 않는다 (NFR-DFP-2).
func TestListenWritesFP(t *testing.T) {
	home := t.TempDir()
	// 소켓은 짧은 자리에 둔다 — 유닉스 종단 경로에는 길이 상한이 있어 검사
	// 이름이 긴 것만으로 bind 가 실패한다 (기존 검사들의 shortPath 와 같은 근거).
	sock := shortPath(t, "d.sock")
	buildPath := filepath.Join(home, "paned.build")

	ps := NewPanedServer(toolhub.NewToolManager(home, nil), sock, "")
	ps.SetDaemonBuild(buildPath, "deadbeef12")
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	defer ps.Close()

	blob, err := os.ReadFile(buildPath)
	if err != nil {
		t.Fatalf("지문 파일이 없다: %v", err)
	}
	if got := strings.TrimSpace(string(blob)); got != "deadbeef12" {
		t.Fatalf("지문 %q, want deadbeef12", got)
	}
}

// FR-DFP-5 — 지문을 모르는 데몬은 앞선 데몬이 남긴 것을 **지운다**.
//
// 남겨 두면 그 값이 지금 도는 데몬의 것인 양 읽히고, 판정은 "일치" 를 말한다.
// 침묵보다 나쁜 것은 틀린 말이다.
func TestListenClearsFP(t *testing.T) {
	home := t.TempDir()
	// 소켓은 짧은 자리에 둔다 — 유닉스 종단 경로에는 길이 상한이 있어 검사
	// 이름이 긴 것만으로 bind 가 실패한다 (기존 검사들의 shortPath 와 같은 근거).
	sock := shortPath(t, "d.sock")
	buildPath := filepath.Join(home, "paned.build")

	if err := os.WriteFile(buildPath, []byte("앞선데몬\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	ps := NewPanedServer(toolhub.NewToolManager(home, nil), sock, "")
	ps.SetDaemonBuild(buildPath, "") // 손으로 `go build` 한 바이너리가 이 상태다
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	defer ps.Close()

	if _, err := os.Stat(buildPath); !os.IsNotExist(err) {
		blob, _ := os.ReadFile(buildPath)
		t.Fatalf("앞선 데몬의 지문이 남아 있다: %q (err=%v)", blob, err)
	}
}

// 자리를 주지 않으면 아무것도 쓰지 않는다 — 검사와 직접 모드가 그 상태다.
func TestListenSkipsFP(t *testing.T) {
	home := t.TempDir()
	// 소켓은 짧은 자리에 둔다 — 유닉스 종단 경로에는 길이 상한이 있어 검사
	// 이름이 긴 것만으로 bind 가 실패한다 (기존 검사들의 shortPath 와 같은 근거).
	sock := shortPath(t, "d.sock")

	ps := NewPanedServer(toolhub.NewToolManager(home, nil), sock, "")
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	defer ps.Close()

	if _, err := os.Stat(filepath.Join(home, "paned.build")); !os.IsNotExist(err) {
		t.Fatalf("자리를 주지 않았는데 파일이 생겼다 (err=%v)", err)
	}
}
