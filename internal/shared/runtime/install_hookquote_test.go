package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/agentadapter"
)

// 훅 명령의 인용 (HOST_PARITY_SRS 묶음 B).
//
// Claude Code 는 Windows 에서 훅을 Git Bash 가 있으면 `bash -c`, 없으면 `cmd.exe`
// 로 실행한다. 무인용 백슬래시는 bash 에서 escape 로 소비되어
// `C:Usersfoo...` 가 되고, 공백은 cmd 에서 명령을 잘랐다 — 훅 전량이 무성
// 실패했다 (§2.2).

func TestHookCommand_QuotesExecutableOnly(t *testing.T) {
	// V-HPR-2: 실행 파일만 감싼다. 인자는 감싸지 않는다.
	got := (agentadapter.InstallSpec{Dmctl: `C:\Program Files\dm\dmctl.exe`}).HookCommand("notify", "done")
	want := `"C:\Program Files\dm\dmctl.exe" notify done`
	if got != want {
		t.Fatalf("hookCommand = %q, want %q", got, want)
	}
}

func TestHookCommand_NoArgs(t *testing.T) {
	if got := (agentadapter.InstallSpec{Dmctl: "/home/u/.dongminal/bin/dmctl"}).HookCommand(); got != `"/home/u/.dongminal/bin/dmctl"` {
		t.Fatalf("hookCommand = %q", got)
	}
}

// 설치가 실제로 쓴 파일에서 확인한다 — 헬퍼만 옳고 호출부가 옛 모양이면 뜻이 없다.
func TestInstallAgentHooks_AllCommandsQuoted(t *testing.T) {
	bin := t.TempDir()
	if err := installAgentAssets(bin); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(filepath.Join(bin, "agent-hooks", "claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, cmd := range hookCommandsIn(t, blob) {
		if !strings.HasPrefix(cmd, `"`) {
			t.Errorf("훅 명령이 인용되지 않았다: %q", cmd)
		}
		if strings.Count(cmd, `"`) != 2 {
			t.Errorf("실행 파일만 감싸야 한다: %q", cmd)
		}
	}
}

func TestInstallAgentPluginHooks_Quoted(t *testing.T) {
	// V-HPR-3: 플러그인 훅도 같은 자리를 지난다 (FR-HPR-5).
	bin := t.TempDir()
	plugin := filepath.Join(bin, "agent-plugin")
	if err := installAgentAssets(bin); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(filepath.Join(plugin, "hooks", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	cmds := hookCommandsIn(t, blob)
	if len(cmds) == 0 {
		t.Fatal("SessionStart 훅이 없다")
	}
	for _, cmd := range cmds {
		if !strings.HasPrefix(cmd, `"`) || strings.Count(cmd, `"`) != 2 {
			t.Errorf("플러그인 훅 명령이 인용되지 않았다: %q", cmd)
		}
	}
}

// 공백이 든 홈에서도 실행 파일 경로가 한 덩어리로 남아야 한다 (FR-HPR-6).
func TestInstallAgentHooks_SpaceInPath(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "Program Files", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := installAgentAssets(bin); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(filepath.Join(bin, "agent-hooks", "claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	want := `"` + dmctlPath(bin) + `"`
	for _, cmd := range hookCommandsIn(t, blob) {
		if !strings.HasPrefix(cmd, want) {
			t.Errorf("경로가 잘렸다: %q (want prefix %q)", cmd, want)
		}
	}
}

// hookCommandsIn 은 훅 설정에서 command 문자열을 모두 꺼낸다. 구조를 두 벌로
// 적지 않으려고 map 으로 훑는다.
func hookCommandsIn(t *testing.T, blob []byte) []string {
	t.Helper()
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
	var out []string
	for _, events := range doc.Hooks {
		for _, e := range events {
			for _, h := range e.Hooks {
				out = append(out, h.Command)
			}
		}
	}
	return out
}
