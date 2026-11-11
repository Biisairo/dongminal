package peer

import (
	"net/netip"
	"sync"
	"time"
)

// PerPeerPerMinute 는 짝 하나가 1분 동안 보낼 수 있는 요청 수다 (FR-PNW-43).
const PerPeerPerMinute = 60

const rateWindow = time.Minute

// rateSweepAt 은 키가 이만큼 쌓이면 창을 지난 키를 지우는 문턱이다. 키는 상대가 고를 수
// 있다(등록 요청의 주소·지문) — 지우지 않으면 맵이 끝없이 커진다.
const rateSweepAt = 1024

// AddrRateKey 는 출발지 주소의 상한 키다. IPv6 는 /64 하나를 한 출발지로 센다 — 한 망이
// 연결마다 주소를 바꿔 상한을 피하지 못하게 한다. IPv4(IPv4 사상 IPv6 포함)는 주소 하나다.
// 읽지 못한 값은 그대로 키로 쓴다.
func AddrRateKey(host string) string {
	a, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	a = a.Unmap().WithZone("")
	if a.Is4() {
		return a.String()
	}
	return netip.PrefixFrom(a, 64).Masked().String()
}

// RateLimiter 는 짝(지문)마다 지난 1분의 요청 시각을 센다.
type RateLimiter struct {
	mu   sync.Mutex
	now  func() time.Time
	hits map[string][]time.Time
	// lastSweep 는 마지막 정리 시각이다. 정리는 창마다 한 번이다 — 살아 있는 키가 많을 때
	// 요청마다 맵 전체를 훑지 않는다. sweeps 는 정리 횟수다(시험용).
	lastSweep time.Time
	sweeps    int
}

// NewRateLimiter 는 now 를 시계로 쓴다.
func NewRateLimiter(now func() time.Time) *RateLimiter {
	return &RateLimiter{now: now, hits: map[string][]time.Time{}}
}

// Allow 는 key 의 요청 하나를 세고, 상한 안이면 참이다.
func (r *RateLimiter) Allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	cut := now.Add(-rateWindow)
	if len(r.hits) >= rateSweepAt && !now.Before(r.lastSweep.Add(rateWindow)) {
		r.lastSweep = now
		r.sweeps++
		for k, ts := range r.hits {
			if len(ts) == 0 || !ts[len(ts)-1].After(cut) {
				delete(r.hits, k)
			}
		}
	}
	kept := r.hits[key][:0]
	for _, t := range r.hits[key] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= PerPeerPerMinute {
		r.hits[key] = kept
		return false
	}
	r.hits[key] = append(kept, now)
	return true
}

// LastSeen 은 짝(지문)마다 마지막으로 응답을 받은 시각이다. 메모리에만 둔다.
type LastSeen struct {
	mu   sync.Mutex
	at   map[string]time.Time
	told map[string]time.Time
}

// NewLastSeen 은 빈 기록이다.
func NewLastSeen() *LastSeen {
	return &LastSeen{at: map[string]time.Time{}, told: map[string]time.Time{}}
}

// TouchEvery 는 key 의 시각을 t 로 두고, 그 key 를 마지막으로 알린 지 every 가 지났으면
// 알린 것으로 적고 참을 낸다 (UX_BATCH12 FR-LIV-9 — 방송은 짝마다 every 에 한 번).
func (l *LastSeen) TouchEvery(key string, t time.Time, every time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.at[key] = t
	if last, ok := l.told[key]; ok && t.Sub(last) < every {
		return false
	}
	l.told[key] = t
	return true
}

// Touch 는 key 의 시각을 t 로 둔다.
func (l *LastSeen) Touch(key string, t time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.at[key] = t
}

// Get 은 key 의 시각이다. 없으면 ok 가 거짓이다.
func (l *LastSeen) Get(key string) (time.Time, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t, ok := l.at[key]
	return t, ok
}
