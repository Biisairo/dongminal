package agentadapter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// ISSUE_TREE_OPS_SRS FR-ITM-10: 맥락 훅은 PostToolUse·UserPromptSubmit 에 활동 훅과 나란히 선다.
func TestClaudeSettings_ContextHook(t *testing.T) {
	dir := t.TempDir()
	if err := writeClaudeActivityHooks(InstallSpec{Dir: dir, Dmctl: "/opt/dm/bin/dmctl"}); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(filepath.Join(dir, claudeHooksFile))
	var got struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(blob, &got); err != nil {
		t.Fatal(err)
	}
	const ctx = `"/opt/dm/bin/dmctl" ctx-hook claude`
	cmds := func(ev string) []string {
		var out []string
		for _, g := range got.Hooks[ev] {
			for _, h := range g.Hooks {
				out = append(out, h.Command)
			}
		}
		return out
	}
	for _, ev := range []string{"PostToolUse", "UserPromptSubmit"} {
		c := cmds(ev)
		if len(c) != 2 || c[1] != ctx {
			t.Errorf("%s 훅=%v", ev, c)
		}
	}
	for _, ev := range []string{"Stop", "PreToolUse", "SessionStart"} {
		for _, c := range cmds(ev) {
			if c == ctx {
				t.Errorf("%s 에 맥락 훅이 걸렸다", ev)
			}
		}
	}
}
