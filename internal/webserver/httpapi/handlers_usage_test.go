package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ISSUE_AGENT_TREE_SRS 묶음 S — 도구별 사용량 관측과 `dmctl status` 의 노출 (TC-SLP-4).

func postUsage(t *testing.T, s *Server, body string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiToolUsage(rec, apiTestRequest(http.MethodPost, "/api/tools/usage", strings.NewReader(body)))
	return rec.Code
}

const usageBody = `{"toolId":"p1","usage":{"sessionId":"s1","version":"2.1.318",
"model":{"id":"claude-opus-5-5","displayName":"Opus 5.5"},"effort":"medium",
"cost":{"totalCostUsd":0.5},
"contextWindow":{"windowTokens":1000000,"usedPct":6,"remainingPct":94,
"currentUsage":{"inputTokens":6,"outputTokens":8,"cacheCreationInputTokens":62146,"cacheReadInputTokens":0}},
"rateLimits":{"fiveHour":{"usedPct":12.5,"resetsAt":1793860000}},
"transcriptPath":"/Users/x/secret.jsonl"}}`

func TestApiToolUsage_StatusCarriesUsageAndContext(t *testing.T) {
	s, _, _ := statusServer(t)
	if code := postUsage(t, s, usageBody); code != http.StatusOK {
		t.Fatalf("POST code=%d", code)
	}
	code, out := getStatus(t, s, "id=p1")
	if code != http.StatusOK {
		t.Fatalf("GET code=%d", code)
	}
	ctx, _ := out["context"].(map[string]any)
	if ctx["usedPct"] != float64(6) || ctx["windowTokens"] != float64(1000000) || ctx["tokens"] != float64(62152) || ctx["source"] != "statusline" {
		t.Fatalf("context=%v", out["context"])
	}
	if ctx["observedAt"] == nil {
		t.Errorf("observedAt 가 없다: %v", ctx)
	}
	u, _ := out["usage"].(map[string]any)
	rl, _ := u["rateLimits"].(map[string]any)
	if u["effort"] != "medium" || rl["fiveHour"] == nil {
		t.Fatalf("usage=%v", out["usage"])
	}
	blob, _ := json.Marshal(out)
	if strings.Contains(string(blob), "secret.jsonl") || strings.Contains(string(blob), "transcriptPath") {
		t.Errorf("허용 목록 밖의 값이 저장됐다 (FR-SLP-2a): %s", blob)
	}
}

func TestApiToolUsage_NoObservationNoKeys(t *testing.T) {
	s, _, _ := statusServer(t)
	_, out := getStatus(t, s, "id=p1")
	if _, ok := out["usage"]; ok {
		t.Errorf("관측이 없는데 usage 가 실렸다: %v", out)
	}
	if _, ok := out["context"]; ok {
		t.Errorf("관측이 없는데 context 가 실렸다: %v", out)
	}
}

func TestApiToolUsage_RejectsMissingTool(t *testing.T) {
	s, _, _ := statusServer(t)
	if code := postUsage(t, s, `{"usage":{"sessionId":"x"}}`); code != http.StatusBadRequest {
		t.Fatalf("toolId 없는 보고 code=%d", code)
	}
}

func TestUsageStore_PruneDropsDeadTools(t *testing.T) {
	var u usageStore
	u.put("live", toolUsage{})
	u.put("dead", toolUsage{})
	if n := u.prune(func(id string) bool { return id == "live" }); n != 1 {
		t.Fatalf("지운 수=%d, 1 이어야 한다", n)
	}
	if _, ok := u.get("live"); !ok {
		t.Errorf("살아 있는 도구의 사용량이 지워졌다")
	}
	if _, ok := u.get("dead"); ok {
		t.Errorf("죽은 도구의 사용량이 남았다")
	}
}

func TestUsageStore_PruneEmpty(t *testing.T) {
	var u usageStore
	if n := u.prune(func(string) bool { return false }); n != 0 {
		t.Fatalf("빈 저장소에서 지운 수=%d", n)
	}
}
