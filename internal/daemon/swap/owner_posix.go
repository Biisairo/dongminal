//go:build !windows

package swap

import (
	"os"
	"syscall"
)

// fileOwner 는 파일 소유자의 uid 다.
func fileOwner(fi os.FileInfo) (int, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(st.Uid), true
}
