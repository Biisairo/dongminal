//go:build !windows

package platform

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// 데몬 교체의 되찾기가 묻는 OS 사실 (DAEMON_SESSION_KEEP_SRS FR-DSK-26·27).

// ChildTTY 는 직계 자식 하나와 그 제어 단말이다. TTY 는 /dev 를 뗀 이름이다.
type ChildTTY struct {
	PID int
	TTY string
}

// PTYMasters 는 이 프로세스가 쥔 PTY 마스터 fd 를 짝 단말 이름(/dev 를 뗀 것)으로 묶는다.
// skip 의 fd 는 뺀다.
func PTYMasters(skip map[uintptr]bool) (map[string]uintptr, error) {
	fds, err := openFDs()
	if err != nil {
		return nil, err
	}
	out := map[string]uintptr{}
	for _, fd := range fds {
		if fd <= 2 || skip[fd] {
			continue
		}
		if name, ok := ptsName(fd); ok {
			out[strings.TrimPrefix(name, "/dev/")] = fd
		}
	}
	return out, nil
}

// ChildTTYs 는 ppid 의 직계 자식과 그 제어 단말이다. 단말이 없는 자식은 뺀다. pid 순이다.
func ChildTTYs(ppid int) ([]ChildTTY, error) {
	out, err := exec.Command("ps", "-ax", "-o", "pid=,ppid=,tty=").Output()
	if err != nil {
		return nil, err
	}
	var kids []ChildTTY
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		parent, err2 := strconv.Atoi(f[1])
		if err1 != nil || err2 != nil || parent != ppid || f[2] == "??" || f[2] == "?" {
			continue
		}
		kids = append(kids, ChildTTY{PID: pid, TTY: normalizeTTY(f[2])})
	}
	sort.Slice(kids, func(i, j int) bool { return kids[i].PID < kids[j].PID })
	return kids, nil
}

// normalizeTTY 는 ps 의 단말 표기를 ptsname 의 꼴(/dev 를 뗀 것)에 맞춘다.
// macOS 의 ps 는 `s012` 처럼 `tty` 를 떼고 적기도 한다.
func normalizeTTY(s string) string {
	s = strings.TrimPrefix(s, "/dev/")
	if strings.HasPrefix(s, "s") && !strings.HasPrefix(s, "tty") {
		if _, err := strconv.Atoi(s[1:]); err == nil {
			return "tty" + s
		}
	}
	return s
}

// CommandName 은 pid 의 실행 파일 이름이다. 모르면 "shell" 이다.
func CommandName(pid int) string {
	out, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil || len(bytes.TrimSpace(out)) == 0 {
		return "shell"
	}
	return filepath.Base(strings.TrimSpace(string(out)))
}

// CloseSocketsBoundTo 는 paths 에 묶인 유닉스 소켓 fd 를 모두 닫고 그 수를 돌려준다.
func CloseSocketsBoundTo(paths ...string) int {
	want := map[string]bool{}
	for _, p := range paths {
		want[p] = true
	}
	fds, err := openFDs()
	if err != nil {
		return 0
	}
	closed := 0
	for _, fd := range fds {
		if fd <= 2 {
			continue
		}
		sa, err := unix.Getsockname(int(fd))
		if err != nil {
			continue
		}
		if u, ok := sa.(*unix.SockaddrUnix); ok && want[u.Name] {
			if unix.Close(int(fd)) == nil {
				closed++
			}
		}
	}
	return closed
}

// SetCloseOnExec 는 fd 의 close-on-exec 표시를 세우거나 지운다.
func SetCloseOnExec(fd uintptr, on bool) error {
	flags, err := unix.FcntlInt(fd, unix.F_GETFD, 0)
	if err != nil {
		return err
	}
	if on {
		flags |= unix.FD_CLOEXEC
	} else {
		flags &^= unix.FD_CLOEXEC
	}
	_, err = unix.FcntlInt(fd, unix.F_SETFD, flags)
	return err
}

// openFDs 는 이 프로세스의 열린 fd 다.
func openFDs() ([]uintptr, error) {
	ents, err := os.ReadDir(fdDir)
	if err != nil {
		return nil, err
	}
	fds := make([]uintptr, 0, len(ents))
	for _, e := range ents {
		if n, err := strconv.Atoi(e.Name()); err == nil {
			fds = append(fds, uintptr(n))
		}
	}
	return fds, nil
}
