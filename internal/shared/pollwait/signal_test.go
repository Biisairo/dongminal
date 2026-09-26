package pollwait

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-4 — 상태의 주인이 알리면 깨어나 묻는다. 알림이 없으면
// 묻지 않는다.

func TestSignal_NotifyWakesAllWaiters(t *testing.T) {
	var s Signal
	a, b := s.C(), s.C()
	s.Notify()
	for _, c := range []<-chan struct{}{a, b} {
		select {
		case <-c:
		default:
			t.Fatal("Notify 가 기다리던 쪽을 깨우지 않았다")
		}
	}
	select {
	case <-s.C():
		t.Fatal("Notify 뒤의 새 채널이 이미 닫혀 있다")
	default:
	}
}

func TestOn_AsksOnlyOnSignal(t *testing.T) {
	var s Signal
	var asks atomic.Int64
	var ready atomic.Bool
	done := make(chan error, 1)
	go func() {
		done <- On(context.Background(), 5*time.Second, s.C, func() bool {
			asks.Add(1)
			return ready.Load()
		})
	}()
	deadline := time.Now().Add(time.Second)
	for asks.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond) // 알림이 없는 동안 — 폴링이면 여기서 물음이 는다
	if got := asks.Load(); got != 1 {
		t.Fatalf("알림 없이 %d 번 물었다", got)
	}
	ready.Store(true)
	s.Notify()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("알림에 깨어나지 않았다")
	}
}

func TestOn_TimeoutAndCancel(t *testing.T) {
	var s Signal
	if err := On(context.Background(), 20*time.Millisecond, s.C, func() bool { return false }); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want timeout", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := On(ctx, time.Second, s.C, func() bool { return false }); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want canceled", err)
	}
}
