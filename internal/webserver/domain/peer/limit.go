package peer

import (
	"sync"
	"time"
)

// PerPeerPerMinute 는 짝 하나가 1분 동안 보낼 수 있는 요청 수다 (FR-PNW-43).
const PerPeerPerMinute = 60

const rateWindow = time.Minute

// RateLimiter 는 짝(지문)마다 지난 1분의 요청 시각을 센다.
type RateLimiter struct {
	mu   sync.Mutex
	now  func() time.Time
	hits map[string][]time.Time
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
	mu sync.Mutex
	at map[string]time.Time
}

// NewLastSeen 은 빈 기록이다.
func NewLastSeen() *LastSeen { return &LastSeen{at: map[string]time.Time{}} }

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
