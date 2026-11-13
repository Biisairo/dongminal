//go:build !windows

package platform

import (
	"bytes"
	"strings"
)

// CommandLines 는 실행 중인 프로세스의 명령줄 목록이다 (CLAUDE_ACCOUNTS_SRS FR-CAC-75).
// 읽지 못하면 오류다 — 호출자는 "모름" 으로 다룬다 (NFR-XP-6).
func CommandLines() ([]string, error) { return commandLinesWith(execRun) }

func commandLinesWith(run runFn) ([]string, error) {
	out, err := run("ps", "-axo", "args=")
	if err != nil {
		return nil, err
	}
	return parseCommandLines(out), nil
}

func parseCommandLines(out []byte) []string {
	var lines []string
	for _, l := range bytes.Split(out, []byte("\n")) {
		if s := strings.TrimSpace(string(l)); s != "" {
			lines = append(lines, s)
		}
	}
	return lines
}
