package peer

import (
	"strconv"
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

// S9: 키는 상대가 고를 수 있다(지문·주소). 창을 지난 키는 지워서 맵이 끝없이 크지 않게 한다.
func TestRateLimiterForgetsStaleKeys(t *testing.T) {
	clk := newFakeClock()
	rl := NewRateLimiter(clk.now)
	for i := range rateSweepAt {
		rl.Allow(strconv.Itoa(i))
	}
	clk.advance(time.Minute + time.Second)
	rl.Allow("fresh")
	if n := rl.size(); n != 1 {
		t.Fatalf("지난 키가 남았다: %d", n)
	}
}

func (r *RateLimiter) size() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.hits)
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

// 보안 재리뷰(3차) #4: 살아 있는 키가 문턱을 넘어도 정리는 창마다 한 번이다. 요청마다 맵 전체를
// 훑지 않는다.
func TestRateLimiterSweepsOncePerWindow(t *testing.T) {
	clk := newFakeClock()
	rl := NewRateLimiter(clk.now)
	for i := range rateSweepAt {
		rl.Allow(strconv.Itoa(i))
	}
	rl.Allow("x")
	first := rl.sweeps
	for i := range 10 {
		rl.Allow("y" + strconv.Itoa(i))
	}
	if rl.sweeps != first {
		t.Fatalf("창 안에서 정리를 %d번 더 돌았다", rl.sweeps-first)
	}
	clk.advance(rateWindow)
	rl.Allow("z")
	if rl.sweeps != first+1 {
		t.Fatalf("창이 지났는데 정리하지 않았다 (%d)", rl.sweeps)
	}
}

// 보안 재리뷰(3차) #4: IPv6 는 /64 하나를 한 출발지로 센다. IPv4 는 주소 하나다.
func TestPairRateKey(t *testing.T) {
	cases := []struct {
		a, b string
		same bool
	}{
		{"2001:db8:1:2::1", "2001:db8:1:2:ffff::9", true},
		{"2001:db8:1:2::1", "2001:db8:1:3::1", false},
		{"10.0.0.1", "10.0.0.2", false},
		{"::ffff:10.0.0.1", "10.0.0.1", true},
	}
	for _, c := range cases {
		if got := AddrRateKey(c.a) == AddrRateKey(c.b); got != c.same {
			t.Errorf("%s ~ %s: %v, 기대 %v (%q %q)", c.a, c.b, got, c.same, AddrRateKey(c.a), AddrRateKey(c.b))
		}
	}
	if AddrRateKey("not-an-ip") == "" {
		t.Error("읽지 못한 주소도 키가 있어야 한다")
	}
}

// UX_BATCH12 FR-LIV-9: 시각은 언제나 갱신하고, 알릴지는 그 키의 마지막 알림에서 every 가 지났는가로 정한다.
func TestLastSeenTouchEvery(t *testing.T) {
	l := NewLastSeen()
	t0 := time.Unix(1_700_000_000, 0)
	if !l.TouchEvery("k", t0, time.Minute) {
		t.Fatal("첫 갱신은 알려야 한다")
	}
	if l.TouchEvery("k", t0.Add(10*time.Second), time.Minute) {
		t.Fatal("60초 안의 갱신은 알리지 않는다")
	}
	if got, _ := l.Get("k"); !got.Equal(t0.Add(10 * time.Second)) {
		t.Fatalf("시각이 갱신되지 않았다: %v", got)
	}
	if !l.TouchEvery("k", t0.Add(61*time.Second), time.Minute) {
		t.Fatal("60초가 지나면 다시 알린다")
	}
	if !l.TouchEvery("other", t0.Add(11*time.Second), time.Minute) {
		t.Fatal("다른 짝은 따로 센다")
	}
}
