package agentadapter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// ISSUE_AGENT_TREE_SRS FR-SLP-1: dongminal 이 넘기는 claude 설정에 statusLine 프록시가 선다.
// 명령은 훅과 같은 절대경로 dmctl 이고, 프록시는 자기 자신을 하위 명령으로 고르지 않는다
// (`dmctl" statusline` 모양 — runtimebin.slSelf).
func TestClaudeSettings_StatusLineProxy(t *testing.T) {
	dir := t.TempDir()
	s := InstallSpec{Dir: dir, Dmctl: "/opt/dm/bin/dmctl"}
	if err := writeClaudeActivityHooks(s); err != nil {
		t.Fatal(err)
	}
	blob, _ := os.ReadFile(filepath.Join(dir, claudeHooksFile))
	var got struct {
		StatusLine struct {
			Type    string `json:"type"`
			Command string `json:"command"`
		} `json:"statusLine"`
		Hooks map[string]any `json:"hooks"`
	}
	if err := json.Unmarshal(blob, &got); err != nil {
		t.Fatal(err)
	}
	if got.StatusLine.Type != "command" || got.StatusLine.Command != `"/opt/dm/bin/dmctl" statusline` {
		t.Fatalf("statusLine=%+v", got.StatusLine)
	}
	if len(got.Hooks) != len(claudeHookEvents) {
		t.Errorf("훅이 바뀌었다: %d", len(got.Hooks))
	}
}
