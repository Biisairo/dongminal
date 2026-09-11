package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"dongminal/internal/helper/runtimebin"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/testpath"
)

// FR-AAP-8: claude.json must wire the activity hook (PreToolUse → working).
//
// V-AEV-9 (AGENT_EVENT_ABSTRACTION_SRS FR-AEV-20): **`notify` 배선은 없다.**
// 종전에는 `Stop`·`Notification` 에 `dmctl notify` 가 함께 걸려 있었고, 이 검사가
// 그것을 "보존되어야 한다" 고 단정했다. 알람이 활동 이벤트에서 파생되면서 그 배선은
// 같은 사실을 두 번 말하는 중복이 됐다 — 단정의 뜻을 뒤집는다.
func TestInstallAgentHooks_Activity(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	blob, err := os.ReadFile(filepath.Join(dir, "agent-hooks/claude.json"))
	if err != nil {
		t.Fatalf("read claude.json: %v", err)
	}
	s := string(blob)
	// 실행 파일 경로는 인용된다 (HOST_PARITY_SRS FR-HPR-4).
	if want := testpath.JSONInner(hookCommand(dmctlPath(dir), "activity", "claude")); !strings.Contains(s, want) {
		t.Fatalf("claude.json should invoke %q, got:\n%s", want, s)
	}
	if strings.Contains(s, "notify") {
		t.Fatalf("claude.json 에 notify 배선이 남았다 — 알람은 활동 이벤트에서 파생한다 (FR-AEV-20):\n%s", s)
	}
	var parsed struct {
		Hooks map[string]any `json:"hooks"`
	}
	if err := json.Unmarshal(blob, &parsed); err != nil {
		t.Fatalf("claude.json invalid JSON: %v", err)
	}
	for _, ev := range []string{"SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "SubagentStop", "Stop", "Notification"} {
		if _, ok := parsed.Hooks[ev]; !ok {
			t.Fatalf("claude.json must wire %s, got hooks: %v", ev, parsed.Hooks)
		}
	}
}

func TestInstallHelperSymlinks(t *testing.T) {
	dir := t.TempDir()
	// **덧없지 않은** 자기 경로로 잰다. `go test` 의 테스트 바이너리 자신이 임시
	// go-build 산출물이라 os.Executable() 을 쓰면 새 규칙(복사)에 걸린다
	// (HELPER_INSTALL_SRS FR-HLI-1). 여기서 재려는 것은 그 규칙이 아니라
	// **평범한 설치의 심링크 계약**이므로 조건을 고정한다.
	self := filepath.Join(t.TempDir(), "dongminal"+platform.Current().Paths.ExeSuffix())
	if err := os.WriteFile(self, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := installWith(dir, self); err != nil {
		t.Fatalf("Install: %v", err)
	}
	helpers := append([]string{}, runtimebin.HelperNames()...)
	sort.Strings(helpers)
	for _, name := range helpers {
		dst := filepath.Join(dir, helperFile(name))
		info, err := os.Lstat(dst)
		if err != nil {
			t.Errorf("missing helper %s: %v", name, err)
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(dst)
			if err != nil {
				t.Errorf("readlink %s: %v", name, err)
				continue
			}
			if target != self {
				t.Errorf("%s symlink target=%q want=%q", name, target, self)
			}
			continue
		}
		// fallback: regular file copy. Just ensure it's executable.
		// 실행 권한 비트는 NTFS 에 없다 — Windows 에서 실행 가능 여부를 정하는
		// 것은 확장자(.exe)이고, 그것은 위 helperFile 이 이미 본다 (FR-WTP-31).
		if !testpath.PermChecked() {
			continue
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("%s copy not executable: mode=%o", name, info.Mode().Perm())
		}
	}
}

func TestInstallIdempotent(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install #1: %v", err)
	}
	if err := Install(dir); err != nil {
		t.Fatalf("Install #2: %v", err)
	}
}
