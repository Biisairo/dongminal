package platform

import (
	"os/exec"
	"time"
)

const junctionTimeout = 5 * time.Second

// Junction 은 link 에 target 을 가리키는 디렉터리 정션을 만든다. 심볼릭 링크를 만들 권한이 없을 때의
// 대안이다 (CLAUDE_ACCOUNTS_SRS FR-CAC-82).
func Junction(target, link string) error {
	cmd := exec.Command("cmd", "/c", "mklink", "/J", link, target)
	return runWithTimeout(cmd, junctionTimeout)
}

func runWithTimeout(cmd *exec.Cmd, d time.Duration) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		_ = cmd.Process.Kill()
		return <-done
	}
}
