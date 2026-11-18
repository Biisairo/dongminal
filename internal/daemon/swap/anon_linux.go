//go:build linux

package swap

import (
	"os"

	"golang.org/x/sys/unix"
)

// anonFile 은 메모리 파일이다. 디스크에 닿지 않는다.
func anonFile(string) (*os.File, error) {
	fd, err := unix.MemfdCreate("dongminal-handover", unix.MFD_CLOEXEC)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), "handover"), nil
}
