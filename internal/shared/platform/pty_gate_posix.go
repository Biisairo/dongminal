//go:build !windows

package platform

import (
	"fmt"
	"io"
	"os"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// readGate 는 마스터 fd 의 읽기를 멈출 수 있게 한다 (DAEMON_SESSION_KEEP_SRS NFR-DSK-2).
//
// 마스터 fd 는 Go 의 폴러에 오르지 않는다 — macOS 의 ptmx 는 읽기 시한을 받지 않는다. 막힌
// read 는 다음 출력을 곧바로 가져가므로, 읽기 전에 깨우기 파이프와 함께 기다리고 깨우기가
// 오면 읽지 않고 물러선다.
type readGate struct {
	mu      sync.Mutex
	cond    *sync.Cond
	frozen  bool
	closed  bool
	reading bool
	wakeR   int
	wakeW   int
}

func newReadGate() (*readGate, error) {
	var p [2]int
	if err := syscall.Pipe(p[:]); err != nil {
		return nil, fmt.Errorf("깨우기 파이프: %w", err)
	}
	for _, fd := range p {
		syscall.CloseOnExec(fd)
		if err := syscall.SetNonblock(fd, true); err != nil {
			syscall.Close(p[0])
			syscall.Close(p[1])
			return nil, fmt.Errorf("깨우기 파이프: %w", err)
		}
	}
	g := &readGate{wakeR: p[0], wakeW: p[1]}
	g.cond = sync.NewCond(&g.mu)
	return g, nil
}

// read 는 fd 에서 한 번 읽는다. 멈춰 있거나 기다리는 사이 멈추면 읽지 않고 ErrFrozen 이다.
func (g *readGate) read(fd int, b []byte) (int, error) {
	g.mu.Lock()
	switch {
	case g.closed:
		g.mu.Unlock()
		return 0, os.ErrClosed
	case g.frozen:
		g.mu.Unlock()
		return 0, ErrFrozen
	}
	g.reading = true
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		g.reading = false
		g.cond.Broadcast()
		g.mu.Unlock()
	}()
	for {
		fds := []unix.PollFd{{Fd: int32(g.wakeR), Events: unix.POLLIN}, {Fd: int32(fd), Events: unix.POLLIN}}
		if _, err := unix.Poll(fds, -1); err != nil {
			if err == unix.EINTR {
				continue
			}
			return 0, err
		}
		// 깨우기가 먼저다 — 출력과 깨우기가 함께 와도 읽지 않는다.
		if fds[0].Revents != 0 {
			g.drain()
			if g.isClosed() {
				return 0, os.ErrClosed
			}
			return 0, ErrFrozen
		}
		if fds[1].Revents&unix.POLLNVAL != 0 {
			return 0, syscall.EBADF
		}
		n, err := syscall.Read(fd, b)
		if err == syscall.EINTR || err == syscall.EAGAIN {
			continue
		}
		if n < 0 {
			n = 0
		}
		// 셸이 끝나 슬레이브가 닫히면 macOS 는 오류 없이 0 바이트를 준다. 끝으로 읽는다.
		if n == 0 && err == nil {
			return 0, io.EOF
		}
		return n, err
	}
}

func (g *readGate) isClosed() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.closed
}

func (g *readGate) drain() {
	var b [64]byte
	for {
		if n, _ := syscall.Read(g.wakeR, b[:]); n <= 0 {
			return
		}
	}
}

// freeze 는 멈춤을 세우고, 기다리던 읽기를 깨워 물러설 때까지 기다린다.
func (g *readGate) freeze() {
	g.mu.Lock()
	g.frozen = true
	g.mu.Unlock()
	_, _ = syscall.Write(g.wakeW, []byte{1})
	g.mu.Lock()
	for g.reading {
		g.cond.Wait()
	}
	g.mu.Unlock()
}

func (g *readGate) thaw() {
	g.mu.Lock()
	g.frozen = false
	g.mu.Unlock()
	g.drain()
}

// close 는 읽기를 깨우고 파이프를 닫는다. 그 뒤의 Read 는 os.ErrClosed 다.
func (g *readGate) close() {
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return
	}
	g.closed = true
	g.mu.Unlock()
	_, _ = syscall.Write(g.wakeW, []byte{1})
	g.mu.Lock()
	for g.reading {
		g.cond.Wait()
	}
	g.mu.Unlock()
	syscall.Close(g.wakeR)
	syscall.Close(g.wakeW)
}
