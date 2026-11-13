package claudeacct

import "testing"

func TestBuildViews(t *testing.T) {
	st := State{ActiveID: "b", Accounts: []Account{{ID: "a", Email: "a@x.com"}, {ID: "b", Email: "b@x.com"}}}
	now := int64(1_000_000)
	u := &Usage{
		FiveHour: &Window{Pct: 10, ResetsAt: now + 3600},
		SevenDay: &Window{Pct: 60, ResetsAt: now + 4*86400},
		Scoped:   []ScopedWindow{{Name: "Opus", Window: Window{Pct: 30, ResetsAt: now + 4*86400}}},
	}
	rows := map[string]Row{
		"a": {LastGood: u, FetchedAt: now - 400, Status: StatusOK, LoginExpiresAt: now + 3*86400, NextPollAt: now + 10},
	}
	vs := BuildViews(st, rows, now)
	if len(vs) != 2 || vs[0].ID != "a" || vs[0].Active || !vs[1].Active {
		t.Fatalf("%+v", vs)
	}
	a := vs[0]
	if a.Usage == nil || a.Usage.Status != StatusOK || a.Usage.AgeSeconds != 400 || !a.Usage.Stale {
		t.Fatalf("%+v", a.Usage)
	}
	if a.Usage.Pace.SevenDay == nil || a.Usage.Pace.Scoped["Opus"] == nil {
		t.Fatalf("pace %+v", a.Usage.Pace)
	}
	if a.Usage.LoginExpiresAt != now+3*86400 || !a.Usage.LoginExpiringSoon {
		t.Fatalf("login %+v", a.Usage)
	}
	if vs[1].Usage == nil || vs[1].Usage.Status != "" || vs[1].Usage.Windows != nil {
		t.Fatalf("no row yet → empty usage view: %+v", vs[1].Usage)
	}
}

// FR-CAC-91·93: 창마다 등급(70/90)과 남은 시간을 서버가 셈한다 (D-ASV-10).
func TestBuildViewsWindowLevels(t *testing.T) {
	st := State{Accounts: []Account{{ID: "a"}}}
	now := int64(1_000_000)
	u := &Usage{
		FiveHour: &Window{Pct: 10, ResetsAt: now + 3600},
		SevenDay: &Window{Pct: 75, ResetsAt: now - 5},
		Scoped:   []ScopedWindow{{Name: "Opus", Window: Window{Pct: 95}}},
		Spend:    &Spend{Used: 12.4, Limit: 50, Pct: 24.8, Currency: "USD"},
	}
	vs := BuildViews(st, map[string]Row{"a": {LastGood: u, FetchedAt: now}}, now)
	w := vs[0].Usage.Windows
	if w == nil || w.FiveHour == nil || w.SevenDay == nil || len(w.Scoped) != 1 || w.Spend == nil {
		t.Fatalf("%+v", w)
	}
	if w.FiveHour.Pct != 10 || w.FiveHour.Level != "" || w.FiveHour.ResetsInSec == nil || *w.FiveHour.ResetsInSec != 3600 {
		t.Fatalf("fiveHour %+v", w.FiveHour)
	}
	if w.SevenDay.Level != "warn" || w.SevenDay.ResetsInSec == nil || *w.SevenDay.ResetsInSec != 0 {
		t.Fatalf("sevenDay: 지난 초기화는 0 이다 %+v", w.SevenDay)
	}
	if s := w.Scoped[0]; s.Name != "Opus" || s.Level != "critical" || s.ResetsInSec != nil {
		t.Fatalf("scoped: 초기화 시각을 모르면 남은 시간이 없다 %+v", s)
	}
	if w.Spend.Used != 12.4 || w.Spend.Currency != "USD" {
		t.Fatalf("spend %+v", w.Spend)
	}
}

func TestUsageLevel(t *testing.T) {
	for _, c := range []struct {
		pct  float64
		want string
	}{{0, ""}, {69.9, ""}, {70, "warn"}, {89.9, "warn"}, {90, "critical"}, {120, "critical"}} {
		if got := UsageLevel(c.pct); got != c.want {
			t.Errorf("UsageLevel(%v)=%q want %q", c.pct, got, c.want)
		}
	}
}

// FR-CAC-65: 조회한 초기화 상태는 usage.resets 로 나간다. 조회한 적이 없으면 없다.
func TestBuildViewsResets(t *testing.T) {
	st := State{Accounts: []Account{{ID: "a"}, {ID: "b"}}}
	rs := &Resets{Juniper: &JuniperStatus{Eligible: true, Available: true}, FetchedAt: 5}
	vs := BuildViews(st, map[string]Row{"a": {Resets: rs}}, 10)
	if vs[0].Usage.Resets != rs || vs[1].Usage.Resets != nil {
		t.Fatalf("%+v %+v", vs[0].Usage.Resets, vs[1].Usage.Resets)
	}
}
