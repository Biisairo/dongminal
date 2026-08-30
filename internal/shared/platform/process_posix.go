//go:build !windows

package platform

import (
	"os"
	"os/exec"
	"syscall"
)

type posixProcess struct{}

// sysProcAttr 는 cmd 의 SysProcAttr 를 확보한다. 없으면 만들고, 있으면 그대로
// 쓴다 — 호출자가 이미 채워 둔 값을 지우지 않는다.
func sysProcAttr(cmd *exec.Cmd) *syscall.SysProcAttr {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	return cmd.SysProcAttr
}

// Alive 는 신호 0 으로 존재를 확인한다. EPERM 은 "있는데 내 것이 아니다" 이므로
// 살아 있는 것이다 (Process.Alive 주석).
func (posixProcess) Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func (posixProcess) Terminate(pid int) error {
	if pid <= 0 {
		return nil
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}

func (posixProcess) Kill(pid int) error {
	if pid <= 0 {
		return nil
	}
	return syscall.Kill(pid, syscall.SIGKILL)
}

// SIGHUP 은 제어 터미널이 사라진 것이고, SIGTERM 은 관리자의 종료 요청이다.
// 둘 다 정리하고 나갈 기회로 받는다.
func (posixProcess) ShutdownSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}
}

func (posixProcess) Detach(cmd *exec.Cmd) { sysProcAttr(cmd).Setsid = true }

func (posixProcess) NewGroup(cmd *exec.Cmd) Group {
	sysProcAttr(cmd).Setpgid = true
	return posixGroup{cmd: cmd}
}

// posixGroup 은 Setpgid 로 만든 프로세스 그룹이다. 리더의 pid 가 곧 pgid 다.
type posixGroup struct{ cmd *exec.Cmd }

// POSIX 는 SysProcAttr 로 이미 그룹이 서 있다. 할 일이 없다.
func (posixGroup) Bind() error { return nil }

// POSIX 프로세스 그룹은 커널 자원을 따로 잡지 않는다. 놓을 것이 없다.
func (posixGroup) Close() error { return nil }

func (g posixGroup) Terminate() error { return g.signal(syscall.SIGTERM) }

func (g posixGroup) Kill() error { return g.signal(syscall.SIGKILL) }

// signal 은 그룹 전체에 신호를 보낸다. 종전 git/jobs/job.go 의 signalGroup 과
// 동작이 같다 — 반환하는 오류도 그대로다.
func (g posixGroup) signal(sig syscall.Signal) error {
	if g.cmd == nil || g.cmd.Process == nil || g.cmd.Process.Pid <= 0 {
		return nil
	}
	return syscall.Kill(-g.cmd.Process.Pid, sig)
}
