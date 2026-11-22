//go:build windows

package lsp

import "os/exec"

// ownGroup 은 Windows 에서 아무것도 하지 않는다 (FR-ATF-31 — Windows 는 지금처럼 Kill).
func ownGroup(*exec.Cmd) {}

// killGroup 은 Windows 에서 언어 서버 프로세스만 죽인다.
func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
