package pollwait

import (
	"context"
	"sync"
	"time"
)

// Signal 은 "바뀌었다" 방송이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-8-4). 상태의 주인이
// 바꿀 때 Notify 하고, 기다리는 쪽은 C 로 받은 채널이 닫히기를 기다린다. 제로값을
// 쓸 수 있다.
//
// 기다리는 쪽은 **C 를 먼저 받고** 조건을 묻는다 — 그 사이에 온 Notify 를 놓치지
// 않는다(On 이 그 순서를 지킨다).
type Signal struct {
	mu sync.Mutex
	ch chan struct{}
}

// C 는 다음 Notify 에 닫힐 채널이다.
func (s *Signal) C() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ch == nil {
		s.ch = make(chan struct{})
	}
	return s.ch
}

// Notify 는 지금 기다리는 쪽을 모두 깨운다.
func (s *Signal) Notify() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ch != nil {
		close(s.ch)
		s.ch = nil
	}
}

// On 은 Until 의 알림판이다: cond 를 먼저 한 번 묻고, 그 뒤에는 changed 가 준 채널이
// 닫힐 때만 다시 묻는다 — 최대 max 동안. 오류의 뜻은 Until 과 같다.
func On(ctx context.Context, max time.Duration, changed func() <-chan struct{}, cond func() bool) error {
	timer := time.NewTimer(max)
	defer timer.Stop()
	for {
		ch := changed()
		if cond() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			if cond() {
				return nil
			}
			return ErrTimeout
		case <-ch:
		}
	}
}

// OnOrAt 은 On 에 시간축을 더한 것이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-16-3): cond 는
// 서지 않았으면 다음에 물을 시각을 함께 돌려준다 — 조건이 "경과 시간" 을 품을 때 그
// 시각이 곧 판정이 바뀔 수 있는 가장 이른 때다. changed 가 준 채널이 닫히거나 그
// 시각에 이르면 다시 묻는다. 시각이 영값이면 알림만 기다린다. 상한 max 에 이르면
// 마지막으로 한 번 묻는다. 오류의 뜻은 Until 과 같다.
func OnOrAt(ctx context.Context, max time.Duration, changed func() <-chan struct{}, cond func(now time.Time) (bool, time.Time)) error {
	deadline := time.Now().Add(max)
	timer := time.NewTimer(max)
	defer timer.Stop()
	for {
		ch := changed()
		ok, next := cond(time.Now())
		if ok {
			return nil
		}
		wake := deadline
		if !next.IsZero() && next.Before(deadline) {
			wake = next
		}
		timer.Reset(time.Until(wake))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			if !time.Now().Before(deadline) {
				if ok, _ := cond(time.Now()); ok {
					return nil
				}
				return ErrTimeout
			}
		case <-ch:
		}
	}
}
