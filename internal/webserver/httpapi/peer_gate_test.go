package httpapi

import (
	"context"
	"errors"
	"testing"
	"time"
)

// I-73: 한 도구에 동시 1건, 다른 도구는 따로다. close 는 진행 중인 전달을 기다리고, 그동안과
// 그 뒤의 전달은 거절한다. 끝나면 상태를 지운다.
func TestPeerGate(t *testing.T) {
	var g peerGate
	leaveA, err := g.enter("a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.enter("a"); !errors.Is(err, errPeerToolBusy) {
		t.Fatalf("같은 도구 두 번째: %v", err)
	}
	leaveB, err := g.enter("b")
	if err != nil {
		t.Fatalf("다른 도구가 막혔다: %v", err)
	}
	leaveB()
	closed := make(chan func())
	go func() { closed <- g.close(context.Background(), "a") }()
	select {
	case <-closed:
		t.Fatal("진행 중인 전달을 기다리지 않았다")
	case <-time.After(50 * time.Millisecond):
	}
	leaveA()
	done := <-closed
	if _, err := g.enter("a"); !errors.Is(err, errPeerToolClosing) {
		t.Fatalf("닫는 중 전달: %v", err)
	}
	done()
	g.mu.Lock()
	n := len(g.m)
	g.mu.Unlock()
	if n != 0 {
		t.Fatalf("상태가 남았다 %d", n)
	}
	// 시한이 지나면 기다림을 멈추되 표시는 선다.
	leave, _ := g.enter("c")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done = g.close(ctx, "c")
	if _, err := g.enter("c"); !errors.Is(err, errPeerToolClosing) {
		t.Fatalf("시한 뒤 전달: %v", err)
	}
	leave()
	done()
}

// 자동 보안 검토: spawn 첫 프롬프트는 자리가 차 있어도 버리지 않는다. 시한 안에서 자리가
// 빌 때까지 기다린다. 닫는 중이 되거나 시한이 지나면 그만둔다.
func TestPeerGateEnterWait(t *testing.T) {
	var g peerGate
	leave, _ := g.enter("a")
	got := make(chan error, 1)
	go func() {
		l, err := g.enterWait(context.Background(), "a")
		if l != nil {
			l()
		}
		got <- err
	}()
	select {
	case <-got:
		t.Fatal("자리가 찼는데 들어갔다")
	case <-time.After(50 * time.Millisecond):
	}
	leave()
	if err := <-got; err != nil {
		t.Fatalf("자리가 빈 뒤: %v", err)
	}
	leave, _ = g.enter("b")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := g.enterWait(ctx, "b"); err == nil {
		t.Fatal("시한이 지났는데 들어갔다")
	}
	go func() {
		_, err := g.enterWait(context.Background(), "b")
		got <- err
	}()
	time.Sleep(20 * time.Millisecond)
	done := make(chan func())
	go func() { done <- g.close(context.Background(), "b") }()
	time.Sleep(20 * time.Millisecond)
	leave()
	(<-done)()
	if err := <-got; !errors.Is(err, errPeerToolClosing) {
		t.Fatalf("닫는 중이 된 뒤: %v", err)
	}
}
