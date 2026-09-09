//go:build !windows

package runtime

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 훅 명령이 **실제 셸에서 실행되는지** 잰다 (HOST_PARITY_SRS FR-HPR-6).
//
// `install_hookquote_test.go` 는 명령의 **모양**을 고정한다. 그것만으로는
// 부족하다 — 이 묶음이 고친 결함은 모양이 아니라 셸이 그 문자열을 어떻게 읽느냐
// 였고, 그것은 셸을 실제로 띄워야만 드러난다 (bash 훅 검사와 같은 사정).
//
// Windows 갈래는 여기서 잴 수 없다. 러너에 Git Bash 가 있으면 Claude Code 가
// 훅을 그것으로 돌리지만(§2.2), 그 조건은 이 저장소가 만들 수 있는 것이 아니다.
// 공백이 든 경로는 POSIX 에서도 종전 무인용 명령을 깨뜨렸으므로, 같은 결함을
// 여기서 재현할 수 있다.
func TestHookCommandRunsUnderPosixShells(t *testing.T) {
	// V-HPR-2 의 실동작 절반.
	bin := filepath.Join(t.TempDir(), "My Tools", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	// dmctl 자리에 "무엇으로 불렸는지" 를 찍는 스크립트를 놓는다.
	script := "#!/bin/sh\necho \"CALLED args=$*\"\n"
	if err := os.WriteFile(filepath.Join(bin, "dmctl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := installAgentHooks(bin); err != nil {
		t.Fatal(err)
	}

	blob, err := os.ReadFile(filepath.Join(bin, "agent-hooks", "claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(blob, &doc); err != nil {
		t.Fatal(err)
	}
	stop := doc.Hooks["Stop"]
	if len(stop) == 0 || len(stop[0].Hooks) == 0 {
		t.Fatal("Stop 훅이 없다")
	}
	cmd := stop[0].Hooks[0].Command

	// 훅을 무엇이 실행할지 우리가 정하지 못하므로 셋 모두에서 같아야 한다.
	for _, sh := range []string{"sh", "bash", "zsh"} {
		if _, err := exec.LookPath(sh); err != nil {
			continue
		}
		out, err := exec.Command(sh, "-c", cmd).CombinedOutput()
		if err != nil {
			t.Errorf("%s: %v\n%s", sh, err, out)
			continue
		}
		if !strings.Contains(string(out), "CALLED args=notify done") {
			t.Errorf("%s: 인자가 온전히 가지 않았다: %q", sh, out)
		}
	}
}
