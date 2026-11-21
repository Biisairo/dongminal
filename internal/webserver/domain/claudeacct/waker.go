package claudeacct

import (
	"context"
	"sync"
	"time"
)

// waker 는 Engine·Auto 의 Run 이 함께 쓰는 깨우기 신호와 회차 루프다
// (REFACTOR3_DEDUP_GO_SRS FR-RDG-62). 둘이 다른 것은 Tick 과 기다림의 하한뿐이다.
type waker struct {
	mu sync.Mutex
	ch chan struct{}
}

// wake 는 기다리던 loop 를 바로 깨운다. loop 가 아직 서지 않았으면 아무 일도 없다.
func (w *waker) wake() {
	w.mu.Lock()
	ch := w.ch
	w.mu.Unlock()
	if ch == nil {
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
}

// loop 는 stop 이 닫힐 때까지 tick 을 부르고, 그것이 준 시간(floor 보다 짧으면 floor)
// 만큼 기다린다. 기다리는 중 wake 가 오면 곧바로 다음 회차다. tick 의 ctx 는 stop 이
// 닫히면 끊긴다.
func (w *waker) loop(stop <-chan struct{}, floor time.Duration, tick func(context.Context) time.Duration) {
	w.mu.Lock()
	w.ch = make(chan struct{}, 1)
	ch := w.ch
	w.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-stop
		cancel()
	}()
	for {
		d := tick(ctx)
		if d < floor {
			d = floor
		}
		t := time.NewTimer(d)
		select {
		case <-stop:
			t.Stop()
			return
		case <-ch:
			t.Stop()
		case <-t.C:
		}
	}
}
