//go:build !windows

package platform

import (
	"os"
	"sync"
	"testing"
)

func startTestPTY(t *testing.T) Terminal {
	t.Helper()
	term, err := posixPTY{}.Start(ProcSpec{Path: "/bin/sh", Args: []string{"sh", "-c", "sleep 30"}, Env: os.Environ(), Dir: t.TempDir()}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = term.Kill()
		_ = term.Wait()
	})
	return term
}

// 크기 조회는 닫히는 PTY 와 경쟁하지 않는다. 읽기 고루틴이 Close 로 끝나며 fd 를
// 거두는 동안 Size 가 fd 를 날것으로 읽으면(os.File.Fd) -race 가 잡는다 — 웹소켓
// 접속(handleWSDirect)이 도구 종료와 겹칠 때의 모양이다.
func TestPosixTerminalSizeRacesClose(t *testing.T) {
	term := startTestPTY(t)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		buf := make([]byte, 1024)
		for {
			if _, err := term.Read(buf); err != nil {
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 2000; i++ {
			if _, _, err := term.Size(); err != nil {
				return
			}
			_ = term.Resize(80, 24)
		}
	}()
	_ = term.Close()
	wg.Wait()
}

func TestPosixTerminalSizeFollowsResize(t *testing.T) {
	term := startTestPTY(t)
	if err := term.Resize(132, 43); err != nil {
		t.Fatal(err)
	}
	c, r, err := term.Size()
	if err != nil || c != 132 || r != 43 {
		t.Fatalf("Size = %dx%d, %v want 132x43", c, r, err)
	}
}

func TestPosixTerminalSizeAfterCloseErrors(t *testing.T) {
	term := startTestPTY(t)
	_ = term.Close()
	if _, _, err := term.Size(); err == nil {
		t.Fatal("닫힌 PTY 의 Size 가 성공했다")
	}
	if err := term.Resize(100, 40); err == nil {
		t.Fatal("닫힌 PTY 의 Resize 가 성공했다")
	}
}
