package runtimebin

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const pathFoldCase = true

// wsaECONNREFUSED 는 Windows 소켓의 연결 거부 코드다.
const wsaECONNREFUSED = syscall.Errno(10061)

func commandCandidates(dir, cmd string) []string {
	exts := os.Getenv("PATHEXT")
	if exts == "" {
		exts = ".COM;.EXE;.BAT;.CMD"
	}
	var out []string
	for _, e := range strings.Split(exts, ";") {
		if e != "" {
			out = append(out, filepath.Join(dir, cmd+strings.ToLower(e)))
		}
	}
	return out
}

func isExecutable(os.FileInfo) bool { return true }

func connRefused(err error) bool {
	return errors.Is(err, wsaECONNREFUSED) || errors.Is(err, syscall.ECONNREFUSED)
}

// execShim 는 진짜 claude 를 자식으로 띄우고 종료 코드를 그대로 돌려준다 (FR-CAC-83 ⑥).
func execShim(path string, argv, env []string) int {
	cmd := exec.Command(path, argv[1:]...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s 를 실행하지 못했습니다: %v\n", filepath.Base(path), err)
		return 126
	}
	return 0
}
