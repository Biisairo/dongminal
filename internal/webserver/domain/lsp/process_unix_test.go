//go:build !windows

package lsp

import (
	"bufio"
	"context"
	"errors"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TC-ATF-31 (FR-ATF-31 / AT-LSP-3): 언어 서버를 멈추면 그 서버가 띄운 자식까지 끝난다.
// `Process.Kill` 만으로는 자식이 고아로 남는다.
func TestStartProcess_StopKillsProcessGroup(t *testing.T) {
	rwc, stop, err := StartProcess(context.Background(), "sh", []string{"-c", "sleep 30 & echo $!; wait"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(rwc).ReadString('\n')
	if err != nil {
		stop()
		t.Fatal(err)
	}
	child, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		stop()
		t.Fatalf("자식 pid = %q: %v", line, err)
	}
	// 실패해도 고아를 남기지 않는다.
	t.Cleanup(func() { _ = syscall.Kill(child, syscall.SIGKILL) })

	stop()

	deadline := time.Now().Add(childGoneWithin)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(child, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(childPollEvery)
	}
	t.Fatalf("정지 뒤에도 자식 %d 가 살아 있다", child)
}

const (
	childGoneWithin = 3 * time.Second
	childPollEvery  = 20 * time.Millisecond
)
