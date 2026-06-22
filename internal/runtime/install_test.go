package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"dongminal/internal/runtimebin"
)

func TestInstallShellHooks(t *testing.T) {
	dir := t.TempDir()
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	want := map[string]os.FileMode{
		"bash-hook.sh":            0o755,
		"zdotdir/.zshrc":          0o644,
		"agent-hooks/claude.json": 0o644,
	}
	for rel, wantMode := range want {
		info, err := os.Stat(filepath.Join(dir, rel))
		if err != nil {
			t.Errorf("missing %s: %v", rel, err)
			continue
		}
		if got := info.Mode().Perm(); got != wantMode {
			t.Errorf("%s: mode=%o want=%o", rel, got, wantMode)
		}
	}
	// The installed claude hooks file must be valid JSON (claude --settings
	// rejects malformed input, which would break the wrapper).
	blob, err := os.ReadFile(filepath.Join(dir, "agent-hooks/claude.json"))
	if err != nil {
		t.Fatalf("read claude.json: %v", err)
	}
	var parsed any
	if err := json.Unmarshal(blob, &parsed); err != nil {
		t.Fatalf("claude.json is not valid JSON: %v", err)
	}
	// Hook commands must reference dmctl by absolute path (PATH-independent).
	wantCmd := filepath.Join(dir, "dmctl") + " notify"
	if !strings.Contains(string(blob), wantCmd) {
		t.Fatalf("claude.json should invoke %q, got:\n%s", wantCmd, blob)
	}
}

// FR-AAP-8: claude.json must also wire the activity hook (PreToolUse → working)
// while preserving the existing attention notify hooks.
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
	if want := filepath.Join(dir, "dmctl") + " activity claude"; !strings.Contains(s, want) {
		t.Fatalf("claude.json should invoke %q, got:\n%s", want, s)
	}
	if want := filepath.Join(dir, "dmctl") + " notify done"; !strings.Contains(s, want) {
		t.Fatalf("attention notify hook must be preserved %q, got:\n%s", want, s)
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
	if err := Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	helpers := append([]string{}, runtimebin.HelperNames()...)
	sort.Strings(helpers)
	for _, name := range helpers {
		dst := filepath.Join(dir, name)
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
