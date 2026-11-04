package hub

import (
	"context"
	"sort"
	"sync"
	"testing"
	"time"
)

// EDITOR_LIVE_RELOAD_SRS FR-ELR-75·76 (V-ELR-35·36) — 감시 이벤트가 저장소 관측을 당긴다.

type kickTimer struct {
	at      time.Duration
	f       func()
	stopped bool
}

type kickClock struct {
	mu     sync.Mutex
	now    time.Duration
	timers []*kickTimer
}

func (c *kickClock) after(d time.Duration, f func()) func() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &kickTimer{at: c.now + d, f: f}
	c.timers = append(c.timers, t)
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		was := !t.stopped
		t.stopped = true
		return was
	}
}

func (c *kickClock) advance(d time.Duration) {
	c.mu.Lock()
	end := c.now + d
	c.mu.Unlock()
	for {
		c.mu.Lock()
		sort.SliceStable(c.timers, func(i, j int) bool { return c.timers[i].at < c.timers[j].at })
		var next *kickTimer
		for _, t := range c.timers {
			if !t.stopped && t.at <= end {
				next = t
				break
			}
		}
		if next == nil {
			c.now = end
			c.mu.Unlock()
			return
		}
		next.stopped = true
		c.now = next.at
		c.mu.Unlock()
		next.f()
	}
}

func kickFx(t *testing.T) (*GitWatcher, *fakeSigner, *fakeBroker, *kickClock) {
	t.Helper()
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	br := &fakeBroker{}
	w := newWatcher(sig, br)
	clk := &kickClock{}
	w.after = clk.after
	note(t, w, sig, "/r")
	return w, sig, br, clk
}

func statusCalls(sig *fakeSigner) int {
	sig.mu.Lock()
	defer sig.mu.Unlock()
	return sig.calls
}

func TestGitWatchKick_ObservesAfterDebounce(t *testing.T) {
	w, sig, br, clk := kickFx(t)
	sig.files = map[string][]string{"/r": {"new.txt"}}
	w.Kick([]string{"/r/new.txt"})
	clk.advance(GitKickDebounce - time.Millisecond)
	if n := statusCalls(sig); n != 0 {
		t.Fatalf("debounce 전에 관측했다: %d", n)
	}
	clk.advance(time.Millisecond)
	if n := statusCalls(sig); n != 1 {
		t.Fatalf("관측 %d번, want 1", n)
	}
	if sig.invalidated == 0 {
		t.Fatal("관측 전에 Invalidate 하지 않았다")
	}
	if got := gitChangedRepos(br); len(got) != 1 || got[0] != "/r" {
		t.Fatalf("방송=%v, want [/r]", got)
	}
}

func TestGitWatchKick_DebounceRestartsOnNewEvent(t *testing.T) {
	w, sig, _, clk := kickFx(t)
	w.Kick([]string{"/r/a"})
	clk.advance(600 * time.Millisecond)
	w.Kick([]string{"/r/b"})
	clk.advance(600 * time.Millisecond)
	if n := statusCalls(sig); n != 0 {
		t.Fatalf("마지막 이벤트 뒤 1초 전에 관측했다: %d", n)
	}
	clk.advance(400 * time.Millisecond)
	if n := statusCalls(sig); n != 1 {
		t.Fatalf("관측 %d번, want 1", n)
	}
}

func TestGitWatchKick_CooldownCoalesces(t *testing.T) {
	w, sig, _, clk := kickFx(t)
	w.Kick([]string{"/r/a"})
	clk.advance(GitKickDebounce)
	if n := statusCalls(sig); n != 1 {
		t.Fatalf("첫 관측 %d", n)
	}
	for i := 0; i < 3; i++ {
		clk.advance(300 * time.Millisecond)
		w.Kick([]string{"/r/a"})
	}
	clk.advance(GitKickCooldown - 2*time.Second)
	if n := statusCalls(sig); n != 1 {
		t.Fatalf("쉬는 동안 관측했다: %d", n)
	}
	clk.advance(10 * time.Second)
	if n := statusCalls(sig); n != 2 {
		t.Fatalf("쉼 뒤 관측 %d번, want 2 (한 번으로 모인다)", n)
	}
}

func TestGitWatchKick_IgnoresDotGitAndOutside(t *testing.T) {
	w, sig, _, clk := kickFx(t)
	w.Kick([]string{"/r/.git/index", "/r/.git", "/rr/x", "/other/y"})
	clk.advance(time.Minute)
	if n := statusCalls(sig); n != 0 {
		t.Fatalf("계기가 아닌 경로가 관측을 불렀다: %d", n)
	}
}

func TestGitWatchKick_UnwatchedRepoIgnored(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{}}
	w := newWatcher(sig, &fakeBroker{})
	clk := &kickClock{}
	w.after = clk.after
	w.Kick([]string{"/r/a"})
	clk.advance(time.Minute)
	if n := statusCalls(sig); n != 0 {
		t.Fatalf("감시하지 않는 저장소를 관측했다: %d", n)
	}
}

// V-ELR-35 (FR-ELR-76): 워크트리 회차 간격을 바꾸면 다음 회차부터 적용된다.
func TestGitWatch_WorktreeEverySettable(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	note(t, w, sig, "/r")
	w.SetWorktreeEvery(2)
	base := statusCalls(sig)
	for i := 0; i < 8; i++ {
		w.Tick(context.Background())
	}
	if n := statusCalls(sig) - base; n != 4 {
		t.Fatalf("8회차 중 워크트리 회차 %d, want 4", n)
	}
	w.SetWorktreeEvery(0) // 범위 밖 → 기본값
	base = statusCalls(sig)
	for i := 0; i < 8; i++ {
		w.Tick(context.Background())
	}
	if n := statusCalls(sig) - base; n != 8/GitWatchWorktreeEvery {
		t.Fatalf("기본값으로 8회차 중 %d, want %d", n, 8/GitWatchWorktreeEvery)
	}
}
