package pollwait

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// M8 `GO-12`: 요청 경로의 대기는 ctx 로 끊긴다.

func TestUntil_ReturnsImmediatelyWhenConditionHolds(t *testing.T) {
	start := time.Now()
	if err := Until(context.Background(), time.Second, 100*time.Millisecond, func() bool { return true }); err != nil {
		t.Fatalf("err=%v", err)
	}
	if time.Since(start) > 50*time.Millisecond {
		t.Fatal("참인 조건에 기다렸다")
	}
}

func TestUntil_TimesOutWithoutSleepingPastMax(t *testing.T) {
	start := time.Now()
	err := Until(context.Background(), 30*time.Millisecond, time.Second, func() bool { return false })
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("err=%v want timeout", err)
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("상한보다 폴링 간격만큼 더 잤다")
	}
}

func TestUntil_StopsWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	// **첫 물음이 지났는가** 를 본다 (M9_SRS FR-M9-14 ①). 취소는 대기 중에
	// 들어와야 뜻이 있고, 고정 대기는 그 사실을 말해 주지 않는다.
	polled := make(chan struct{})
	var once sync.Once
	done := make(chan error, 1)
	go func() {
		done <- Until(ctx, time.Minute, time.Minute, func() bool {
			once.Do(func() { close(polled) })
			return false
		})
	}()
	<-polled
	start := time.Now()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err=%v want canceled", err)
		}
		if time.Since(start) > 500*time.Millisecond {
			t.Fatal("취소 뒤에도 폴링 간격만큼 기다렸다")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("취소가 대기를 끊지 않았다")
	}
}
