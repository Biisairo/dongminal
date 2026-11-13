package claudeacct

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TC-CAC-16·17: 자동 전환 (FR-CAC-70~77).

type autoEnv struct {
	e      *env
	eng    *Engine
	api    *fakeUsageAPI
	clock  *time.Time
	auto   *Auto
	alerts []Alert
	procs  []string
}

func newAutoEnv(t *testing.T) *autoEnv {
	t.Helper()
	e, eng, api, clock := threeAccounts(t)
	x := &autoEnv{e: e, eng: eng, api: api, clock: clock}
	x.auto = x.newAuto()
	if err := x.auto.Load(); err != nil {
		t.Fatal(err)
	}
	return x
}

func (x *autoEnv) newAuto() *Auto {
	return &Auto{
		Eng:    x.eng,
		Now:    func() time.Time { return *x.clock },
		Jitter: func() float64 { return 0 },
		Procs:  func() ([]string, error) { return x.procs, nil },
		Notify: func(a Alert) { x.alerts = append(x.alerts, a) },
	}
}

func (x *autoEnv) put(t *testing.T, body string) AutoView {
	t.Helper()
	v, err := x.auto.Put([]byte(body))
	if err != nil {
		t.Fatalf("put %s: %v", body, err)
	}
	return v
}

// usage 는 계정의 사용량 본문을 바꾸고 바로 조회한다.
func (x *autoEnv) usage(t *testing.T, id, token, body string) {
	t.Helper()
	x.api.usage[token] = body
	r := x.eng.row(id)
	r.LastAttemptAt, r.BackoffUntil = 0, 0
	x.eng.setRow(id, r)
	if err := x.eng.FetchNow(context.Background(), id); err != nil {
		t.Fatal(err)
	}
}

func (x *autoEnv) active() string {
	st, _ := x.e.svc.Store.Load()
	return st.ActiveID
}

func (x *autoEnv) tick() time.Duration { return x.auto.Tick(context.Background()) }

func TestAutoSettingsDefaultsPutAndPersist(t *testing.T) {
	x := newAutoEnv(t)
	v := x.auto.View()
	s := v.Settings
	if s.Enabled || s.Threshold != 90 || s.WeeklyThreshold != nil || s.IntervalSeconds != 60 || s.CooldownSeconds != 300 ||
		s.HysteresisPct != 10 || s.Strategy != AutoStrategyBest || s.UnhealthyTicks != 3 || s.Models != nil {
		t.Fatalf("defaults %+v", s)
	}
	if v.State.Status != AutoOff {
		t.Fatalf("status %s", v.State.Status)
	}
	v = x.put(t, `{"threshold":85,"weeklyThreshold":97,"models":["Fable"],"strategy":"consume-first"}`)
	if v.Settings.Threshold != 85 || *v.Settings.WeeklyThreshold != 97 || v.Settings.Models[0] != "Fable" || v.Settings.Strategy != AutoStrategyConsumeFirst {
		t.Fatalf("%+v", v.Settings)
	}
	y := x.newAuto()
	if err := y.Load(); err != nil {
		t.Fatal(err)
	}
	if y.View().Settings.Threshold != 85 {
		t.Fatal("persisted")
	}
	v = x.put(t, `{"weeklyThreshold":null,"models":"all"}`)
	if v.Settings.WeeklyThreshold != nil || len(v.Settings.Models) != 1 || v.Settings.Models[0] != ModelsAll || v.Settings.Threshold != 85 {
		t.Fatalf("null clears, all accepted: %+v", v.Settings)
	}
	v = x.put(t, `{"models":null}`)
	if v.Settings.Models != nil {
		t.Fatal("models cleared")
	}
	if st, _ := os.Stat(filepath.Join(x.e.data, autoswitchFile)); st.Mode().Perm() != 0o600 {
		t.Fatal("0600")
	}
}

func TestAutoSettingsRejects(t *testing.T) {
	x := newAutoEnv(t)
	for _, b := range []string{
		`{"threshold":49.9}`, `{"threshold":100.1}`, `{"weeklyThreshold":40}`,
		`{"intervalSeconds":14}`, `{"intervalSeconds":3601}`, `{"cooldownSeconds":-1}`, `{"cooldownSeconds":86401}`,
		`{"hysteresisPct":51}`, `{"strategy":"random"}`, `{"unhealthyTicks":0}`, `{"unhealthyTicks":101}`,
		`{"models":"some"}`, `{"models":[""]}`, `{"foo":1}`, `{"enabled":"yes"}`, `not json`, `{"intervalSeconds":1.5}`,
	} {
		if _, err := x.auto.Put([]byte(b)); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: %v", b, err)
		}
	}
	if x.auto.View().Settings.Threshold != 90 {
		t.Fatal("rejected put changes nothing")
	}
}

func TestLineHeadroom(t *testing.T) {
	cases := []struct{ pct, line, scale, want float64 }{
		{80, 90, 90, 20},
		{0, 97, 90, 100},
		{97, 97, 90, 10},
		{100, 97, 90, 0},
		{48.5, 97, 90, 55},
		{98.5, 97, 90, 5},
	}
	for _, c := range cases {
		if got := lineHeadroom(c.pct, c.line, c.scale); math.Abs(got-c.want) > 1e-9 {
			t.Fatalf("%+v → %v", c, got)
		}
	}
}

func TestBindingWindowOverFirst(t *testing.T) {
	weekly := 97.0
	u := &Usage{FiveHour: &Window{Pct: 85}, SevenDay: &Window{Pct: 93, ResetsAt: 5}}
	b, ok := bindingOf(u, map[string]bool{}, 90, &weekly, 90)
	if !ok || b.Over || b.Line != 97 || b.ResetsAt != 5 {
		t.Fatalf("7d binds by line headroom: %+v", b)
	}
	u.FiveHour.Pct = 91
	b, _ = bindingOf(u, map[string]bool{}, 90, &weekly, 90)
	if !b.Over || b.Line != 90 {
		t.Fatalf("over-line window first: %+v", b)
	}
	if _, ok := bindingOf(&Usage{}, nil, 90, nil, 90); ok {
		t.Fatal("no window")
	}
}

func TestCswapAutoRunning(t *testing.T) {
	cases := []struct {
		args []string
		want bool
	}{
		{[]string{"/Users/u/.local/bin/cswap auto"}, true},
		{[]string{"/opt/py/bin/python3 /Users/u/.local/bin/claude-swap auto --interval 60"}, true},
		{[]string{"python3 -m claude_swap auto --once"}, true},
		{[]string{"cswap auto --dry-run"}, false},
		{[]string{"cswap list"}, false},
		{[]string{"cswap menubar"}, false},
		{[]string{"vim auto cswap"}, false},
		{[]string{"/bin/zsh", "grep cswap auto"}, false},
		{nil, false},
	}
	for _, c := range cases {
		if got := CswapAutoRunning(c.args); got != c.want {
			t.Fatalf("%v → %v", c.args, got)
		}
	}
}

func TestAutoEnableBlockedByCswapAndStopsWhenFound(t *testing.T) {
	x := newAutoEnv(t)
	x.procs = []string{"/Users/u/.local/bin/cswap auto"}
	if _, err := x.auto.Put([]byte(`{"enabled":true}`)); !errors.Is(err, ErrCswapRunning) {
		t.Fatalf("%v", err)
	}
	if x.auto.View().Settings.Enabled {
		t.Fatal("not enabled")
	}
	x.procs = nil
	x.put(t, `{"enabled":true}`)
	x.procs = []string{"/Users/u/.local/bin/cswap auto"}
	x.tick()
	if x.auto.View().Settings.Enabled || x.auto.View().State.Status != AutoOff {
		t.Fatal("stopped")
	}
	if len(x.alerts) != 1 || x.alerts[0].Kind != AlertAutoswitchStopped {
		t.Fatalf("%+v", x.alerts)
	}
	y := x.newAuto()
	_ = y.Load()
	if y.View().Settings.Enabled {
		t.Fatal("off is persisted")
	}
}

func TestAutoBelowLineBestDoesNothing(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true}`)
	d := x.tick()
	if x.active() != "id3" || x.auto.View().State.Status != AutoOn {
		t.Fatal(x.active(), x.auto.View().State.Status)
	}
	if d != 60*time.Second {
		t.Fatalf("delay %v", d)
	}
}

func TestAutoDisabledDoesNotSwitch(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"threshold":75}`)
	if d := x.tick(); d < 300*time.Second {
		t.Fatalf("idle delay %v", d)
	}
	if x.active() != "id3" {
		t.Fatal("disabled")
	}
}

func TestAutoProactiveSwitchesAndRecords(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true,"threshold":75}`)
	x.tick()
	if x.active() != "id1" {
		t.Fatalf("active %s", x.active())
	}
	ls := x.auto.View().State.LastSwitch
	if ls == nil || ls.From != "id3" || ls.To != "id1" || ls.Trigger != TriggerProactive || ls.LeftHeadroom == nil || *ls.LeftHeadroom != 20 || ls.At != nowUnix {
		t.Fatalf("%+v", ls)
	}
	h, _ := ReadHistory(x.e.data, 1)
	if h[0].By != ByAuto || h[0].Trigger != TriggerProactive {
		t.Fatalf("%+v", h[0])
	}
	if len(x.alerts) != 1 || x.alerts[0].Kind != AlertAutoswitch || x.alerts[0].Trigger != TriggerProactive {
		t.Fatalf("%+v", x.alerts)
	}
}

func TestAutoHysteresisBlocks(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true,"threshold":75,"hysteresisPct":50}`)
	x.usage(t, "id1", "at-a", `{"five_hour":{"utilization":31}}`)
	x.tick()
	if x.active() != "id3" {
		t.Fatal("69-20 < 50")
	}
}

func TestAutoCooldownBlocksProactiveNotAtLimit(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true,"threshold":75}`)
	x.tick() // id3 → id1
	*x.clock = x.clock.Add(70 * time.Second)
	x.usage(t, "id1", "at-a", `{"five_hour":{"utilization":80}}`)
	x.usage(t, "id2", "at-b", `{"five_hour":{"utilization":10}}`)
	x.tick()
	if x.active() != "id1" {
		t.Fatal("cooldown blocks proactive")
	}
	x.usage(t, "id1", "at-a", `{"five_hour":{"utilization":100}}`)
	x.tick()
	if x.active() != "id2" {
		t.Fatalf("at-limit ignores cooldown: %s", x.active())
	}
	if x.auto.View().State.LastSwitch.Trigger != TriggerAtLimit {
		t.Fatal("trigger")
	}
}

func TestAutoFailoverAfterUnhealthyTicks(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true,"unhealthyTicks":2}`)
	x.api.status["at-c"] = 500
	*x.clock = x.clock.Add(10 * time.Minute)
	x.tick()
	if x.active() != "id3" {
		t.Fatal("first unknown tick waits")
	}
	*x.clock = x.clock.Add(61 * time.Second)
	x.tick()
	if x.active() != "id1" {
		t.Fatalf("failover: %s", x.active())
	}
	if x.auto.View().State.LastSwitch.Trigger != TriggerFailover {
		t.Fatal("trigger")
	}
}

func TestAutoUnmanaged(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true,"threshold":75}`)
	x.e.loginCred("z@x.com", "org-z", "acc-z", futureCred("at-z", "rt-z"))
	x.tick()
	if x.auto.View().State.Status != AutoUnmanaged {
		t.Fatalf("%s", x.auto.View().State.Status)
	}
	if x.active() != "id3" {
		t.Fatal("no switch")
	}
}

func TestAutoAllExhaustedSleeps(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true}`)
	soon := time.Unix(nowUnix+120, 0).UTC().Format(time.RFC3339)
	for _, a := range [][2]string{{"id1", "at-a"}, {"id2", "at-b"}, {"id3", "at-c"}} {
		x.usage(t, a[0], a[1], `{"five_hour":{"utilization":100,"resets_at":"`+soon+`"}}`)
	}
	d := x.tick()
	if x.auto.View().State.Status != AutoExhausted || x.active() != "id3" {
		t.Fatal(x.auto.View().State.Status)
	}
	if d != 180*time.Second {
		t.Fatalf("earliest reset + 60: %v", d)
	}
}

func TestAutoQuarantineOnPermanentRefreshFailure(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true,"threshold":75}`)
	soon := `{"claudeAiOauth":{"accessToken":"at-a","refreshToken":"rt-a","expiresAt":` + jsonInt((nowUnix+300)*1000) + `}}`
	c, _ := ParseCredential([]byte(soon))
	if err := x.e.svc.Backup.Write("id1", c); err != nil {
		t.Fatal(err)
	}
	x.api.refreshEr["rt-a"] = fmt.Errorf("%w", ErrReloginRequired)
	x.tick()
	if x.active() != "id2" {
		t.Fatalf("next candidate: %s", x.active())
	}
	q := x.auto.View().State.Quarantined
	if len(q) != 1 || q[0] != "id1" {
		t.Fatalf("%v", q)
	}
	// 다시 추가해 지문이 바뀌면 풀린다.
	fresh, _ := ParseCredential([]byte(futureCred("at-a2", "rt-a2")))
	_ = x.e.svc.Backup.Write("id1", fresh)
	x.tick()
	if len(x.auto.View().State.Quarantined) != 0 {
		t.Fatal("released")
	}
}

func TestAutoConsumeFirst(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true,"strategy":"consume-first"}`)
	at := func(d time.Duration) string { return time.Unix(nowUnix, 0).Add(d).UTC().Format(time.RFC3339) }
	x.usage(t, "id3", "at-c", `{"five_hour":{"utilization":20},"seven_day":{"utilization":10,"resets_at":"`+at(5*24*time.Hour)+`"}}`)
	x.usage(t, "id1", "at-a", `{"five_hour":{"utilization":20},"seven_day":{"utilization":10,"resets_at":"`+at(6*24*time.Hour)+`"}}`)
	x.usage(t, "id2", "at-b", `{"five_hour":{"utilization":20},"seven_day":{"utilization":10,"resets_at":"`+at(2*24*time.Hour)+`"}}`)
	x.tick()
	if x.active() != "id2" || x.auto.View().State.LastSwitch.Trigger != TriggerConsumeFirst {
		t.Fatalf("soonest weekly reset: %s", x.active())
	}
}

func TestAutoPriorityConsumeFirst(t *testing.T) {
	x := newAutoEnv(t)
	p := 5
	if _, err := x.e.svc.Update("id1", Patch{Priority: &p}); err != nil {
		t.Fatal(err)
	}
	x.put(t, `{"enabled":true,"strategy":"priority-consume-first"}`)
	x.tick()
	if x.active() != "id1" || x.auto.View().State.LastSwitch.Trigger != TriggerPriority {
		t.Fatalf("higher priority: %s", x.active())
	}
	*x.clock = x.clock.Add(time.Hour)
	x.usage(t, "id1", "at-a", `{"five_hour":{"utilization":30}}`)
	x.tick()
	if x.active() != "id1" {
		t.Fatal("already on the highest priority")
	}
}

func TestAutoNoReturnBar(t *testing.T) {
	x := newAutoEnv(t)
	x.put(t, `{"enabled":true,"threshold":75,"cooldownSeconds":0}`)
	x.tick() // id3(20) → id1(70)
	dis := true
	if _, err := x.e.svc.Update("id2", Patch{Disabled: &dis}); err != nil {
		t.Fatal(err)
	}
	*x.clock = x.clock.Add(70 * time.Second)
	x.usage(t, "id1", "at-a", `{"five_hour":{"utilization":95}}`)
	x.usage(t, "id3", "at-c", `{"five_hour":{"utilization":79}}`)
	x.tick()
	if x.active() != "id1" {
		t.Fatal("id3 has not recovered (21 < 20+3) — barred")
	}
	*x.clock = x.clock.Add(70 * time.Second)
	x.usage(t, "id3", "at-c", `{"five_hour":{"utilization":60}}`)
	x.tick()
	if x.active() != "id3" {
		t.Fatalf("recovered → allowed back: %s", x.active())
	}
}
