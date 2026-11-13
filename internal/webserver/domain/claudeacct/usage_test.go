package claudeacct

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TC-CAC-10: 사용량 조회 헤더와 응답 해석.

const usageBody = `{
 "five_hour":{"utilization":34.5,"resets_at":"2026-11-13T12:00:00.5+00:00"},
 "seven_day":{"utilization":21,"resets_at":"2026-11-18T00:00:00Z"},
 "extra_usage":{"is_enabled":true,"used_credits":1240,"monthly_limit":5000,"utilization":24.8,"currency":"USD"},
 "limits":[
   {"scope":{"model":{"display_name":"Opus"}},"percent":40,"resets_at":"2026-11-18T00:00:00Z"},
   {"scope":{"model":{}},"percent":3},
   {"percent":5}
 ]}`

func TestParseUsage(t *testing.T) {
	u, err := ParseUsage([]byte(usageBody))
	if err != nil {
		t.Fatal(err)
	}
	if u.FiveHour == nil || u.FiveHour.Pct != 34.5 || u.FiveHour.ResetsAt != time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC).Unix() {
		t.Fatalf("five %+v", u.FiveHour)
	}
	if u.SevenDay == nil || u.SevenDay.Pct != 21 {
		t.Fatalf("seven %+v", u.SevenDay)
	}
	if len(u.Scoped) != 1 || u.Scoped[0].Name != "Opus" || u.Scoped[0].Pct != 40 {
		t.Fatalf("scoped %+v", u.Scoped)
	}
	if u.Spend == nil || u.Spend.Used != 12.4 || u.Spend.Limit != 50 || u.Spend.Pct != 24.8 || u.Spend.Currency != "USD" {
		t.Fatalf("spend %+v", u.Spend)
	}
}

func TestParseUsageEdges(t *testing.T) {
	u, err := ParseUsage([]byte(`{"five_hour":{"utilization":10},"extra_usage":{"is_enabled":true,"used_credits":null,"monthly_limit":5000,"utilization":1}}`))
	if err != nil || u.FiveHour == nil || u.FiveHour.ResetsAt != 0 || u.Spend != nil || u.SevenDay != nil {
		t.Fatalf("%+v %v", u, err)
	}
	for _, bad := range []string{`<html>`, `[]`, `{}`, `{"five_hour":{"utilization":"x"}}`} {
		if _, err := ParseUsage([]byte(bad)); err == nil {
			t.Fatalf("%q must fail", bad)
		}
	}
}

func TestUsageWindowsAndHeadroom(t *testing.T) {
	u, _ := ParseUsage([]byte(usageBody))
	if h := u.Headroom(nil); h != 100-40 {
		t.Fatalf("headroom over all windows incl. scoped: %v", h)
	}
	if h := u.Headroom(map[string]bool{}); h != 100-34.5 {
		t.Fatalf("no scoped models selected: %v", h)
	}
}

func TestClientUsageHeaders(t *testing.T) {
	var auth, beta, ua, query string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, beta, ua, query = r.Header.Get("Authorization"), r.Header.Get("anthropic-beta"), r.Header.Get("User-Agent"), r.URL.RawQuery
		if r.URL.Path != "/api/oauth/usage" {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write([]byte(usageBody))
	}))
	defer srv.Close()
	c := Client{Base: srv.URL, UserAgent: "dongminal/x"}
	raw, err := c.UsageRaw(context.Background(), "tok", "")
	if err != nil || len(raw) == 0 {
		t.Fatal(err)
	}
	if auth != "Bearer tok" || beta != "oauth-2025-04-20" || ua != "dongminal/x" || query != "" {
		t.Fatalf("%q %q %q %q", auth, beta, ua, query)
	}
}

func TestClientUsage429(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(429)
	}))
	defer srv.Close()
	_, err := Client{Base: srv.URL}.UsageRaw(context.Background(), "tok", "")
	var se *HTTPStatusError
	if !errors.As(err, &se) || se.Status != 429 || se.RetryAfter != "120" {
		t.Fatalf("%v", err)
	}
}
