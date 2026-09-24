//go:build !windows

package core

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
)

// REPO_FIX 01 P-1·P-3 — 기동 헬퍼 하나가 신호 시퀀스를 갖는다.

func shortGrace(t *testing.T, d time.Duration) {
	t.Helper()
	prev := killGrace
	killGrace = d
	t.Cleanup(func() { killGrace = prev })
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) consume(r io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			s.mu.Lock()
			s.b.Write(buf[:n])
			s.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func alive(pid int) bool { return platform.Current().Process.Alive(pid) }

func readPid(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		b, err := os.ReadFile(path)
		if err == nil {
			if pid, perr := strconv.Atoi(strings.TrimSpace(string(b))); perr == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("자손 pid 를 얻지 못했다")
	return 0
}

func waitDead(pid int, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if !alive(pid) {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return !alive(pid)
}

// P-3 B: 리더가 정상 종료했는데 출력을 리다이렉트하지 않은 백그라운드 자식이
// 파이프를 쥐고 있으면, 반환은 리더 종료 + 2G 안이고 그 자식은 그룹 SIGKILL 로
// 끝난다. 이전에는 자식이 끝날 때까지 매달렸다.
func TestSpawn_NormalExitReturnsDespitePipeHolder(t *testing.T) {
	shortGrace(t, 200*time.Millisecond)
	pidFile := filepath.Join(t.TempDir(), "bg.pid")
	cmd := exec.CommandContext(context.Background(), "/bin/sh", "-c", "sleep 30 & echo $! > "+pidFile+"; echo done")
	var out, errb syncBuf
	start := time.Now()
	err := Spawn(context.Background(), cmd, out.consume, errb.consume)
	took := time.Since(start)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 0 {
		t.Fatalf("exit 가 0 이 아니다: %v", cmd.ProcessState)
	}
	if !strings.Contains(out.String(), "done") {
		t.Fatalf("stdout 을 잃었다: %q", out.String())
	}
	if took > 2*killGrace+time.Second {
		t.Fatalf("반환이 %v 걸렸다 — 상한 2G(+여유) 초과", took)
	}
	if bg := readPid(t, pidFile); !waitDead(bg, 2*time.Second) {
		t.Fatalf("파이프를 쥔 자식 %d 가 살아 있다", bg)
	}
}

// P-3 A: 시한이 지나면 그룹 SIGTERM → (TERM 을 무시하면) 리더 SIGKILL → 그룹
// SIGKILL. 반환은 시한 + 2G 안이고 손자도 끝난다.
func TestSpawn_DeadlineKillsWholeGroup(t *testing.T) {
	shortGrace(t, 200*time.Millisecond)
	pidFile := filepath.Join(t.TempDir(), "gc.pid")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", "trap '' TERM; sleep 30 & echo $! > "+pidFile+"; sleep 30")
	var out, errb syncBuf
	start := time.Now()
	_ = Spawn(ctx, cmd, out.consume, errb.consume)
	took := time.Since(start)
	if took > 300*time.Millisecond+2*killGrace+time.Second {
		t.Fatalf("반환이 %v 걸렸다 — 시한+2G 초과", took)
	}
	if gc := readPid(t, pidFile); !waitDead(gc, 2*time.Second) {
		t.Fatalf("손자 %d 가 살아 있다", gc)
	}
}

// P-3: stdin 을 넘기면 자식이 읽는다.
func TestSpawn_Stdin(t *testing.T) {
	cmd := exec.CommandContext(context.Background(), "/bin/sh", "-c", "cat")
	cmd.Stdin = strings.NewReader("hello")
	var out, errb syncBuf
	if err := Spawn(context.Background(), cmd, out.consume, errb.consume); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if out.String() != "hello" {
		t.Fatalf("stdout %q", out.String())
	}
}

// P-4: 기동 헬퍼가 가드 뒤에 `-c log.showSignature=false` 를 앞에 붙인다. 서명된
// 커밋에서 사용자 설정 log.showSignature=true 가 log·부모 판정 출력을 오염시켰다.
func TestExecGit_PrependsShowSignatureOff(t *testing.T) {
	dir := t.TempDir()
	fake := filepath.Join(dir, "git")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	out, err := execGit(context.Background(), dir, []string{"log", "-n", "1"}, DefaultMaxOutput, "")
	if err != nil {
		t.Fatalf("execGit: %v", err)
	}
	got := strings.Split(strings.TrimSpace(out.Stdout), "\n")
	want := []string{"-c", "log.showSignature=false", "log", "-n", "1"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("argv %q, want %q", got, want)
	}
}
