package fanout

import (
	"context"
	"sync/atomic"
	"testing"
)

// 모든 i 를 한 번씩 부르고, 동시에 도는 수는 상한을 넘지 않는다.
func TestEach_AllOnceWithinLimit(t *testing.T) {
	const n, limit = 50, 3
	var cur, peak atomic.Int32
	seen := make([]int32, n)
	Each(context.Background(), limit, n, func(i int) {
		c := cur.Add(1)
		for {
			p := peak.Load()
			if c <= p || peak.CompareAndSwap(p, c) {
				break
			}
		}
		atomic.AddInt32(&seen[i], 1)
		cur.Add(-1)
	})
	for i, v := range seen {
		if v != 1 {
			t.Fatalf("seen[%d] = %d", i, v)
		}
	}
	if p := peak.Load(); p > limit {
		t.Fatalf("동시 %d > 상한 %d", p, limit)
	}
}

// ctx 가 끝나면 남은 것을 시작하지 않는다.
func TestEach_StopsLaunchingOnDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var calls atomic.Int32
	Each(ctx, 1, 10, func(i int) {
		calls.Add(1)
		if i == 2 {
			cancel()
		}
	})
	if n := calls.Load(); n != 3 {
		t.Fatalf("부른 수 %d, want 3", n)
	}
	cancel()
	Each(ctx, 4, 10, func(int) { t.Fatal("끝난 ctx 로 시작했다") })
}

// 상한 0 은 1 로 읽는다 — 영원히 막히지 않는다.
func TestEach_ZeroLimit(t *testing.T) {
	var calls atomic.Int32
	Each(context.Background(), 0, 3, func(int) { calls.Add(1) })
	if calls.Load() != 3 {
		t.Fatal("상한 0 에서 돌지 않았다")
	}
}
