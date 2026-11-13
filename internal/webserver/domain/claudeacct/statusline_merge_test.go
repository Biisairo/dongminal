package claudeacct

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TC-CAC-29: statusLine 값과 OAuth 값의 합치기 (FR-CAC-78), 문턱값 100 (D-CAC-23).

type slObs struct {
	u  Usage
	at int64
}

// withStatusLine 은 엔진에 계정별 statusLine 값을 단다. 키는 이메일이다.
func withStatusLine(eng *Engine) map[string]slObs {
	m := map[string]slObs{}
	eng.StatusLine = func(a Account) (Usage, int64, bool) {
		o, ok := m[a.Email]
		return o.u, o.at, ok
	}
	return m
}

func win(pct float64, resets int64) *Window { return &Window{Pct: pct, ResetsAt: resets} }

func TestMergeWindow(t *testing.T) {
	now := int64(1000)
	cases := []struct {
		name      string
		oauth, sl *Window
		want      *Window
	}{
		{"both nil", nil, nil, nil},
		{"oauth only", win(30, 5000), nil, win(30, 5000)},
		{"sl only", nil, win(40, 5000), win(40, 5000)},
		{"bigger wins", win(30, 5000), win(45, 5000), win(45, 5000)},
		{"bigger wins oauth", win(50, 5000), win(45, 5100), win(50, 5000)},
		{"reset passed dropped", win(90, 900), win(10, 0), win(10, 0)},
		{"both reset passed", win(90, 900), win(80, 999), nil},
		{"newer window wins", win(95, 2000), win(5, 20000), win(5, 20000)},
		{"unknown reset keeps max", win(20, 0), win(25, 5000), win(25, 5000)},
	}
	for _, c := range cases {
		got := mergeWindow(c.oauth, c.sl, now)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Fatalf("%s: %+v", c.name, got)
		}
	}
}

func TestDecisionUsesBiggerStatusLine(t *testing.T) {
	_, eng, _, clock := threeAccounts(t)
	sl := withStatusLine(eng)
	sl["c@x.com"] = slObs{u: Usage{FiveHour: win(95, 0)}, at: clock.Unix()}
	acc := mustAccount(t, eng, "id3")
	if h, ok := eng.freshHeadroom(acc, map[string]bool{}); !ok || h != 5 {
		t.Fatalf("max(80, 95) → 5: %v %v", h, ok)
	}
	sl["c@x.com"] = slObs{u: Usage{FiveHour: win(50, 0)}, at: clock.Unix()}
	if h, _ := eng.freshHeadroom(acc, map[string]bool{}); h != 20 {
		t.Fatalf("oauth is bigger: %v", h)
	}
}

func TestStatusLineFreshnessAndSwitchGrace(t *testing.T) {
	_, eng, api, clock := threeAccounts(t)
	sl := withStatusLine(eng)
	acc := mustAccount(t, eng, "id3")
	sl["c@x.com"] = slObs{u: Usage{FiveHour: win(95, 0)}, at: clock.Unix() - 301}
	if h, _ := eng.freshHeadroom(acc, map[string]bool{}); h != 20 {
		t.Fatalf("old statusLine ignored: %v", h)
	}
	// OAuth 가 낡아도 신선한 statusLine 이 있으면 안다.
	*clock = clock.Add(10 * time.Minute)
	sl["c@x.com"] = slObs{u: Usage{FiveHour: win(60, 0)}, at: clock.Unix()}
	if h, ok := eng.freshHeadroom(acc, map[string]bool{}); !ok || h != 40 {
		t.Fatalf("statusLine alone is known: %v %v", h, ok)
	}
	// dongminal 이 전환하면 60초 동안의 statusLine 은 옛 토큰일 수 있어 쓰지 않는다.
	api.usage["at-c"] = `{"five_hour":{"utilization":80}}`
	if _, err := eng.Switch(context.Background(), SwitchRequest{ID: "id1"}); err != nil {
		t.Fatal(err)
	}
	a1 := mustAccount(t, eng, "id1")
	sl["a@x.com"] = slObs{u: Usage{FiveHour: win(99, 0)}, at: clock.Unix() + 30}
	*clock = clock.Add(40 * time.Second)
	if _, ok := eng.freshHeadroom(a1, map[string]bool{}); ok {
		t.Fatal("report within 60s after switch is ignored (oauth is stale too)")
	}
	sl["a@x.com"] = slObs{u: Usage{FiveHour: win(99, 0)}, at: clock.Unix() + 30}
	*clock = clock.Add(40 * time.Second)
	if h, ok := eng.freshHeadroom(a1, map[string]bool{}); !ok || h != 1 {
		t.Fatalf("after grace: %v %v", h, ok)
	}
}

func TestAutoSwitchesOnStatusLineAtThreshold100(t *testing.T) {
	x := newAutoEnv(t)
	sl := withStatusLine(x.eng)
	x.put(t, `{"enabled":true,"threshold":100}`)
	sl["c@x.com"] = slObs{u: Usage{FiveHour: win(99, 0)}, at: x.clock.Unix()}
	x.tick()
	if x.active() != "id3" {
		t.Fatal("99% under line 100 — stay")
	}
	sl["c@x.com"] = slObs{u: Usage{FiveHour: win(100, 0)}, at: x.clock.Unix()}
	x.tick()
	if x.active() != "id1" || x.auto.View().State.LastSwitch.Trigger != TriggerAtLimit {
		t.Fatalf("statusLine 100%% → at-limit: %s", x.active())
	}
}

func TestAutoProactiveFromStatusLine(t *testing.T) {
	x := newAutoEnv(t)
	sl := withStatusLine(x.eng)
	x.put(t, `{"enabled":true}`)
	sl["c@x.com"] = slObs{u: Usage{FiveHour: win(92, 0)}, at: x.clock.Unix()}
	x.tick()
	if x.active() != "id1" || x.auto.View().State.LastSwitch.Trigger != TriggerProactive {
		t.Fatalf("oauth 80 but statusLine 92 ≥ 90: %s", x.active())
	}
}

func TestThresholdRangeUpTo100(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"threshold":100,"weeklyThreshold":100}`)
	if _, err := x.auto.Put([]byte(`{"threshold":100.1}`)); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	hundred, over := 100.0, 100.1
	if err := (Patch{Threshold: &hundred}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (Patch{Threshold: &over}).Validate(); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}

func TestLineHeadroomAtLine100(t *testing.T) {
	cases := []struct{ pct, want float64 }{{0, 100}, {50, 55}, {99, 10.9}, {100, 0}}
	for _, c := range cases {
		if got := lineHeadroom(c.pct, 100, 90); got < c.want-1e-9 || got > c.want+1e-9 {
			t.Fatalf("%v → %v", c.pct, got)
		}
	}
}

func mustAccount(t *testing.T, eng *Engine, id string) Account {
	t.Helper()
	st, err := eng.Svc.Store.Load()
	if err != nil || st.Find(id) < 0 {
		t.Fatal(id, err)
	}
	return st.Accounts[st.Find(id)]
}
