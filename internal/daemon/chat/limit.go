package chat

import "time"

// limiter 는 키마다 창(window) 안의 횟수를 센다 (FR-PCH-55). 잠금은 부르는 쪽이 쥔다.
type limiter struct {
	max    int
	window time.Duration
	now    func() time.Time
	hits   map[string][]time.Time
}

// sweepAt 은 키가 이만큼 쌓이면 창을 지난 키를 지우는 문턱이다. 받는 쪽의 키는 상대가 고른다.
const sweepAt = 1024

func newLimiter(max int, window time.Duration, now func() time.Time) *limiter {
	return &limiter{max: max, window: window, now: now, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(key string) bool {
	now := l.now()
	cut := now.Add(-l.window)
	if len(l.hits) >= sweepAt {
		for k, ts := range l.hits {
			if len(ts) == 0 || !ts[len(ts)-1].After(cut) {
				delete(l.hits, k)
			}
		}
	}
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}

// seenSet 은 최근 본 글 id 다. 가득 차면 가장 오래된 것부터 잊는다 (FR-PCH-4).
type seenSet struct {
	ids  map[string]bool
	ring []string
	next int
}

func newSeenSet(n int) *seenSet {
	return &seenSet{ids: make(map[string]bool, n), ring: make([]string, n)}
}

func (s *seenSet) has(id string) bool { return s.ids[id] }

func (s *seenSet) add(id string) {
	if s.ids[id] {
		return
	}
	if old := s.ring[s.next]; old != "" {
		delete(s.ids, old)
	}
	s.ring[s.next] = id
	s.ids[id] = true
	s.next = (s.next + 1) % len(s.ring)
}
