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

// replayWindow 는 보낸 노드마다 기억하는 순서 번호의 폭이다.
const replayWindow = 1024

// seqWindow 는 보낸 노드 하나의 글 순서 창이다. 같은 글과 창보다 오래된 글, 지난 epoch 의
// 글을 거른다 (FR-PCH-4). 글 id 를 기억하는 집합과 달리 오래 지나도 잊지 않는다.
type seqWindow struct {
	epoch int64
	max   uint64
	bits  [replayWindow]bool
}

func (w *seqWindow) accept(epoch int64, seq uint64) bool {
	if epoch < w.epoch || seq == 0 {
		return false
	}
	if epoch > w.epoch {
		*w = seqWindow{epoch: epoch}
	}
	switch {
	case seq > w.max:
		if seq-w.max >= replayWindow {
			w.bits = [replayWindow]bool{}
		} else {
			for i := w.max + 1; i < seq; i++ {
				w.bits[i%replayWindow] = false
			}
		}
		w.max = seq
	case w.max-seq >= replayWindow:
		return false
	case w.bits[seq%replayWindow]:
		return false
	}
	w.bits[seq%replayWindow] = true
	return true
}
