package cli

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// FR-OPT-9-2 (SHR-18): "셸이 무언가 그리고 조용해질 때까지" 는 waitQuiet 하나다.

func withShellPoll(t *testing.T, d time.Duration) {
	t.Helper()
	old := shellPoll
	shellPoll = d
	t.Cleanup(func() { shellPoll = old })
}

func TestWaitQuiet_ReturnsOnceQuiet(t *testing.T) {
	withShellPoll(t, 5*time.Millisecond)
	drawn := time.Now()
	start := time.Now()
	err := waitQuiet(func() (int, time.Time, error) { return 10, drawn, nil }, 5*time.Second, 50*time.Millisecond)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("조용해졌는데 %v 를 기다렸다", el)
	}
}

func TestWaitQuiet_NothingDrawn(t *testing.T) {
	withShellPoll(t, 5*time.Millisecond)
	err := waitQuiet(func() (int, time.Time, error) { return 0, time.Time{}, nil }, 60*time.Millisecond, 10*time.Millisecond)
	if !errors.Is(err, errNothingDrawn) {
		t.Fatalf("err = %v, want errNothingDrawn", err)
	}
}

func TestWaitQuiet_StillChanging(t *testing.T) {
	withShellPoll(t, 5*time.Millisecond)
	err := waitQuiet(func() (int, time.Time, error) { return 1, time.Now(), nil }, 60*time.Millisecond, time.Second)
	if !errors.Is(err, errNotQuiet) {
		t.Fatalf("err = %v, want errNotQuiet", err)
	}
}

func TestWaitQuiet_SnapshotErrorAborts(t *testing.T) {
	withShellPoll(t, 5*time.Millisecond)
	boom := errors.New("boom")
	var calls atomic.Int32
	err := waitQuiet(func() (int, time.Time, error) {
		if calls.Add(1) == 2 {
			return 0, time.Time{}, boom
		}
		return 0, time.Time{}, nil
	}, 5*time.Second, 10*time.Millisecond)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
}

func TestChangeTracker(t *testing.T) {
	var c changeTracker
	if n, at := c.observe(""); n != 0 || !at.IsZero() {
		t.Fatalf("빈 관측: n=%d at=%v", n, at)
	}
	n, at1 := c.observe("ab")
	if n != 2 || at1.IsZero() {
		t.Fatalf("첫 변화: n=%d at=%v", n, at1)
	}
	if _, at2 := c.observe("ab"); !at2.Equal(at1) {
		t.Fatal("같은 관측이 변화 시각을 옮겼다")
	}
}
