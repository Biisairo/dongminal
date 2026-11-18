//go:build darwin

package platform

import (
	"bytes"
	"unsafe"

	"golang.org/x/sys/unix"
)

const fdDir = "/dev/fd"

// ptsName 은 PTY 마스터 fd 의 짝 단말 경로다. 마스터가 아니면 거짓이다.
func ptsName(fd uintptr) (string, bool) {
	var buf [128]byte
	//nolint:staticcheck // x/sys 에 TIOCPTYGNAME 래퍼가 없다 — 이름을 얻는 길이 이 ioctl 하나다
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, fd, uintptr(unix.TIOCPTYGNAME), uintptr(unsafe.Pointer(&buf[0])))
	if errno != 0 {
		return "", false
	}
	return string(bytes.TrimRight(buf[:], "\x00")), true
}
