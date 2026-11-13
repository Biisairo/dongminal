package claudeacct

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// TC-CAC-13·14 (FR-CAC-60a·61·63): 제한 초기화 상태의 해석과 사용 결과의 대응.

func TestParseJuniper(t *testing.T) {
	raw := []byte(`{"five_hour":{"utilization":1},"juniper_tide":{"eligible":true,"ineligible_reason":null,"available":false,"next_available_at":"2027-01-15T08:00:00Z","arm":"reset"}}`)
	j := ParseJuniper(raw)
	if j == nil || !j.Eligible || j.Available {
		t.Fatalf("%+v", j)
	}
	if j.NextAvailableAt != parseResetsAt("2027-01-15T08:00:00Z") || j.NextAvailableAt == 0 {
		t.Fatalf("시각은 unix 초다: %d", j.NextAvailableAt)
	}
	for _, bad := range []string{`{}`, `{"juniper_tide":null}`, `{"juniper_tide":{"available":true}}`, `{"juniper_tide":"x"}`, `not json`} {
		if j := ParseJuniper([]byte(bad)); j != nil {
			t.Errorf("%s → 없음이어야 한다: %+v", bad, j)
		}
	}
	j = ParseJuniper([]byte(`{"juniper_tide":{"eligible":false,"ineligible_reason":"tier"}}`))
	if j == nil || j.Eligible || j.IneligibleReason != "tier" || j.Available {
		t.Fatalf("%+v", j)
	}
}

func TestParseCedar(t *testing.T) {
	raw := []byte(`{"cedar_ember":{"eligible":true,"at_limit":true,"exhausted":["five_hour","bogus"],
	 "weekly_resets_at":"2027-01-20T00:00:00Z","cooldown_until":null,"grants":[
	  {"id":"g_1","label":"Fable reset","resets_total":3,"resets_left":2,"ends_at":"2027-02-01T00:00:00Z",
	   "clears":["five_hour","seven_day","nope"],"usable_now":true,"percent_used":{"five_hour":100,"seven_day":140,"x":3},
	   "blocking":[],"gives_back_weekly":true},
	  {"id":"BAD ID","resets_left":1},
	  {"id":"g_2","resets_left":-1},
	  {"id":"g_3","resets_left":0,"paused":true}]}}`)
	c := ParseCedar(raw)
	if c == nil || !c.Eligible || !c.AtLimit || c.WeeklyResetsAt == 0 || c.CooldownUntil != 0 {
		t.Fatalf("%+v", c)
	}
	if !reflect.DeepEqual(c.Exhausted, []string{"five_hour"}) {
		t.Fatalf("모르는 창은 뺀다: %v", c.Exhausted)
	}
	if len(c.Grants) != 2 || c.Grants[0].ID != "g_1" || c.Grants[1].ID != "g_3" {
		t.Fatalf("형식이 틀린 티켓만 뺀다: %+v", c.Grants)
	}
	g := c.Grants[0]
	if g.Label != "Fable reset" || g.ResetsTotal != 3 || g.ResetsLeft != 2 || g.EndsAt == 0 || !g.UsableNow || !g.GivesBackWeekly {
		t.Fatalf("%+v", g)
	}
	if !reflect.DeepEqual(g.Clears, []string{"five_hour", "seven_day"}) || !reflect.DeepEqual(g.PercentUsed, map[string]int{"five_hour": 100}) {
		t.Fatalf("clears %v percent %v", g.Clears, g.PercentUsed)
	}
	if !g.UseRequiresLimit {
		t.Fatal("use_requires_limit 가 없으면 true 다")
	}
	if !c.Grants[1].Paused {
		t.Fatal("paused")
	}
	for _, bad := range []string{`{}`, `{"cedar_ember":{"grants":[]}}`, `{"cedar_ember":[]}`} {
		if c := ParseCedar([]byte(bad)); c != nil {
			t.Errorf("%s → 없음: %+v", bad, c)
		}
	}
}

func TestClaimResultOf(t *testing.T) {
	cases := []struct {
		name    string
		program string
		body    string
		err     error
		want    ClaimResult
	}{
		{"juniper ok", ProgramJuniper, `{"result":"reset","next_available_at":"2027-01-15T08:00:00Z"}`, nil,
			ClaimResult{Result: "reset", NextAvailableAt: parseResetsAt("2027-01-15T08:00:00Z")}},
		{"cedar ok", ProgramCedar, `{"result":"reset","resets_left":1,"cleared":["five_hour","x"],"weekly_resets_at":"2027-01-20T00:00:00Z"}`, nil,
			ClaimResult{Result: "reset", ResetsLeft: ptr(1), Cleared: []string{"five_hour"}, WeeklyResetsAt: parseResetsAt("2027-01-20T00:00:00Z")}},
		{"cedar cooldown", ProgramCedar, `{"result":"cooldown","reason":"cooldown","cooldown_until":"2027-01-20T00:00:00Z"}`, nil,
			ClaimResult{Result: "cooldown", Reason: "cooldown", CooldownUntil: parseResetsAt("2027-01-20T00:00:00Z")}},
		{"juniper 는 cooldown 을 모른다", ProgramJuniper, `{"result":"cooldown"}`, nil, ClaimResult{Result: "unavailable"}},
		{"모르는 결과", ProgramCedar, `{"result":"whatever"}`, nil, ClaimResult{Result: "unavailable"}},
		{"읽을 수 없는 본문", ProgramCedar, `nope`, nil, ClaimResult{Result: "error"}},
		{"429", ProgramJuniper, ``, &HTTPStatusError{Status: 429}, ClaimResult{Result: "rate_limited"}},
		{"401", ProgramJuniper, ``, &HTTPStatusError{Status: 401}, ClaimResult{Result: "auth_error"}},
		{"403", ProgramCedar, ``, &HTTPStatusError{Status: 403}, ClaimResult{Result: "auth_error"}},
		{"500", ProgramCedar, ``, &HTTPStatusError{Status: 500}, ClaimResult{Result: "error"}},
		{"응답 없음", ProgramCedar, ``, errors.New("timeout"), ClaimResult{Result: "unconfirmed"}},
	}
	for _, c := range cases {
		got := claimResultOf(c.program, []byte(c.body), c.err)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %+v want %+v", c.name, got, c.want)
		}
	}
}

func ptr(n int) *int { return &n }

func TestClientClaimReset(t *testing.T) {
	var got struct{ path, auth, body string }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path, got.auth = r.URL.Path, r.Header.Get("Authorization")
		b := new(strings.Builder)
		buf := make([]byte, 512)
		n, _ := r.Body.Read(buf)
		b.Write(buf[:n])
		got.body = b.String()
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"result":"already_used"}`))
	}))
	defer srv.Close()
	c := Client{Base: srv.URL}
	raw, err := c.ClaimReset(context.Background(), "AT", "org-1", map[string]any{"program": ProgramJuniper})
	var se *HTTPStatusError
	if !errors.As(err, &se) || se.Status != 409 || string(raw) != `{"result":"already_used"}` {
		t.Fatalf("%v %s", err, raw)
	}
	if got.path != "/api/organizations/org-1/reset_rate_limits" || got.auth != "Bearer AT" || got.body != `{"program":"juniper_tide"}` {
		t.Fatalf("%+v", got)
	}
}
