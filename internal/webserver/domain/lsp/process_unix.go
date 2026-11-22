//go:build !windows

package lsp

import (
	"os/exec"
	"syscall"
)

// ownGroup 은 언어 서버를 자기 프로세스 그룹의 우두머리로 세운다 (FR-ATF-31).
func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killGroup 은 언어 서버의 프로세스 그룹 전체를 죽인다 — 서버가 띄운 자식이 고아로
// 남지 않는다.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
