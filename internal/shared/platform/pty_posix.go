//go:build !windows

package platform

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"github.com/creack/pty"
)

type posixPTY struct{}

func (posixPTY) Start(spec ProcSpec, cols, rows uint16) (Terminal, error) {
	cmd := exec.Command(spec.Path, spec.Args[1:]...)
	cmd.Args = spec.Args
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, fmt.Errorf("pty start %s (cwd=%s): %w", spec.Path, spec.Dir, err)
	}
	return &posixTerminal{ptmx: ptmx, cmd: cmd}, nil
}

// posixTerminal 은 ptmx 파일과 exec.Cmd 를 한 덩어리로 든다.
type posixTerminal struct {
	ptmx *os.File
	cmd  *exec.Cmd
}

func (t *posixTerminal) Read(b []byte) (int, error)  { return t.ptmx.Read(b) }
func (t *posixTerminal) Write(b []byte) (int, error) { return t.ptmx.Write(b) }
func (t *posixTerminal) Close() error                { return t.ptmx.Close() }

func (t *posixTerminal) Resize(cols, rows uint16) error {
	return pty.Setsize(t.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

func (t *posixTerminal) Size() (uint16, uint16, error) {
	rows, cols, err := pty.Getsize(t.ptmx)
	if err != nil {
		return 0, 0, err
	}
	return uint16(cols), uint16(rows), nil
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
		return 0
	}
	return t.cmd.Process.Pid
}

func (t *posixTerminal) Wait() error {
	if t.cmd == nil {
		return nil
	}
	return t.cmd.Wait()
}

func (t *posixTerminal) Terminate() error { return t.signal(syscall.SIGTERM) }

func (t *posixTerminal) Kill() error { return t.signal(syscall.SIGKILL) }

func (t *posixTerminal) signal(sig syscall.Signal) error {
	if t.cmd == nil || t.cmd.Process == nil {
		return nil
	}
	return t.cmd.Process.Signal(sig)
}
