package dmenv

import "testing"

// FR-OPT-10-2 (HTTP-22 · SHR-19): 홈 아래 이름은 디스크의 계약이다 — 값이 바뀌면
// 옛 홈의 상태를 읽지 못한다. 상수로 모으는 것이 값을 바꾸는 일이 되지 않게 못박는다.
func TestHomeFileNames(t *testing.T) {
	for got, want := range map[string]string{
		WorkspaceFile:   "workspace.json",
		SettingsFile:    "settings.json",
		AccessFile:      "access.json",
		LSPPathsFile:    "lsp-paths.json",
		ToolsFile:       "tools.json",
		PanesFile:       "panes.json",
		PanedPIDFile:    "paned.pid",
		ServerLogFile:   "server.log",
		DaemonLogFile:   "daemon.log",
		BinDir:          "bin",
		NotesDir:        "notes",
		WorktreesDir:    "worktrees",
		GitWorktreesDir: "git-worktrees",
		ExtDir:          "ext",
	} {
		if got != want {
			t.Errorf("%q, want %q", got, want)
		}
	}
}

// SHR-30: 비었을 때만 기본값이다.
func TestOr(t *testing.T) {
	const name = "DONGMINAL_TEST_OR"
	t.Setenv(name, "")
	if got := Or(name, "fb"); got != "fb" {
		t.Fatalf("빈 값 → %q, want fb", got)
	}
	t.Setenv(name, "v")
	if got := Or(name, "fb"); got != "v" {
		t.Fatalf("설정된 값 → %q, want v", got)
	}
}
