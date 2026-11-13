//go:build !windows

package runtimebin

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

const pathFoldCase = false

func commandCandidates(dir, cmd string) []string { return []string{filepath.Join(dir, cmd)} }

func isExecutable(st os.FileInfo) bool { return st.Mode().Perm()&0o111 != 0 }

func connRefused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }

// execShim 는 자기 자신을 진짜 명령으로 바꾼다. 신호와 종료 코드가 그대로 간다 (FR-CAC-83 ⑥).
func execShim(path string, argv, env []string) int {
	err := syscall.Exec(path, argv, env)
	fmt.Fprintf(os.Stderr, "%s 를 실행하지 못했습니다: %v\n", filepath.Base(path), err)
	return 126
}
