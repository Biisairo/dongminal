//go:build !windows

package platform

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

type posixPTY struct{}

func (posixPTY) Start(spec ProcSpec, cols, rows uint16) (Terminal, error) {
	cols, rows = clampSize(cols, rows)
	cmd := exec.Command(spec.Path, spec.Args[1:]...)
	cmd.Args = spec.Args
	// os/exec 도 Start() 에서 같은 정리를 한다. 여기서 한 번 더 하는 것은
	// 두 어댑터가 같은 규칙을 쓴다는 것을 눈에 보이게 하기 위해서다.
	cmd.Env = dedupEnv(spec.Env, envKeyAsIs)
	cmd.Dir = spec.Dir
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, fmt.Errorf("pty start %s (cwd=%s): %w", spec.Path, spec.Dir, err)
	}
	gate, err := newReadGate()
	if err != nil {
		_ = cmd.Process.Kill()
		_ = ptmx.Close()
		return nil, err
	}
	return &posixTerminal{ptmx: ptmx, fd: int(ptmx.Fd()), cmd: cmd, gate: gate}, nil
}

// AdoptTerminal 은 넘겨받은 마스터 fd 와 셸 pid 로 터미널을 다시 만든다
// (DAEMON_SESSION_KEEP_SRS FR-DSK-21). exec 는 pid 를 바꾸지 않으므로 셸은 여전히 이
// 프로세스의 자식이고, Wait 는 wait4 로 거둔다.
func AdoptTerminal(fd uintptr, pid int) (Terminal, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("셸 pid 가 아닙니다: %d", pid)
	}
	if _, err := unix.IoctlGetWinsize(int(fd), unix.TIOCGWINSZ); err != nil {
		return nil, fmt.Errorf("fd %d 는 의사 터미널이 아닙니다: %w", fd, err)
	}
	syscall.CloseOnExec(int(fd))
	gate, err := newReadGate()
	if err != nil {
		return nil, err
	}
	return &posixTerminal{ptmx: os.NewFile(fd, "ptmx"), fd: int(fd), pid: pid, gate: gate}, nil
}

// posixTerminal 은 ptmx 파일과 셸 프로세스를 한 덩어리로 든다. cmd 는 이 프로세스가 띄운
// 셸이고, 넘겨받은 셸이면 nil 이며 pid 만 있다.
type posixTerminal struct {
	ptmx *os.File
	fd   int
	cmd  *exec.Cmd
	pid  int
	gate *readGate
}

func (t *posixTerminal) Read(b []byte) (int, error)  { return t.gate.read(t.fd, b) }
func (t *posixTerminal) Write(b []byte) (int, error) { return t.ptmx.Write(b) }

func (t *posixTerminal) Close() error {
	t.gate.close()
	return t.ptmx.Close()
}

func (t *posixTerminal) Freeze()           { t.gate.freeze() }
func (t *posixTerminal) Thaw()             { t.gate.thaw() }
func (t *posixTerminal) MasterFD() uintptr { return uintptr(t.fd) }

func (t *posixTerminal) Resize(cols, rows uint16) error {
	return t.control(func(fd int) error {
		return unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Col: cols, Row: rows})
	})
}

func (t *posixTerminal) Size() (uint16, uint16, error) {
	var ws *unix.Winsize
	err := t.control(func(fd int) error {
		var err error
		ws, err = unix.IoctlGetWinsize(fd, unix.TIOCGWINSZ)
		return err
	})
	if err != nil {
		return 0, 0, err
	}
	return ws.Col, ws.Row, nil
}

// control 은 ptmx 의 fd 로 f 를 부른다. pty.Getsize·Setsize 는 os.File.Fd() 를
// 쓰는데, 그것은 fd 참조를 잡지 않아 readPTY 가 Close 로 끝나며 fd 를 거두는
// 것과 경쟁하고(-race), fd 를 블로킹 모드로 되돌린다. SyscallConn().Control 은
// 참조를 잡고 부르며, 닫혔으면 부르지 않고 오류를 준다.
func (t *posixTerminal) control(f func(fd int) error) error {
	rc, err := t.ptmx.SyscallConn()
	if err != nil {
		return err
	}
	var ferr error
	if err := rc.Control(func(fd uintptr) { ferr = f(int(fd)) }); err != nil {
		return err
	}
	return ferr
}

// ForegroundPGID 는 tcgetpgrp 로 전경 그룹을 읽고, 그것이 셸 자신의 그룹이면
// "없음" 으로 답한다.
func (t *posixTerminal) ForegroundPGID() (int, bool) {
	pgid, ok := t.tcgetpgrp()
	if !ok || pgid <= 0 {
		return 0, false
	}
	// 전경 pgid 가 셸 자신의 pgid 면 전경 프로그램이 없는 것이다. 셸의 pgid 를
	// 읽지 못하면 추측하지 않고 없음으로 답한다.
	shellPgid, err := syscall.Getpgid(t.PID())
	if err != nil || pgid == shellPgid {
		return 0, false
	}
	return pgid, true
}

// tcgetpgrp 는 PTY 마스터의 전경 프로세스 그룹을 읽는다.
//
// os.File.Fd() 는 fd 를 블로킹 모드로 되돌리므로 쓰지 않는다 — 같은 fd 를
// readPTY 가 읽고 있다. SyscallConn().Control 로 부른다.
func (t *posixTerminal) tcgetpgrp() (int, bool) {
	rc, err := t.ptmx.SyscallConn()
	if err != nil {
		return 0, false
	}
	var pgrp int32
	var errno syscall.Errno
	cerr := rc.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall(syscall.SYS_IOCTL, fd,
			uintptr(syscall.TIOCGPGRP), uintptr(unsafe.Pointer(&pgrp)))
	})
	if cerr != nil || errno != 0 {
		return 0, false
	}
	return int(pgrp), true
}

func (t *posixTerminal) PID() int {
	if t.cmd == nil || t.cmd.Process == nil {
		return t.pid
	}
	return t.cmd.Process.Pid
}

func (t *posixTerminal) Wait() error {
	if t.cmd != nil {
		return t.cmd.Wait()
	}
	if t.pid <= 0 {
		return nil
	}
	var ws syscall.WaitStatus
	for {
		_, err := syscall.Wait4(t.pid, &ws, 0, nil)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return err
		}
		if ws.ExitStatus() != 0 || ws.Signaled() {
			return &adoptedExitError{ws: ws}
		}
		return nil
	}
}

// adoptedExitError 는 넘겨받은 셸의 비정상 종료다. ExitCode 는 exec.ExitError 와 같은 뜻이다.
type adoptedExitError struct{ ws syscall.WaitStatus }

func (e *adoptedExitError) Error() string { return fmt.Sprintf("셸 종료: %v", e.ws) }
func (e *adoptedExitError) ExitCode() int { return e.ws.ExitStatus() }

func (t *posixTerminal) Terminate() error { return t.signal(syscall.SIGTERM) }

func (t *posixTerminal) Kill() error { return t.signal(syscall.SIGKILL) }

func (t *posixTerminal) signal(sig syscall.Signal) error {
	pid := t.PID()
	if pid <= 0 {
		return nil
	}
	if t.cmd != nil && t.cmd.Process != nil {
		return t.cmd.Process.Signal(sig)
	}
	return syscall.Kill(pid, sig)
}
