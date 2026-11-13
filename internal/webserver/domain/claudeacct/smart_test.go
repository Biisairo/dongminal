package claudeacct

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TC-CAC-7·25: 스마트 전환(FR-CAC-31·31a)과 전환 기록(FR-CAC-110·110a).

// threeAccounts 는 계정 셋(id1·id2·id3, 활성 id3)과 조회한 엔진이다.
// 헤드룸: id1 = 100-30 = 70, id2 = 100-50 = 50, id3 = 100-80 = 20.
func threeAccounts(t *testing.T) (*env, *Engine, *fakeUsageAPI, *time.Time) {
	t.Helper()
	e := newEnv(t)
	clock := time.Unix(nowUnix, 0)
	e.svc.Now = func() time.Time { return clock }
	for _, x := range []string{"a", "b", "c"} {
		e.loginCred(x+"@x.com", "org-"+x, "acc-"+x, futureCred("at-"+x, "rt-"+x))
		if _, _, err := e.svc.AddCurrent(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	api := newFakeUsageAPI()
	api.usage["at-a"] = `{"five_hour":{"utilization":30},"seven_day":{"utilization":10}}`
	api.usage["at-b"] = `{"five_hour":{"utilization":50},"seven_day":{"utilization":10}}`
	api.usage["at-c"] = `{"five_hour":{"utilization":80},"seven_day":{"utilization":10}}`
	eng := &Engine{Svc: e.svc, API: api, Now: func() time.Time { return clock }, Jitter: func() float64 { return 0 }, Stagger: time.Millisecond}
	if err := eng.Load(); err != nil {
		t.Fatal(err)
	}
	eng.Tick(context.Background())
	return e, eng, api, &clock
}

func TestHistoryAppendTrimAndRead(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < historyMax+5; i++ {
		if err := appendHistory(dir, HistoryEntry{At: int64(i), From: "a", To: "b", Trigger: TriggerManual, By: ByUI}); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(filepath.Join(dir, historyFile))
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(b), "\n"); n != historyMax {
		t.Fatalf("lines %d", n)
	}
	got, err := ReadHistory(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].At != int64(historyMax+4) || got[2].At != int64(historyMax+2) {
		t.Fatalf("newest first: %+v", got)
	}
	all, _ := ReadHistory(dir, historyMax)
	if len(all) != historyMax || all[len(all)-1].At != 5 {
		t.Fatalf("oldest kept is 5: %d %+v", len(all), all[len(all)-1])
	}
	if st, _ := os.Stat(filepath.Join(dir, historyFile)); st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %v", st.Mode().Perm())
	}
}

func TestReadHistoryMissingAndBrokenLines(t *testing.T) {
	dir := t.TempDir()
	got, err := ReadHistory(dir, 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("missing file: %v %v", got, err)
	}
	_ = os.WriteFile(filepath.Join(dir, historyFile), []byte("{\"at\":1,\"from\":\"a\",\"to\":\"b\"}\nnot json\n{\"at\":2,\"from\":\"b\",\"to\":\"a\"}\n"), 0o600)
	got, _ = ReadHistory(dir, 10)
	if len(got) != 2 || got[0].At != 2 {
		t.Fatalf("broken line skipped: %+v", got)
	}
}

func TestSwitchByIDRecordsHistory(t *testing.T) {
	e, eng, _, _ := threeAccounts(t)
	res, err := eng.Switch(context.Background(), SwitchRequest{ID: "id1", By: ByDmctl})
	if err != nil || res.To != "id1" || res.From != "id3" {
		t.Fatal(res, err)
	}
	h, _ := ReadHistory(e.data, 10)
	if len(h) != 1 {
		t.Fatalf("%+v", h)
	}
	x := h[0]
	if x.Trigger != TriggerManual || x.By != ByDmctl || x.From != "id3" || x.To != "id1" || x.At != nowUnix {
		t.Fatalf("%+v", x)
	}
	if x.HeadroomFrom == nil || *x.HeadroomFrom != 20 || x.HeadroomTo == nil || *x.HeadroomTo != 70 {
		t.Fatalf("headrooms %+v", x)
	}
}

func TestSwitchByDefaultsAndRejectsBy(t *testing.T) {
	e, eng, _, _ := threeAccounts(t)
	if _, err := eng.Switch(context.Background(), SwitchRequest{ID: "id1", By: "auto"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("auto from API: %v", err)
	}
	if _, err := eng.Switch(context.Background(), SwitchRequest{ID: "id1", By: "robot"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown by: %v", err)
	}
	if _, err := eng.Switch(context.Background(), SwitchRequest{Strategy: "random"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown strategy: %v", err)
	}
	if _, err := eng.Switch(context.Background(), SwitchRequest{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty: %v", err)
	}
	if _, err := eng.Switch(context.Background(), SwitchRequest{ID: "id1"}); err != nil {
		t.Fatal(err)
	}
	h, _ := ReadHistory(e.data, 10)
	if len(h) != 1 || h[0].By != ByUI {
		t.Fatalf("default by ui: %+v", h)
	}
}

func TestSwitchNoopIsNotRecorded(t *testing.T) {
	e, eng, _, _ := threeAccounts(t)
	res, err := eng.Switch(context.Background(), SwitchRequest{ID: "id3"})
	if err != nil || !res.NoOp {
		t.Fatal(res, err)
	}
	if h, _ := ReadHistory(e.data, 10); len(h) != 0 {
		t.Fatalf("%+v", h)
	}
}

func TestSwitchHistoryUnknownHeadroomIsNull(t *testing.T) {
	e, eng, _, clock := threeAccounts(t)
	*clock = clock.Add(10 * time.Minute) // 값이 모두 낡았다. 수동 전환은 다시 조회하지 않는다.
	if _, err := eng.Switch(context.Background(), SwitchRequest{ID: "id1"}); err != nil {
		t.Fatal(err)
	}
	h, _ := ReadHistory(e.data, 10)
	if h[0].HeadroomFrom != nil || h[0].HeadroomTo != nil {
		t.Fatalf("stale → null: %+v", h[0])
	}
}

func TestSwitchNextRecordsStrategyTrigger(t *testing.T) {
	e, eng, _, _ := threeAccounts(t)
	res, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyNext})
	if err != nil || res.To != "id1" {
		t.Fatal(res, err)
	}
	h, _ := ReadHistory(e.data, 10)
	if h[0].Trigger != TriggerNext {
		t.Fatalf("%+v", h[0])
	}
}

func TestNextAvailableSkipsExhausted(t *testing.T) {
	e, eng, api, clock := threeAccounts(t)
	// 활성을 id2 로 옮기고, 다음인 id3 를 소진시킨다 → id1.
	if _, err := eng.Switch(context.Background(), SwitchRequest{ID: "id2"}); err != nil {
		t.Fatal(err)
	}
	api.usage["at-c"] = `{"five_hour":{"utilization":100},"seven_day":{"utilization":10}}`
	*clock = clock.Add(2 * time.Minute)
	if err := eng.FetchNow(context.Background(), "id3"); err != nil {
		t.Fatal(err)
	}
	res, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyNextAvailable})
	if err != nil || res.To != "id1" {
		t.Fatal(res, err)
	}
	h, _ := ReadHistory(e.data, 1)
	if h[0].Trigger != TriggerNextAvailable {
		t.Fatalf("%+v", h[0])
	}
}

func TestNextAvailableSkipsUnknownWithoutRefetchingBackoff(t *testing.T) {
	_, eng, api, clock := threeAccounts(t)
	// id1 은 실패해서 물러나는 중이다 → 값을 모르고 다시 조회하지 않는다.
	api.status["at-a"] = 500
	*clock = clock.Add(10 * time.Minute)
	before := api.count("usage:at-a")
	res, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyNextAvailable})
	if err != nil {
		t.Fatal(err)
	}
	// id1 의 첫 조회는 낡은 값이라 시도했다(실패 → 물러남). 그 뒤 건너뛴다 → id2.
	if res.To != "id2" {
		t.Fatalf("to %s", res.To)
	}
	if api.count("usage:at-a") != before+1 {
		t.Fatalf("one refresh attempt: %v", api.calls)
	}
	r := eng.row("id1")
	r.BackoffUntil = clock.Add(time.Hour).Unix()
	eng.setRow("id1", r)
	*clock = clock.Add(2 * time.Minute)
	if _, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyNextAvailable}); err != nil {
		t.Fatal(err)
	}
	if api.count("usage:at-a") != before+1 {
		t.Fatalf("backoff → no refetch: %v", api.calls)
	}
}

func TestSmartRefreshesStaleFirst(t *testing.T) {
	_, eng, api, clock := threeAccounts(t)
	*clock = clock.Add(10 * time.Minute)
	// 낡은 동안 id1 이 소진됐다. 다시 조회하지 않으면 id1(옛 값 70)을 고를 것이다.
	api.usage["at-a"] = `{"five_hour":{"utilization":100}}`
	res, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyBest})
	if err != nil || res.To != "id2" {
		t.Fatal(res, err)
	}
	if api.count("usage:at-a") != 2 || api.count("usage:at-b") != 2 || api.count("usage:at-c") != 2 {
		t.Fatalf("each stale account fetched once more: %v", api.calls)
	}
}

func TestSmartSkipsRecentAttemptAndDisabledAndDead(t *testing.T) {
	e, eng, api, clock := threeAccounts(t)
	dis := true
	if _, err := e.svc.Update("id2", Patch{Disabled: &dis}); err != nil {
		t.Fatal(err)
	}
	r := eng.row("id1")
	r.AuthDeadFP = "dead"
	eng.setRow("id1", r)
	*clock = clock.Add(10 * time.Minute)
	if _, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyBest}); err != nil {
		t.Fatal(err)
	}
	if api.count("usage:at-a") != 1 || api.count("usage:at-b") != 1 {
		t.Fatalf("dead and disabled are not fetched: %v", api.calls)
	}
	if api.count("usage:at-c") != 2 {
		t.Fatalf("active is fetched: %v", api.calls)
	}
}

func TestBestPicksLargestHeadroom(t *testing.T) {
	e, eng, _, _ := threeAccounts(t)
	res, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyBest, By: ByDmctl})
	if err != nil || res.To != "id1" || res.NoOp {
		t.Fatal(res, err)
	}
	h, _ := ReadHistory(e.data, 1)
	if h[0].Trigger != TriggerBest || h[0].By != ByDmctl {
		t.Fatalf("%+v", h[0])
	}
}

func TestBestTieGoesToEarlierInOrder(t *testing.T) {
	_, eng, api, clock := threeAccounts(t)
	api.usage["at-b"] = api.usage["at-a"]
	*clock = clock.Add(2 * time.Minute)
	_ = eng.FetchNow(context.Background(), "id2")
	res, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyBest})
	if err != nil || res.To != "id1" {
		t.Fatal(res, err)
	}
}

func TestBestReasons(t *testing.T) {
	ctx := context.Background()
	t.Run("stay", func(t *testing.T) {
		e, eng, _, _ := threeAccounts(t)
		if _, err := eng.Switch(ctx, SwitchRequest{ID: "id1"}); err != nil {
			t.Fatal(err)
		}
		res, err := eng.Switch(ctx, SwitchRequest{Strategy: StrategyBest})
		if err != nil || !res.NoOp || res.Reason != ReasonStay || res.To != "id1" {
			t.Fatal(res, err)
		}
		if h, _ := ReadHistory(e.data, 10); len(h) != 1 {
			t.Fatalf("noop not recorded: %+v", h)
		}
	})
	t.Run("current-unavailable", func(t *testing.T) {
		_, eng, api, clock := threeAccounts(t)
		api.status["at-c"] = 500
		*clock = clock.Add(10 * time.Minute)
		res, err := eng.Switch(ctx, SwitchRequest{Strategy: StrategyBest})
		if err != nil || !res.NoOp || res.Reason != ReasonCurrentUnavailable {
			t.Fatal(res, err)
		}
	})
	t.Run("no-comparison", func(t *testing.T) {
		_, eng, api, clock := threeAccounts(t)
		api.status["at-a"], api.status["at-b"] = 500, 500
		*clock = clock.Add(10 * time.Minute)
		res, err := eng.Switch(ctx, SwitchRequest{Strategy: StrategyBest})
		if err != nil || !res.NoOp || res.Reason != ReasonNoComparison {
			t.Fatal(res, err)
		}
	})
	t.Run("exhausted", func(t *testing.T) {
		_, eng, api, clock := threeAccounts(t)
		for _, k := range []string{"at-a", "at-b", "at-c"} {
			api.usage[k] = `{"five_hour":{"utilization":100}}`
		}
		*clock = clock.Add(10 * time.Minute)
		res, err := eng.Switch(ctx, SwitchRequest{Strategy: StrategyBest})
		if err != nil || !res.NoOp || res.Reason != ReasonExhausted {
			t.Fatal(res, err)
		}
	})
	t.Run("none", func(t *testing.T) {
		e, eng, _, _ := threeAccounts(t)
		dis := true
		_, _ = e.svc.Update("id1", Patch{Disabled: &dis})
		_, _ = e.svc.Update("id2", Patch{Disabled: &dis})
		res, err := eng.Switch(ctx, SwitchRequest{Strategy: StrategyBest})
		if err != nil || !res.NoOp || res.Reason != ReasonNone {
			t.Fatal(res, err)
		}
	})
}

func TestNextAvailableNoCandidate(t *testing.T) {
	_, eng, api, clock := threeAccounts(t)
	api.usage["at-a"] = `{"five_hour":{"utilization":100}}`
	api.usage["at-b"] = `{"five_hour":{"utilization":100}}`
	*clock = clock.Add(10 * time.Minute)
	if _, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyNextAvailable}); !errors.Is(err, ErrNoCandidate) {
		t.Fatalf("%v", err)
	}
}

func TestSmartModelsRule(t *testing.T) {
	// id1 의 Fable 주간 창이 100 이다. models 가 없으면 5시간·주간만 본다.
	setup := func(t *testing.T) (*Engine, *time.Time) {
		_, eng, api, clock := threeAccounts(t)
		api.usage["at-a"] = `{"five_hour":{"utilization":30},"limits":[{"scope":{"model":{"display_name":"Fable"}},"percent":100}]}`
		*clock = clock.Add(10 * time.Minute)
		return eng, clock
	}
	t.Run("none", func(t *testing.T) {
		eng, _ := setup(t)
		res, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyBest})
		if err != nil || res.To != "id1" {
			t.Fatal(res, err)
		}
	})
	t.Run("all", func(t *testing.T) {
		eng, _ := setup(t)
		eng.Models = func() []string { return []string{ModelsAll} }
		res, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyBest})
		if err != nil || res.To != "id2" {
			t.Fatal(res, err)
		}
	})
	t.Run("named", func(t *testing.T) {
		eng, _ := setup(t)
		eng.Models = func() []string { return []string{"Sonnet"} }
		res, err := eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyBest})
		if err != nil || res.To != "id1" {
			t.Fatal(res, err)
		}
		eng.Models = func() []string { return []string{"Fable"} }
		if _, err := eng.Switch(context.Background(), SwitchRequest{ID: "id3"}); err != nil {
			t.Fatal(err)
		}
		res, err = eng.Switch(context.Background(), SwitchRequest{Strategy: StrategyBest})
		if err != nil || res.To != "id2" {
			t.Fatal(res, err)
		}
	})
}
