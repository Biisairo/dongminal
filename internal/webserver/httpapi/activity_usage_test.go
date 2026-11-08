package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"testing"

	"dongminal/internal/shared/statusline"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/domain/run"
)

// ACTIVITY_CARD_USAGE_SRS — 활동 목록 항목의 사용량 요약 (TC-ACU-1~5).

func activityUsageServer(t *testing.T) *Server {
	t.Helper()
	t.Cleanup(toolhub.SetAttnBusyProbe(func(*toolhub.Tool) bool { return true }))
	s, _, p := statusServer(t)
	p.SetActivity("working", "Edit", "app.js")
	return s
}

func getActivities(t *testing.T, s *Server) []map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiToolsActivity(rec, apiTestRequest(http.MethodGet, "/api/tools/activity", nil))
	var out struct {
		Activities []map[string]any `json:"activities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Activities) != 1 {
		t.Fatalf("항목 수=%d: %v", len(out.Activities), out.Activities)
	}
	return out.Activities
}

// TC-ACU-1: 사용량 요약은 네 필드만 싣고, 기존 필드는 그대로다 (FR-ACU-1·2·5).
func TestApiToolsActivity_CarriesUsageSummary(t *testing.T) {
	s := activityUsageServer(t)
	if code := postUsage(t, s, usageBody); code != http.StatusOK {
		t.Fatalf("POST code=%d", code)
	}
	a := getActivities(t, s)[0]
	if a["toolId"] != "p1" || a["state"] != "working" || a["tool"] != "Edit" || a["detail"] != "app.js" {
		t.Fatalf("기존 필드가 바뀌었다: %v", a)
	}
	u, ok := a["usage"].(map[string]any)
	if !ok {
		t.Fatalf("usage 가 없다: %v", a)
	}
	keys := make([]string, 0, len(u))
	for k := range u {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if got, want := keys, []string{"ctxLevel", "ctxPct", "effort", "model"}; !equalStrings(got, want) {
		t.Fatalf("usage 키=%v, want %v", got, want)
	}
	if u["ctxPct"] != float64(6) || u["ctxLevel"] != run.LevelOK || u["model"] != "Opus 5.5" || u["effort"] != "medium" {
		t.Fatalf("usage=%v", u)
	}
}

// TC-ACU-2: 관측이 없으면 usage 키가 없다 (FR-ACU-1·4).
func TestApiToolsActivity_NoUsageNoKey(t *testing.T) {
	s := activityUsageServer(t)
	a := getActivities(t, s)[0]
	if _, ok := a["usage"]; ok {
		t.Fatalf("관측이 없는데 usage 가 실렸다: %v", a)
	}
	if a["state"] != "working" {
		t.Fatalf("기존 필드가 바뀌었다: %v", a)
	}
}

// TC-ACU-3: 등급 경계는 기본 정책(0.70·0.85)이다 (FR-ACU-3).
func TestCardUsageOf_LevelBoundaries(t *testing.T) {
	p := run.DefaultContextPolicy()
	for _, tc := range []struct {
		pct  float64
		want string
	}{{69.9, run.LevelOK}, {70, run.LevelWarn}, {84.9, run.LevelWarn}, {85, run.LevelCritical}, {100, run.LevelCritical}} {
		pct := tc.pct
		got := cardUsageOf(&toolContext{UsedPct: &pct}, nil, p)
		if got == nil || got.CtxLevel != tc.want {
			t.Errorf("pct=%v level=%+v, want %s", tc.pct, got, tc.want)
		}
	}
}

// TC-ACU-4: 등급 경계는 설정에서 온다 (FR-ACU-3, D-ACU-2).
func TestApiToolsActivity_LevelFollowsSettings(t *testing.T) {
	s := activityUsageServer(t)
	st := newSettingsStore(filepath.Join(t.TempDir(), "settings.json"))
	st.Set([]byte(`{"orchestration":{"contextWarnRatio":0.5,"contextCriticalRatio":0.6}}`))
	s.Settings = st
	for _, tc := range []struct {
		body, want string
	}{
		{`{"toolId":"p1","usage":{"contextWindow":{"usedPct":55}}}`, run.LevelWarn},
		{`{"toolId":"p1","usage":{"contextWindow":{"usedPct":60}}}`, run.LevelCritical},
	} {
		if code := postUsage(t, s, tc.body); code != http.StatusOK {
			t.Fatalf("POST code=%d", code)
		}
		u, _ := getActivities(t, s)[0]["usage"].(map[string]any)
		if u["ctxLevel"] != tc.want {
			t.Errorf("%s → usage=%v, want %s", tc.body, u, tc.want)
		}
	}
}

// TC-ACU-5: 모델 이름이 없으면 id 를 쓰고, transcript 출처는 맥락만 준다 (FR-ACU-2).
func TestCardUsageOf_Fallbacks(t *testing.T) {
	p := run.DefaultContextPolicy()
	id := "claude-opus-5-5"
	got := cardUsageOf(nil, &toolUsage{Usage: statusline.Usage{Model: &statusline.Model{ID: &id}}}, p)
	if got == nil || got.Model != id || got.CtxPct != nil || got.CtxLevel != "" || got.Effort != "" {
		t.Fatalf("id 대체: %+v", got)
	}

	pct := 42.0
	got = cardUsageOf(&toolContext{UsedPct: &pct, Source: contextSourceTranscript}, nil, p)
	if got == nil || got.CtxPct == nil || *got.CtxPct != 42 || got.CtxLevel != run.LevelOK || got.Model != "" || got.Effort != "" {
		t.Fatalf("transcript 출처: %+v", got)
	}

	if got := cardUsageOf(nil, &toolUsage{}, p); got != nil {
		t.Fatalf("필드가 하나도 없으면 nil 이어야 한다 (FR-ACU-4): %+v", got)
	}
	if got := cardUsageOf(nil, nil, p); got != nil {
		t.Fatalf("관측이 없으면 nil 이어야 한다: %+v", got)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
