package ipc

import (
	"testing"
	"time"

	"dongminal/internal/shared/toolipc"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-1: 데몬 모드에서는 list 폴이 없으므로 fg push 가
// 이름을 전하는 유일한 길이다. 큐가 차 있어도 버리지 않고 자리가 날 때까지 기다린다.
func TestPushForegroundNotDropped(t *testing.T) {
	pc := &panedConn{out: make(chan interface{}, 1), done: make(chan struct{})}
	pc.out <- "busy"
	returned := make(chan struct{})
	go func() { pc.pushForeground("t1", "vim"); close(returned) }()
	// 큐가 찬 동안 돌아오면 버린 것이다. 기다리는 쪽은 자리가 날 때까지 돌아오지 않는다.
	select {
	case <-returned:
		t.Fatal("큐가 찬 채로 돌아왔다 — fg push 를 버렸다")
	case <-time.After(100 * time.Millisecond):
	}
	<-pc.out
	select {
	case v := <-pc.out:
		ev, ok := v.(toolipc.ForegroundEvent)
		if !ok || ev.Tool != "t1" || ev.Name != "vim" {
			t.Fatalf("push=%#v", v)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("큐가 찬 동안의 fg push 가 버려졌다")
	}
}
