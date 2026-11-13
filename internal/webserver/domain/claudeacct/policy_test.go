package claudeacct

import "testing"

// TC-CAC-11: 조회 주기와 물러나기 표. 흔들기는 0 으로 둔다.

func usageOf(five, seven float64, reset5, reset7 int64) *Usage {
	return &Usage{FiveHour: &Window{Pct: five, ResetsAt: reset5}, SevenDay: &Window{Pct: seven, ResetsAt: reset7}}
}

func TestPlanIntervalMovement(t *testing.T) {
	now := int64(10_000)
	far := now + 100_000
	prev := usageOf(10, 10, far, far)
	in := planInput{now: now, prevInterval: 300, prev: prev, next: usageOf(12, 10, far, far), active: false, line: 90}
	if got := planInterval(in, 0); got != 180 {
		t.Fatalf("moved → max(180, 300/2): %d", got)
	}
	in.next = usageOf(10.5, 10, far, far)
	if got := planInterval(in, 0); got != 450 {
		t.Fatalf("still → min(600, 300*1.5): %d", got)
	}
	in.prevInterval = 500
	if got := planInterval(in, 0); got != 600 {
		t.Fatalf("candidate ceiling 600: %d", got)
	}
	in.active = true
	if got := planInterval(in, 0); got != 300 {
		t.Fatalf("active ceiling 300: %d", got)
	}
	in.prev = nil
	in.active = false
	if got := planInterval(in, 0); got != candidateDefaultS {
		t.Fatalf("unknown prev → default: %d", got)
	}
}

func TestPlanIntervalUrgent(t *testing.T) {
	now := int64(10_000)
	far := now + 100_000
	in := planInput{now: now, prevInterval: 300, prev: usageOf(70, 10, far, far), next: usageOf(76, 10, far, far), active: true, line: 90}
	if got := planInterval(in, 0); got != urgentIntervalS {
		t.Fatalf("active rose into line-15 → 60: %d", got)
	}
	in.active = false
	if got := planInterval(in, 0); got == urgentIntervalS {
		t.Fatal("urgent is for the active account only")
	}
}

func TestPlanIntervalRecent429AndExhausted(t *testing.T) {
	now := int64(10_000)
	far := now + 100_000
	in := planInput{now: now, prevInterval: 300, prev: usageOf(10, 10, far, far), next: usageOf(12, 10, far, far), last429: now - 100, line: 90}
	if got := planInterval(in, 0); got != 450 {
		t.Fatalf("recent 429 → max(180, max(300*1.5, 360)): %d", got)
	}
	in.prevInterval = 1500
	if got := planInterval(in, 0); got != 1800 {
		t.Fatalf("429 cap 1800: %d", got)
	}
	in = planInput{now: now, prevInterval: 180, prev: usageOf(100, 10, far, far), next: usageOf(100, 10, far, far), line: 90}
	if got := planInterval(in, 0); got < exhaustedS {
		t.Fatalf("headroom 0 → >= 600: %d", got)
	}
}

func TestPlanNextCappedByReset(t *testing.T) {
	now := int64(10_000)
	in := planInput{now: now, prevInterval: 600, prev: usageOf(10, 10, now+100, now+100_000), next: usageOf(10, 10, now+100, now+100_000), line: 90}
	if got := planNext(in, 0); got != now+100+resetSlackS {
		t.Fatalf("next poll capped at reset+60: %d", got)
	}
}

func TestBackoff(t *testing.T) {
	cases := []struct {
		fails  int
		status int
		ra     string
		want   int64
	}{
		{1, 500, "", 30},
		{2, 500, "", 60},
		{6, 0, "", 600},
		{1, 429, "0", 300},
		{1, 429, "120", 120},
		{3, 429, "120", 120},
		{4, 429, "", 240},
		{1, 429, "700", 1600},
		{1, 429, "9999", 4500},
		{1, 503, "9999", 30},
	}
	for _, c := range cases {
		if got := backoffSeconds(c.fails, c.status, c.ra); got != c.want {
			t.Fatalf("%+v → %d", c, got)
		}
	}
}
