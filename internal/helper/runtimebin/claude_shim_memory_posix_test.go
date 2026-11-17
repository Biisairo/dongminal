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

func TestClaudeShimInjectsMemoryDir(t *testing.T) {
	plugin, ran := memoryFixture(t, true)
	// 보안 검토: 실행 파일(훅)이 있는 플러그인 폴더는 작업 폴더로 열지 않는다 (FR-AMI-9).
	if err := os.RemoveAll(filepath.Join(filepath.Dir(plugin), "agent-plugin")); err != nil {
		t.Fatal(err)
	}
	_ = runClaude([]string{"질문"}, &bytes.Buffer{}, &bytes.Buffer{})
	want := []string{ran.path, "--add-dir=" + plugin, "질문"}
	if strings.Join(ran.argv, "|") != strings.Join(want, "|") {
		t.Fatalf("argv %v want %v", ran.argv, want)
	}
	if v, _ := envValue(ran.env, claudeAddDirMemoryEnv); v != "1" {
		t.Fatalf("env %q want 1", v)
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

func TestClaudeShimNoMemoryNoAddDir(t *testing.T) {
	_, ran := memoryFixture(t, false)
	_ = runClaude([]string{"x"}, &bytes.Buffer{}, &bytes.Buffer{})
	for _, a := range ran.argv {
		if strings.HasPrefix(a, "--add-dir") {
			t.Fatalf("unexpected %q in %v", a, ran.argv)
		}
	}
	if v, _ := envValue(ran.env, claudeAddDirMemoryEnv); v != "" {
		t.Fatalf("env %q want unset", v)
	}
}
