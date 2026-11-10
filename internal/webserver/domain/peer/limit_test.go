package peer

import (
	"testing"
	"time"
)

// FR-PNW-43: 짝마다 분당 60회.
func TestRateLimiterPerPeer(t *testing.T) {
	clk := newFakeClock()
	rl := NewRateLimiter(clk.now)
	if PerPeerPerMinute != 60 {
		t.Fatalf("상한 %d", PerPeerPerMinute)
	}
	for i := 0; i < PerPeerPerMinute; i++ {
		if !rl.Allow("a") {
			t.Fatalf("%d번째가 막혔다", i+1)
		}
	}
	if rl.Allow("a") {
		t.Fatal("61번째가 통과했다")
	}
	if !rl.Allow("b") {
		t.Fatal("다른 짝까지 막혔다")
	}
	clk.advance(time.Minute)
	if !rl.Allow("a") {
		t.Fatal("1분 뒤에도 막혀 있다")
	}
}

// 1분 창은 미끄러진다 — 앞 30초에 다 쓰면 그 30초가 지난 뒤에 풀린다.
func TestRateLimiterSlidingWindow(t *testing.T) {
	clk := newFakeClock()
	rl := NewRateLimiter(clk.now)
	for i := 0; i < PerPeerPerMinute; i++ {
		rl.Allow("a")
	}
	clk.advance(59 * time.Second)
	if rl.Allow("a") {
		t.Fatal("59초 뒤에 풀렸다")
	}
	clk.advance(2 * time.Second)
	if !rl.Allow("a") {
		t.Fatal("61초 뒤에도 막혀 있다")
	}
}

// 마지막 응답 시각 (FR-PNW-73 dmctl peers).
func TestLastSeen(t *testing.T) {
	clk := newFakeClock()
	ls := NewLastSeen()
	if _, ok := ls.Get("a"); ok {
		t.Fatal("처음부터 값이 있다")
	}
	ls.Touch("a", clk.t)
	if got, ok := ls.Get("a"); !ok || !got.Equal(clk.t) {
		t.Fatalf("Get = %v %v", got, ok)
	}
}

// FR-PNW-91: 지문으로 받는 쪽이 저장한 이름을 찾는다. pending-out 은 짝 이름이 아니다.
func TestStoreNameOf(t *testing.T) {
	clk := newFakeClock()
	s := newTestStore(t, clk)
	_ = s.AddPeer(Peer{Name: "home", Addr: "h", Port: 1, Fingerprint: fpOf("aa")})
	_ = s.AddPeer(Peer{Name: "lab", Addr: "h", Port: 1, Fingerprint: fpOf("bb"), State: StatePendingOut, Expires: clk.t.Add(PendingTTL)})
	if n, ok := s.NameOf(fpOf("aa")); !ok || n != "home" {
		t.Fatalf("NameOf = %q %v", n, ok)
	}
	if _, ok := s.NameOf(fpOf("bb")); ok {
		t.Fatal("pending-out 의 이름을 짝 이름으로 돌려줬다")
	}
	if p, ok := s.ByName("lab"); !ok || p.State != StatePendingOut {
		t.Fatalf("ByName = %+v %v", p, ok)
	}
	if _, ok := s.ByName("nope"); ok {
		t.Fatal("없는 이름을 찾았다")
	}
}
