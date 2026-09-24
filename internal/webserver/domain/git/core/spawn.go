package core

import (
	"context"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"dongminal/internal/shared/platform"
)

// REPO_FIX 01 P-1·P-3 — git 을 띄우는 자리는 여기 하나다.
//
// 종전에는 두 갈래였다: 잡(`jobs/exec.go`)은 그룹·그룹 SIGTERM·WaitDelay 를 썼고
// 동기 실행(execGit)은 `exec.CommandContext` 기본(리더만 SIGKILL)이었다. 그래서
// 훅이 띄운 자식이 남고, 파이프를 쥔 자식 때문에 Wait 가 돌아오지 않고, git 이
// 정리할 기회 없이 죽어 index.lock 이 남았다.
const (
	// KillGrace 는 SIGTERM 뒤 SIGKILL 까지, 그리고 SIGKILL 뒤 파이프 회수까지의
	// 유예다. 반환 상한은 마감 + 2×KillGrace 다.
	KillGrace = 3 * time.Second
	// JobCeiling 은 잡 하나의 상한이다 (O9). 실질 종료 수단은 사용자 취소다.
	JobCeiling = 10 * time.Minute
)

// killGrace 는 테스트가 줄이는 값이다. 운영 값은 KillGrace 다.
var killGrace = KillGrace

// Spawn 은 cmd 를 새 그룹(POSIX 새 세션 / Windows Job Object)으로 띄우고
// stdout·stderr 를 각 소비자에게 흘린 뒤 신호 시퀀스대로 끝낸다.
//
// A. ctx 가 끝나면: 그룹 SIGTERM → 리더 종료 대기 ≤G(WaitDelay) → 리더가 끝나는
// 즉시 그룹 SIGKILL → 파이프 EOF 대기 ≤G → 넘으면 읽기단을 닫는다.
// B. 리더가 먼저 끝나면: 파이프 EOF 대기 ≤G → 안 오면 그룹 SIGKILL → ≤G → 읽기단을
// 닫는다. 출력을 리다이렉트하지 않은 훅의 백그라운드 자식은 여기서 끝난다.
//
// cmd 는 **exec.CommandContext(ctx, …)** 로 만들어야 한다 — Cancel·WaitDelay 는
// 그렇게 만든 cmd 에서만 동작한다.
//
// 반환값은 Wait 의 오류다. exit 코드는 cmd.ProcessState 에서 읽는다. 소비자는
// 읽기단이 닫힌 뒤에도 돌 수 있으므로(그룹 밖 손자가 쥔 경우) 자기 버퍼를
// 스스로 보호해야 한다.
func Spawn(ctx context.Context, cmd *exec.Cmd, stdout, stderr func(io.Reader)) error {
	spawned.enter()
	defer spawned.leave()
	outR, outW, err := os.Pipe()
	if err != nil {
		return err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return err
	}
	closeAll := func() {
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
	}
	cmd.Stdout = outW
	cmd.Stderr = errW
	group := platform.Current().Process.NewGroup(cmd)
	defer group.Close()
	cmd.Cancel = group.Terminate
	cmd.WaitDelay = killGrace

	if serr := cmd.Start(); serr != nil {
		closeAll()
		return serr
	}
	// Windows 는 여기서 Job 에 배정하고 중단된 자식을 재개한다 (FR-XPR-5).
	if berr := group.Bind(); berr != nil {
		_ = group.Kill()
		closeAll()
		_ = cmd.Wait()
		return berr
	}
	// 부모 쪽 쓰기단을 닫아야 자식이 끝났을 때 읽기가 EOF 를 본다.
	outW.Close()
	errW.Close()

	done := make(chan struct{}, 2)
	go func() { stdout(outR); done <- struct{}{} }()
	go func() { stderr(errR); done <- struct{}{} }()
	read := make(chan struct{})
	go func() { <-done; <-done; close(read) }()

	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		// A: 리더는 끝났다 — 남은 훅 자식을 지금 쓸어낸다.
		_ = group.Kill()
		if !waitFor(read, killGrace) {
			outR.Close()
			errR.Close()
		}
		return waitErr
	}
	// B
	if !waitFor(read, killGrace) {
		_ = group.Kill()
		if !waitFor(read, killGrace) {
			outR.Close()
			errR.Close()
		}
	}
	return waitErr
}

func waitFor(done <-chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-done:
		return true
	case <-t.C:
		return false
	}
}

// spawned 는 떠 있는 Spawn 의 수다 (REPO_FIX 01 §8). git 을 띄우는 자리가 여기
// 하나이므로 종료가 "모든 git 이 끝났는가" 를 이것으로 묻는다.
var spawned activity

type activity struct {
	mu   sync.Mutex
	n    int
	idle chan struct{} // n 이 0 이 될 때 닫힌다. 기다리는 쪽이 있을 때만 있다
}

func (a *activity) enter() {
	a.mu.Lock()
	a.n++
	a.mu.Unlock()
}

func (a *activity) leave() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.n--
	if a.n == 0 && a.idle != nil {
		close(a.idle)
		a.idle = nil
	}
}

func (a *activity) wait(d time.Duration) bool {
	a.mu.Lock()
	if a.n == 0 {
		a.mu.Unlock()
		return true
	}
	if a.idle == nil {
		a.idle = make(chan struct{})
	}
	idle := a.idle
	a.mu.Unlock()
	return waitFor(idle, d)
}

// Drain 은 떠 있는 git 이 모두 끝날 때까지 d 만큼 기다린다. 끝났으면 참이다.
// 서버 종료가 루트 ctx 를 취소한 뒤 부른다 — 취소된 git 은 마감+2G 안에 끝난다.
func Drain(d time.Duration) bool { return spawned.wait(d) }
