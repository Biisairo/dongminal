package claudeacct

import (
	"context"
	"testing"
	"time"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-62: Engine·Auto 의 Run 은 waker.loop 하나에 Tick 을 준다.

// runLoop 는 loop 를 띄우고 tick 이 불릴 때마다 ticks 로 알린다.
func runLoop(t *testing.T, w *waker, floor, next time.Duration) (ticks chan struct{}, stop chan struct{}, done chan struct{}) {
	t.Helper()
	ticks = make(chan struct{}, 16)
	stop = make(chan struct{})
	done = make(chan struct{})
	go func() {
		defer close(done)
		w.loop(stop, floor, func(context.Context) time.Duration {
			select {
			case ticks <- struct{}{}:
			default:
			}
			return next
		})
	}()
	return ticks, stop, done
}

func waitTick(t *testing.T, ticks chan struct{}, what string) {
	t.Helper()
	select {
	case <-ticks:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s: tick 이 오지 않았다", what)
	}
}

func noTick(t *testing.T, ticks chan struct{}, what string) {
	t.Helper()
	select {
	case <-ticks:
		t.Fatalf("%s: tick 이 왔다", what)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestWaker_WakeRetriggersAndStopReturns(t *testing.T) {
	var w waker
	w.wake() // loop 전에는 아무 일도 없다(막히지 않는다)
	ticks, stop, done := runLoop(t, &w, 0, time.Hour)
	waitTick(t, ticks, "첫 회차")
	noTick(t, ticks, "기다리는 중")
	w.wake()
	waitTick(t, ticks, "깨운 뒤")
	close(stop)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stop 뒤 loop 가 돌아오지 않았다")
	}
}

func TestWaker_Floor(t *testing.T) {
	// 하한이 있으면 지난 시각을 받아도 곧바로 다시 돌지 않는다(Engine).
	var w waker
	ticks, stop, done := runLoop(t, &w, time.Hour, -time.Hour)
	waitTick(t, ticks, "하한: 첫 회차")
	noTick(t, ticks, "하한")
	close(stop)
	<-done

	// 하한이 0 이면 받은 시간 그대로다(Auto).
	var w2 waker
	ticks2, stop2, done2 := runLoop(t, &w2, 0, 0)
	waitTick(t, ticks2, "하한 없음: 첫 회차")
	waitTick(t, ticks2, "하한 없음: 다음 회차")
	close(stop2)
	<-done2
}
