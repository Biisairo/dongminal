package agentadapter

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
)

// PEER_NETWORK_SRS FR-PNW-51·56·57: 전경 프로그램 이름으로 에이전트를 찾는다.
func TestByCommand(t *testing.T) {
	for _, id := range IDs() {
		ad, _ := Get(id)
		got, ok := ByCommand(ad.DetectCmd)
		if !ok || got.ID != id {
			t.Errorf("ByCommand(%q) = %q %v", ad.DetectCmd, got.ID, ok)
		}
	}
	for _, name := range []string{"", "zsh", "bash", "node"} {
		if _, ok := ByCommand(name); ok {
			t.Errorf("ByCommand(%q) 가 에이전트다", name)
		}
	}
}

// FR-PNW-50·58: 설치 여부는 DONGMINAL_AGENT_BIN_DIR 을 먼저, 그다음 PATH 를 본다.
func TestInstalled(t *testing.T) {
	if !testpath.PermChecked() {
		t.Skip("실행 비트로 실행 파일을 만드는 검사다 (Windows 는 확장자로 가른다)")
	}
	ad, _ := Get("claude")
	empty := t.TempDir()
	t.Setenv("PATH", empty)
	t.Setenv(dmenv.EnvAgentBinDir, "")
	if ad.Installed() {
		t.Fatal("PATH 가 비었는데 설치됐다고 한다")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, ad.DetectCmd), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(dmenv.EnvAgentBinDir, bin)
	if !ad.Installed() {
		t.Fatal("DONGMINAL_AGENT_BIN_DIR 의 실행 파일을 보지 않았다")
	}
	t.Setenv(dmenv.EnvAgentBinDir, "")
	t.Setenv("PATH", bin)
	if !ad.Installed() {
		t.Fatal("PATH 의 실행 파일을 보지 않았다")
	}
}
