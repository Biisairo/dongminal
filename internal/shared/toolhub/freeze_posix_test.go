//go:build !windows

package toolhub

import (
	"errors"
	"testing"
	"time"
)

// DAEMON_SESSION_KEEP_SRS FR-DSK-13 2·NFR-DSK-2: 멈춘 도구는 출력을 스트림에 넣지 않는다.
// 풀면 그동안의 출력이 모두 들어온다.
func TestTool_FreezeStopsFeedingStream(t *testing.T) {
	m := newTestManager(t)
	p, err := m.Create(t.TempDir(), 80, 24, Placement{Command: "cat"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Delete(p.ID) })

	waitOffset := func(what string, cond func(int64) bool) int64 {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			off := p.Stream().Offset()
			if cond(off) {
				return off
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s: offset=%d", what, off)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	if err := p.Write([]byte("one\n")); err != nil {
		t.Fatal(err)
	}
	waitOffset("첫 출력", func(o int64) bool { return o > 0 })
	time.Sleep(100 * time.Millisecond)
	before := p.Stream().Offset()

	if !m.FreezeAll() {
		t.Fatal("POSIX 도구를 멈추지 못했다")
	}
	if err := p.Write([]byte("two\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if got := p.Stream().Offset(); got != before {
		t.Fatalf("멈춘 동안 스트림이 자랐다: %d → %d", before, got)
	}

	m.ThawAll()
	waitOffset("푼 뒤 출력", func(o int64) bool { return o > before })
}

// 이미 끝난 도구가 있어도 FreezeAll 은 멎지 않는다.
func TestTool_FreezeSkipsExitedTool(t *testing.T) {
	m := newTestManager(t)
	p, err := m.Create(t.TempDir(), 80, 24, Placement{Command: "exit 0"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		t.Fatal("도구가 끝나지 않았다")
	}
	done := make(chan bool, 1)
	go func() { done <- m.FreezeAll() }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("끝난 도구에서 FreezeAll 이 멎었다")
	}
	m.ThawAll()
}

// FR-DSK-13 1: 멈춘 동안 새 도구를 만들지 않는다. 담은 뒤에 생긴 도구는 exec 에서 fd 가
// 닫혀 셸이 끝나기 때문이다. 풀면 다시 만들 수 있다.
func TestFreezeAll_SealsCreation(t *testing.T) {
	m := newTestManager(t)
	if !m.FreezeAll() {
		t.Fatal("빈 관리자를 멈추지 못했다")
	}
	if _, err := m.Create(t.TempDir(), 80, 24, Placement{Command: "cat"}); !errors.Is(err, ErrSealed) {
		t.Fatalf("멈춘 동안 Create err = %v, want ErrSealed", err)
	}
	if err := m.Restore("r1", "r1", t.TempDir(), 80, 24); !errors.Is(err, ErrSealed) {
		t.Fatalf("멈춘 동안 Restore err = %v, want ErrSealed", err)
	}
	m.ThawAll()
	p, err := m.Create(t.TempDir(), 80, 24, Placement{Command: "cat"})
	if err != nil {
		t.Fatalf("푼 뒤 Create: %v", err)
	}
	m.Delete(p.ID)
}
