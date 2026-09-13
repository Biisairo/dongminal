package platform

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// M8_UNIFIED_SRS FR-AGT-2 (V-5): 파이프 전송은 Terminal 을 만족하되 터미널 고유
// 호출은 **오류가 아니라 무동작**이다.

func pipeEcho(t *testing.T) (Terminal, *[]string) {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil || runtime.GOOS == "windows" {
		t.Skip("sh 가 없다")
	}
	var lines []string
	var mu sync.Mutex
	term, err := StartPipe(ProcSpec{
		Path: sh,
		Args: []string{sh, "-c", `echo err1 1>&2; while IFS= read -r l; do echo "got:$l"; done`},
		Env:  os.Environ(), Dir: t.TempDir(),
	}, func(line string) { mu.Lock(); lines = append(lines, line); mu.Unlock() })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { term.Close(); term.Kill(); term.Wait() })
	// stderr 는 줄 단위로 콜백에 온다 (D-C-6).
	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		n := len(lines)
		mu.Unlock()
		if n > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	return term, &lines
}

func TestStartPipe_ReadWriteAndNoops(t *testing.T) {
	term, lines := pipeEcho(t)
	if len(*lines) != 1 || (*lines)[0] != "err1" {
		t.Fatalf("stderr 줄: %v", *lines)
	}
	if _, err := term.Write([]byte("PONG\n")); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(term)
	line, err := r.ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "got:PONG" {
		t.Fatalf("stdout: %q %v", line, err)
	}
	// 터미널 고유 호출 — 무동작.
	if err := term.Resize(200, 50); err != nil {
		t.Fatalf("Resize 는 무동작이어야 한다: %v", err)
	}
	if c, r, err := term.Size(); err != nil || c != 0 || r != 0 {
		t.Fatalf("Size 는 (0,0,nil) 이다: %d %d %v", c, r, err)
	}
	if _, ok := term.ForegroundPGID(); ok {
		t.Fatal("파이프에는 전경 프로세스 그룹이 없다")
	}
	if term.PID() <= 0 {
		t.Fatal("pid")
	}
}

// stdin 을 닫으면 프로세스가 끝나고 Read 는 EOF 다 — readPTY 의 정상 종료 경로.
func TestStartPipe_CloseEndsProcess(t *testing.T) {
	term, _ := pipeEcho(t)
	if err := term.Close(); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 16)
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, err := term.Read(buf)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("EOF 가 아닌 오류: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatal("EOF 가 오지 않았다")
		}
	}
	if err := term.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
}
