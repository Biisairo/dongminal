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
	go func() { d, _ := g.close(context.Background(), "a"); closed <- d }()
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
	done, _ = g.close(ctx, "c")
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
		l, err := g.enterWait(context.Background(), "b")
		if l != nil {
			l()
		}
		got <- err
	}()
	done := make(chan func())
	go func() { d, _ := g.close(context.Background(), "b"); done <- d }()
	// close 가 표시를 세우고 기다리는 상태에 들어간 것을 확인한 뒤 자리를 비운다.
	waitGate(t, &g, "b", func(st *peerGateState) bool { return st.closing && st.idle != nil })
	leave()
	// close 를 풀기 전에 기다리던 쪽의 결과를 받는다 — 풀고 나면 들어가는 것이 맞다.
	err := <-got
	(<-done)()
	if !errors.Is(err, errPeerToolClosing) {
		t.Fatalf("닫는 중이 된 뒤: %v", err)
	}
}

// 최종 보안 리뷰: 같은 도구에 close 가 이미 진행 중이면 뒤에 온 close 는 거절한다 — 종료
// 명령을 겹쳐 보내 데몬 줄을 키우지 못한다. 앞선 close 의 표시는 그대로다.
func TestPeerGateOverlappingClose(t *testing.T) {
	var g peerGate
	done1, err := g.close(context.Background(), "a")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.close(context.Background(), "a"); !errors.Is(err, errPeerToolClosing) {
		t.Fatalf("겹친 close: %v", err)
	}
	if _, err := g.enter("a"); !errors.Is(err, errPeerToolClosing) {
		t.Fatalf("거절된 close 가 표시를 건드렸다: %v", err)
	}
	if _, err := g.close(context.Background(), "b"); err != nil {
		t.Fatalf("다른 도구의 close 가 막혔다: %v", err)
	}
	done1()
	leave, err := g.enter("a")
	if err != nil {
		t.Fatalf("close 가 끝난 뒤: %v", err)
	}
	leave()
}

// 정확성 재리뷰(5차) #1: 지난 상태의 정리가 새 상태를 지우지 않는다.
func TestPeerGateStaleForgetKeepsNewState(t *testing.T) {
	var g peerGate
	done, _ := g.close(context.Background(), "a")
	g.mu.Lock()
	old := g.m["a"]
	g.mu.Unlock()
	done()
	leave, err := g.enter("a") // 새 상태
	if err != nil {
		t.Fatal(err)
	}
	g.mu.Lock()
	g.forgetIfIdle("a", old) // 지난 상태로 정리를 부른다
	g.mu.Unlock()
	if _, err := g.enter("a"); !errors.Is(err, errPeerToolBusy) {
		t.Fatalf("지난 상태의 정리가 새 상태를 지웠다: %v", err)
	}
	leave()
}

func waitGate(t *testing.T, g *peerGate, id string, ok func(*peerGateState) bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		g.mu.Lock()
		st := g.m[id]
		hit := st != nil && ok(st)
		g.mu.Unlock()
		if hit {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s 의 상태가 기대에 닿지 않았다", id)
		}
		time.Sleep(time.Millisecond)
	}
}
