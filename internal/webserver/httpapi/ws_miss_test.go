package httpapi

import (
	"context"
	"testing"
	"time"
)

// RECONNECT_STORM_SRS 묶음 S — 없는 도구를 되풀이해 부르는 쪽만 늦춘다.
// 검증 V-RCS-9~9c.

// V-RCS-9a: 첫 미스는 늦추지 않는다. 규약을 지키는 클라이언트는 한 번에 판정을
// 끝내므로(FR-RCS-1) 지연을 겪을 이유가 없다.
func TestMissTrackerFirstMissIsNotDelayed(t *testing.T) {
	var mt missTracker
	if mt.repeat("tool-a", time.Unix(0, 0)) {
		t.Fatal("첫 미스가 반복으로 판정됐다 — FR-RCS-9a 위반")
	}
}

// V-RCS-9: 창 안의 두 번째 미스부터 반복이다.
func TestMissTrackerRepeatWithinWindow(t *testing.T) {
	var mt missTracker
	base := time.Unix(100, 0)
	mt.repeat("tool-a", base)
	if !mt.repeat("tool-a", base.Add(MissRepeatWindow/2)) {
		t.Fatal("창 안의 재요청이 반복으로 판정되지 않았다 — FR-RCS-9 위반")
	}
}

// 창을 지나면 다시 "첫 미스"다 — 오래 뒤에 온 정상 요청을 벌하지 않는다.
func TestMissTrackerForgetsAfterWindow(t *testing.T) {
	var mt missTracker
	base := time.Unix(100, 0)
	mt.repeat("tool-a", base)
	if mt.repeat("tool-a", base.Add(MissRepeatWindow+time.Second)) {
		t.Fatal("창을 지난 요청이 반복으로 판정됐다")
	}
}

// 도구마다 따로 센다 — 한 도구의 폭주가 다른 도구의 첫 요청을 늦추면 안 된다.
func TestMissTrackerIsPerTool(t *testing.T) {
	var mt missTracker
	base := time.Unix(100, 0)
	mt.repeat("tool-a", base)
	mt.repeat("tool-a", base.Add(time.Millisecond))
	if mt.repeat("tool-b", base.Add(2*time.Millisecond)) {
		t.Fatal("다른 도구의 첫 미스가 반복으로 판정됐다 — FR-RCS-9 위반")
	}
}

// V-RCS-9c: 추적 상태가 무한히 자라지 않는다. 창을 지난 항목은 버린다.
func TestMissTrackerPrunesStaleEntries(t *testing.T) {
	var mt missTracker
	base := time.Unix(100, 0)
	for i := range 500 {
		mt.repeat(string(rune('a'+i%26))+string(rune('a'+i/26)), base)
	}
	// 창을 훌쩍 지난 시각의 요청 하나가 오래된 항목 전부를 쓸어 간다.
	mt.repeat("late", base.Add(10*MissRepeatWindow))
	if n := mt.size(); n > 1 {
		t.Fatalf("낡은 항목이 %d개 남았다 — FR-RCS-9c 위반", n)
	}
}

// V-RCS-9b: 지연 중 요청이 취소되면 즉시 그만둔다. 서버 종료가 지연에
// 발목잡히면 안 된다.
func TestThrottleMissStopsOnContextCancel(t *testing.T) {
	s := &Server{}
	// 첫 호출로 기록만 세운다 (늦추지 않는다).
	s.throttleMiss(context.Background(), "tool-a")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	s.throttleMiss(ctx, "tool-a")
	if el := time.Since(start); el > MissDelay/2 {
		t.Fatalf("취소된 컨텍스트인데 %v 를 기다렸다 — FR-RCS-9b 위반", el)
	}
}

// 반복 미스는 실제로 늦춘다 — 이것이 봉쇄의 실체다.
func TestThrottleMissDelaysRepeat(t *testing.T) {
	s := &Server{}
	start := time.Now()
	s.throttleMiss(context.Background(), "tool-a")
	if el := time.Since(start); el > MissDelay/2 {
		t.Fatalf("첫 미스를 %v 늦췄다 — FR-RCS-9a 위반", el)
	}

	start = time.Now()
	s.throttleMiss(context.Background(), "tool-a")
	if el := time.Since(start); el < MissDelay {
		t.Fatalf("반복 미스를 %v 만 늦췄다 (want ≥ %v) — FR-RCS-9 위반", el, MissDelay)
	}
}
