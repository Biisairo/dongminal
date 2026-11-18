//go:build linux

package platform

import (
	"strconv"

	"golang.org/x/sys/unix"
)

const fdDir = "/proc/self/fd"

// ptsName 은 PTY 마스터 fd 의 짝 단말 경로다. 마스터가 아니면 거짓이다.
func ptsName(fd uintptr) (string, bool) {
	n, err := unix.IoctlGetInt(int(fd), unix.TIOCGPTN)
	if err != nil {
		return "", false
	}
	return "/dev/pts/" + strconv.Itoa(n), true
}
