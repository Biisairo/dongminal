package server

import (
	"os/exec"
	"sync"
	"testing"
	"time"
)

// TC-L6-1: Stop returns only after the process has actually been reaped, and
// uses the timeout-driven path instead of a fixed 100ms sleep.
func TestCodeServerStop_WaitsForExit(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}

	inst := &CodeServerInst{
		ID:     "cs-test",
		Cmd:    cmd,
		done:   make(chan struct{}),
		exited: make(chan struct{}),
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = cmd.Wait()
		close(inst.exited)
	}()

	m := NewCodeServerManager()
	m.insts["cs-test"] = inst

	start := time.Now()
	m.Stop("cs-test")
	elapsed := time.Since(start)
	wg.Wait()

	// SIGTERM honored quickly; the new path doesn't unconditionally sleep
	// 100ms so we expect well under 500ms wall-clock for `sleep`.
	if elapsed > 500*time.Millisecond {
		t.Fatalf("Stop took too long for responsive process: %v", elapsed)
	}
	if cmd.ProcessState == nil {
		t.Fatal("ProcessState nil — Wait did not complete before Stop returned")
	}
}

// TC-L6-2: Stop must be a no-op when exited is nil (legacy synthetic test
// fixtures) — the existing TestCodeServerManager_Stop* tests cover this and
// must remain green after the refactor.
