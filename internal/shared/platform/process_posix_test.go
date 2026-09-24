//go:build !windows

package platform

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// waitUntil 은 cond 가 참이 될 때까지 최대 d 를 기다린다. 프로세스 종료는
// 비동기라 sleep 한 번으로 단정하면 느린 호스트에서 깜빡인다.
func waitUntil(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}

func TestPosixAliveSelf(t *testing.T) {
	if !(posixProcess{}).Alive(os.Getpid()) {
		t.Fatal("자기 자신이 살아 있지 않다고 한다")
	}
}

func TestPosixAliveRejectsNonPositive(t *testing.T) {
	for _, pid := range []int{0, -1} {
		if (posixProcess{}).Alive(pid) {
			t.Fatalf("pid %d 가 살아 있다고 한다", pid)
		}
	}
}

func TestPosixTerminateAndAlive(t *testing.T) {
	p := posixProcess{}
	cmd := exec.Command("/bin/sh", "-c", "sleep 60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	if !p.Alive(pid) {
		t.Fatal("방금 띄운 프로세스가 죽어 있다")
	}
	if err := p.Terminate(pid); err != nil {
		t.Fatalf("Terminate: %v", err)
	}
	_ = cmd.Wait() // 수확하지 않으면 좀비가 남아 Alive 가 계속 참이다
	if p.Alive(pid) {
		t.Fatal("Terminate 후에도 살아 있다")
	}
}

func TestPosixKill(t *testing.T) {
	p := posixProcess{}
	// SIGTERM 을 무시하는 프로세스도 Kill 은 잡아야 한다.
	cmd := exec.Command("/bin/sh", "-c", "trap '' TERM; sleep 60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	if err := p.Kill(pid); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	_ = cmd.Wait()
	if p.Alive(pid) {
		t.Fatal("Kill 후에도 살아 있다")
	}
}

func TestPosixDetachSetsSetsid(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "true")
	(posixProcess{}).Detach(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setsid {
		t.Fatal("Setsid 가 서지 않았다")
	}
}

// Detach 는 호출자가 이미 채워 둔 SysProcAttr 를 지우면 안 된다. 단 Setpgid 는
// 예외다 — Setsid 와 함께 서면 fork/exec 가 EPERM 으로 실패한다(darwin 실측,
// REPO_FIX 01 P-2). 새 세션이 곧 새 그룹이므로 Setpgid 를 내려도 잃는 것이 없다.
func TestPosixDetachPreservesExistingAttr(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "true")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Noctty: true}
	(posixProcess{}).Detach(cmd)
	if !cmd.SysProcAttr.Noctty {
		t.Fatal("기존 Noctty 가 사라졌다")
	}
	if cmd.SysProcAttr.Setpgid {
		t.Fatal("Setpgid 가 Setsid 와 함께 남았다 — Start 가 EPERM 으로 실패한다")
	}
	if !cmd.SysProcAttr.Setsid {
		t.Fatal("Setsid 가 서지 않았다")
	}
}

// 호출자가 Setpgid 를 세워 둔 명령도 Detach 뒤에 실제로 시작된다.
func TestPosixDetachAfterSetpgidStarts(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "true")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	(posixProcess{}).Detach(cmd)
	if err := cmd.Run(); err != nil {
		t.Fatalf("Detach 한 명령이 시작되지 않는다: %v", err)
	}
}

// REPO_FIX 01 P-2: 그룹은 **새 세션**으로 선다(pgid = sid = pid). 제어 터미널에서
// 떨어져 ssh·gpg 프롬프트가 SIGTTIN 으로 멈추지 않는다. 플래그만 보지 않고 실제로
// 띄워 확인한다 — 플래그 조합의 EPERM 은 Start 에서만 드러난다.
func TestPosixNewGroupStartsNewSession(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "sleep 60")
	g := (posixProcess{}).NewGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = g.Kill(); _ = cmd.Wait() }()
	if err := g.Bind(); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	pid := cmd.Process.Pid
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		t.Fatal(err)
	}
	sid, err := unix.Getsid(pid)
	if err != nil {
		t.Fatal(err)
	}
	if pgid != pid || sid != pid {
		t.Fatalf("새 세션이 아니다: pid=%d pgid=%d sid=%d", pid, pgid, sid)
	}
}

// 그룹 종료는 **자손까지** 닿아야 한다. 이것이 되지 않으면 취소가 취소가 아니다
// (git/jobs/job.go 의 기존 규약).
func TestPosixGroupKillsDescendants(t *testing.T) {
	p := posixProcess{}
	pidFile := filepath.Join(t.TempDir(), "grandchild.pid")
	script := "sleep 60 & echo $! > " + pidFile + "; sleep 60"
	cmd := exec.Command("/bin/sh", "-c", script)

	g := p.NewGroup(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setsid {
		t.Fatal("Setsid 가 서지 않았다")
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if err := g.Bind(); err != nil {
		t.Fatalf("Bind: %v", err)
	}

	var grandchild int
	if !waitUntil(3*time.Second, func() bool {
		blob, err := os.ReadFile(pidFile)
		if err != nil {
			return false
		}
		grandchild, err = strconv.Atoi(strings.TrimSpace(string(blob)))
		return err == nil && grandchild > 0
	}) {
		t.Fatal("손자 pid 를 얻지 못했다")
	}
	if !p.Alive(grandchild) {
		t.Fatal("손자가 뜨지 않았다")
	}

	if err := g.Kill(); err != nil {
		t.Fatalf("Group.Kill: %v", err)
	}
	_ = cmd.Wait()

	// 손자는 고아가 되어 init 이 수확한다 — 즉시는 아닐 수 있다.
	if !waitUntil(3*time.Second, func() bool { return !p.Alive(grandchild) }) {
		t.Fatal("그룹을 죽였는데 손자가 살아 있다")
	}
}

// 시작되지 않은 그룹에 신호를 보내는 것은 오류가 아니다 — 호출자가 실패 경로에서
// 정리를 부를 수 있어야 한다.
func TestPosixGroupSignalBeforeStart(t *testing.T) {
	g := (posixProcess{}).NewGroup(exec.Command("/bin/sh", "-c", "true"))
	if err := g.Terminate(); err != nil {
		t.Fatalf("Terminate: %v", err)
	}
	if err := g.Kill(); err != nil {
		t.Fatalf("Kill: %v", err)
	}
}
