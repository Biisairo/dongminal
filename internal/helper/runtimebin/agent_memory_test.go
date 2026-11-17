package runtimebin

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"dongminal/internal/shared/runtime"
)

// AGENT_MEMORY_INJECTION_SRS TC-AMI-5.

const agentMemoryMaxBytes = 8 << 10

var hookOnlyDmctl = []string{"notify", "activity", "agent-context", "ctx-hook", "statusline", "subagent-statusline"}

func installedAgentMemory(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := runtime.Install(dir); err != nil {
		t.Fatalf("Install: %v", err)
	}
	b, err := os.ReadFile(filepath.Join(runtime.AgentMemoryDir(dir), "CLAUDE.md"))
	if err != nil {
		t.Fatalf("agent memory: %v", err)
	}
	return string(b)
}

func TestAgentMemoryCommandsExist(t *testing.T) {
	body := installedAgentMemory(t)
	seen := map[string]bool{}
	for _, m := range regexp.MustCompile("dmctl ([a-z][a-z-]*)").FindAllStringSubmatch(body, -1) {
		seen[m[1]] = true
	}
	if len(seen) == 0 {
		t.Fatal("no dmctl command documented")
	}
	for cmd := range seen {
		if !strings.Contains(dmctlHelp, "dmctl "+cmd) {
			t.Errorf("dmctl %s is not in dmctl --help", cmd)
		}
	}
	for _, h := range hookOnlyDmctl {
		if seen[h] {
			t.Errorf("hook-only command dmctl %s must not be documented", h)
		}
	}
}

func TestAgentMemoryLeavesEnvelopeToHook(t *testing.T) {
	body := installedAgentMemory(t)
	for _, tag := range []string{"[DONGMINAL-AGENT-MSG", "[DONGMINAL-PEER-MSG"} {
		if strings.Contains(body, tag) {
			t.Errorf("envelope header %q belongs to the SessionStart hook", tag)
		}
	}
	if len(body) > agentMemoryMaxBytes {
		t.Errorf("size %d > %d", len(body), agentMemoryMaxBytes)
	}
}
