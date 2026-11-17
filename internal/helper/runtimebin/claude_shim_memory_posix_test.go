//go:build !windows

package runtimebin

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AGENT_MEMORY_INJECTION_SRS TC-AMI-2·3·4.

// claudeAddDirMemoryEnv 는 shim 이 더 이상 건드리지 않는 Claude Code 환경 변수다 (FR-AMI-3).
const claudeAddDirMemoryEnv = "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"

func memoryFixture(t *testing.T, withMemory bool) (plugin string, ran *shimRun) {
	t.Helper()
	home, _, ran := shimFixture(t)
	shimServer(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"source":"none"}`)) })
	plugin = filepath.Join(home, "bin", "agent-memory")
	if err := os.MkdirAll(plugin, 0o755); err != nil {
		t.Fatal(err)
	}
	if withMemory {
		if err := os.WriteFile(filepath.Join(plugin, "CLAUDE.md"), []byte("# m\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv(claudeAddDirMemoryEnv, "")
	return plugin, ran
}

func TestClaudeShimInjectsMemoryPrompt(t *testing.T) {
	plugin, ran := memoryFixture(t, true)
	_ = runClaude([]string{"질문"}, &bytes.Buffer{}, &bytes.Buffer{})
	want := []string{ran.path, "--append-system-prompt=# m\n", "질문"}
	if strings.Join(ran.argv, "|") != strings.Join(want, "|") {
		t.Fatalf("argv %q want %q", ran.argv, want)
	}
	// D-AMI-1: 폴더를 열지 않는다 — 신뢰 확인창과 접근 권한이 따라온다 (FR-AMI-9).
	for _, a := range ran.argv {
		if strings.HasPrefix(a, "--add-dir") || strings.Contains(a, plugin) {
			t.Fatalf("unexpected %q in %v", a, ran.argv)
		}
	}
	if v, ok := envValue(ran.env, claudeAddDirMemoryEnv); ok && v != "" {
		t.Fatalf("env %q want unset", v)
	}
}

func TestClaudeShimKeepsUserMemoryEnv(t *testing.T) {
	_, ran := memoryFixture(t, true)
	t.Setenv(claudeAddDirMemoryEnv, "0")
	_ = runClaude(nil, &bytes.Buffer{}, &bytes.Buffer{})
	if v, _ := envValue(ran.env, claudeAddDirMemoryEnv); v != "0" {
		t.Fatalf("env %q want 0", v)
	}
}

func TestClaudeShimNoMemoryNoPrompt(t *testing.T) {
	_, ran := memoryFixture(t, false)
	_ = runClaude([]string{"x"}, &bytes.Buffer{}, &bytes.Buffer{})
	for _, a := range ran.argv {
		if strings.HasPrefix(a, "--append-system-prompt") || strings.HasPrefix(a, "--add-dir") {
			t.Fatalf("unexpected %q in %v", a, ran.argv)
		}
	}
}

// FR-AMI-4: 빈 파일은 붙이지 않는다.
func TestClaudeShimEmptyMemoryNoPrompt(t *testing.T) {
	plugin, ran := memoryFixture(t, true)
	if err := os.WriteFile(filepath.Join(plugin, "CLAUDE.md"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	_ = runClaude([]string{"x"}, &bytes.Buffer{}, &bytes.Buffer{})
	for _, a := range ran.argv {
		if strings.HasPrefix(a, "--append-system-prompt") {
			t.Fatalf("unexpected %q in %v", a, ran.argv)
		}
	}
}
