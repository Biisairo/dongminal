//go:build !windows

package platform

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// DAEMON_SESSION_KEEP_SRS — 교체를 위한 터미널 능력 (FR-DSK-13·21, NFR-DSK-2).

type collector struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *collector) add(p []byte) { c.mu.Lock(); c.buf.Write(p); c.mu.Unlock() }
func (c *collector) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// pump 는 터미널을 끝까지 읽어 c 에 모은다.
func pump(term Terminal, c *collector) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		b := make([]byte, 4096)
		for {
			n, err := term.Read(b)
			if n > 0 {
				c.add(b[:n])
			}
			if errors.Is(err, ErrFrozen) {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			if err != nil {
				return
			}
		}
	}()
	return done
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s 을(를) 기다리다 시한을 넘겼다", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func startCat(t *testing.T) Terminal {
	t.Helper()
	term, err := posixPTY{}.Start(ProcSpec{Path: "/bin/cat", Args: []string{"cat"}, Env: os.Environ()}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	return term
}

// NFR-DSK-2: 멈춘 동안 읽기는 바이트를 가져가지 않는다. 풀면 그동안의 출력이 모두 온다.
func TestTerminal_FreezeHoldsOutputInKernel(t *testing.T) {
	term := startCat(t)
	defer func() { _ = term.Kill(); _ = term.Close() }()
	h, ok := term.(Handover)
	if !ok {
		t.Fatal("POSIX 터미널이 Handover 를 갖지 않는다")
	}
	var c collector
	done := pump(term, &c)

	if _, err := term.Write([]byte("before\n")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "before", func() bool { return strings.Count(c.String(), "before") >= 2 })

	h.Freeze()
	seen := c.String()
	if _, err := term.Write([]byte("during\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if got := c.String(); got != seen {
		t.Fatalf("멈춘 동안 읽었다: %q", strings.TrimPrefix(got, seen))
	}

	h.Thaw()
	waitFor(t, "during", func() bool { return strings.Count(c.String(), "during") >= 2 })
	_ = term.Kill()
	_ = term.Close()
	<-done
}

// FR-DSK-21: 넘겨받은 마스터 fd 와 pid 로 같은 셸을 다시 쥔다.
func TestAdoptTerminal_SameShell(t *testing.T) {
	orig := startCat(t)
	h := orig.(Handover)
	pid := orig.PID()
	// exec 를 흉내 낸다 — 같은 프로세스의 다른 fd 번호로 넘긴다.
	fd, err := syscall.Dup(int(h.MasterFD()))
	if err != nil {
		t.Fatal(err)
	}

	adopted, err := AdoptTerminal(uintptr(fd), pid)
	if err != nil {
		t.Fatal(err)
	}
	if adopted.PID() != pid {
		t.Fatalf("PID = %d, want %d", adopted.PID(), pid)
	}
	if err := adopted.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	if cols, rows, err := adopted.Size(); err != nil || cols != 100 || rows != 30 {
		t.Fatalf("Size = %d×%d %v", cols, rows, err)
	}
	var c collector
	done := pump(adopted, &c)
	if _, err := adopted.Write([]byte("adopted\n")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "adopted", func() bool { return strings.Contains(c.String(), "adopted") })

	// 옛 핸들은 버린다. 셸은 새 핸들에 붙어 있으므로 살아 있다.
	_ = orig.Close()
	if err := adopted.Kill(); err != nil {
		t.Fatal(err)
	}
	waitErr := make(chan error, 1)
	go func() { waitErr <- adopted.Wait() }()
	select {
	case <-waitErr:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait 가 셸을 거두지 못했다")
	}
	_ = adopted.Close()
	<-done
}

// FR-DSK-26: 잘못된 fd 는 거절한다.
func TestAdoptTerminal_RejectsBadFD(t *testing.T) {
	if _, err := AdoptTerminal(uintptr(9999), os.Getpid()); err == nil {
		t.Fatal("닫힌 fd 를 받아들였다")
	}
}
