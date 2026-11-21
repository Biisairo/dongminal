package hub

import (
	"testing"
	"time"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-22 (GD-17): observe 의 pending 전이와 2차 판정은 순수
// 함수다. 표가 FR-GDT-1·2 와 REPO_FIX 02 §3A-1 의 규칙 그대로다.
func TestPendingStep(t *testing.T) {
	t0 := time.Unix(100, 0)
	t1 := time.Unix(200, 0)
	waitB := watchPend{on: true, sig: "b", at: t0}
	cases := []struct {
		name       string
		cur        watchPend
		last       string
		hasLast    bool
		sig        string
		sigOK      bool
		want       watchPend
		invalidate bool
	}{
		{"읽지 못한 signature 는 바꾸지 않는다", waitB, "a", true, "", false, waitB, false},
		{"확정값과 같으면 바꾸지 않는다", watchPend{}, "a", true, "a", true, watchPend{}, false},
		{"새 변화는 pending 을 세우고 무효화한다", watchPend{}, "a", true, "b", true, watchPend{on: true, sig: "b", at: t1}, true},
		{"기준선이 없으면 첫 값도 변화다", watchPend{}, "", false, "a", true, watchPend{on: true, sig: "a", at: t1}, true},
		{"기다리던 값이면 합류만 한다", waitB, "a", true, "b", true, waitB, false},
		{"기다리는 중 다른 값이 오면 다시 세운다", waitB, "a", true, "c", true, watchPend{on: true, sig: "c", at: t1}, true},
		{"기다리는 중 확정값으로 돌아오면 그대로 둔다", waitB, "a", true, "a", true, waitB, false},
	}
	for _, c := range cases {
		got, inv := pendingStep(c.cur, c.last, c.hasLast, c.sig, c.sigOK, t1)
		if got != c.want || inv != c.invalidate {
			t.Errorf("%s: got %+v/%v, want %+v/%v", c.name, got, inv, c.want, c.invalidate)
		}
	}
}

func TestNeedStatus(t *testing.T) {
	for _, c := range []struct {
		pending, worktree, sigFailed, force, want bool
	}{
		{false, false, false, false, false},
		{true, false, false, false, true},
		{false, true, false, false, true},
		{false, false, true, false, true},
		{false, false, false, true, true},
	} {
		if got := needStatus(c.pending, c.worktree, c.sigFailed, c.force); got != c.want {
			t.Errorf("needStatus(%v,%v,%v,%v) = %v, want %v", c.pending, c.worktree, c.sigFailed, c.force, got, c.want)
		}
	}
}

// 관측이 성립하면, 회차 시작에 기다리던 변화가 아직 기다리는 중일 때만 확정한다.
func TestSettlePending(t *testing.T) {
	waitB := watchPend{on: true, sig: "b"}
	for _, c := range []struct {
		name   string
		waited bool
		cur    watchPend
		want   bool
	}{
		{"기다리던 회차·아직 기다림", true, waitB, true},
		{"기다리지 않던 회차", false, waitB, false},
		{"그 사이 확정됨", true, watchPend{}, false},
		{"빈 signature", true, watchPend{on: true}, false},
	} {
		if got := settlesPending(c.waited, c.cur); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

// FR-RGS-23 (GD-22): Watching 도 Leases 처럼 nil 수신자에 0 이다.
func TestGitWatch_NilWatching(t *testing.T) {
	var w *GitWatcher
	if n := w.Watching(); n != 0 {
		t.Fatalf("nil Watching = %d", n)
	}
}
