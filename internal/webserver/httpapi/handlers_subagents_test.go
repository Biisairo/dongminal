package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/statusline"
	"dongminal/internal/webserver/domain/run"
)

// SUBAGENT_USAGE_SRS — 도구별 서브에이전트 목록 (TC-SAU-5 · 6).

func postSubagents(t *testing.T, s *Server, body string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiToolSubagents(rec, apiTestRequest(http.MethodPost, "/api/tools/subagents", strings.NewReader(body)))
	return rec.Code
}

// 늦게 시작한 것이 앞에 오고, startTime 없는 것이 끼어 있다 — 응답은 startTime 순이고 없는 것은 끝이다.
const subagentsBody = `{"toolId":"p1","tasks":[
{"id":"late","agentType":"Plan","status":"completed","model":"claude-opus-5-5","effortBudget":8000,
 "windowTokens":200000,"tokens":180000,"startTime":2000},
{"id":"nost","status":"running"},
{"id":"early","agentType":"Explore","status":"running","model":"claude-haiku-5-5","effort":"low",
 "windowTokens":1000000,"tokens":19250,"startTime":1000,"description":"secret"}]}`

func activitySubagents(t *testing.T, s *Server) ([]map[string]any, bool) {
	t.Helper()
	a := getActivities(t, s)[0]
	raw, ok := a["subagents"]
	if !ok {
		return nil, false
	}
	blob, _ := json.Marshal(raw)
	var out []map[string]any
	if err := json.Unmarshal(blob, &out); err != nil {
		t.Fatal(err)
	}
	return out, true
}

// TC-SAU-5: 신선한 목록은 startTime 순으로, ctxPct·ctxLevel 을 붙여 나간다 (FR-SAU-10·13·14).
func TestApiToolsActivity_CarriesSubagents(t *testing.T) {
	s := activityUsageServer(t)
	if code := postSubagents(t, s, subagentsBody); code != http.StatusOK {
		t.Fatalf("POST code=%d", code)
	}
	got, ok := activitySubagents(t, s)
	if !ok || len(got) != 3 {
		t.Fatalf("subagents=%v", got)
	}
	if got[0]["id"] != "early" || got[1]["id"] != "late" || got[2]["id"] != "nost" {
		t.Fatalf("순서: %v %v %v", got[0]["id"], got[1]["id"], got[2]["id"])
	}
	e := got[0]
	if e["agentType"] != "Explore" || e["status"] != "running" || e["model"] != "claude-haiku-5-5" ||
		e["effort"] != "low" || e["ctxPct"] != 1.925 || e["ctxLevel"] != run.LevelOK || e["startTime"] != float64(1000) ||
		e["tokens"] != float64(19250) || e["windowTokens"] != float64(1000000) {
		t.Fatalf("early=%v", e)
	}
	if _, ok := e["description"]; ok {
		t.Errorf("허용 목록 밖의 값이 나갔다: %v", e)
	}
	l := got[1]
	if l["effort"] != "8000" || l["ctxPct"] != float64(90) || l["ctxLevel"] != run.LevelCritical {
		t.Fatalf("late=%v (effortBudget 은 글자로, 90%% 는 critical)", l)
	}
	n := got[2]
	if _, ok := n["ctxPct"]; ok {
		t.Errorf("토큰이 없으면 ctxPct 가 없다: %v", n)
	}
	if _, ok := n["ctxLevel"]; ok {
		t.Errorf("ctxPct 가 없으면 ctxLevel 도 없다: %v", n)
	}
}

// TC-SAU-5: 기한이 지나면 없다 (FR-SAU-12).
func TestApiToolsActivity_SubagentsExpire(t *testing.T) {
	s := activityUsageServer(t)
	s.subagents.put("p1", []statusline.Subagent{{ID: strPtr("x")}}, time.Now().Add(-subagentStale-time.Second))
	if got, ok := activitySubagents(t, s); ok {
		t.Fatalf("기한이 지난 목록이 나갔다: %v", got)
	}
	s.subagents.put("p1", []statusline.Subagent{{ID: strPtr("x")}}, time.Now().Add(-subagentStale+time.Second))
	if _, ok := activitySubagents(t, s); !ok {
		t.Fatal("기한 안의 목록이 나가지 않았다")
	}
}

// TC-SAU-5: 빈 목록 보고는 목록을 비운다. 관측이 없으면 키도 없다 (FR-SAU-10·13).
func TestApiToolsActivity_EmptySubagentsNoKey(t *testing.T) {
	s := activityUsageServer(t)
	if _, ok := activitySubagents(t, s); ok {
		t.Fatal("관측이 없는데 subagents 가 실렸다")
	}
	postSubagents(t, s, subagentsBody)
	if code := postSubagents(t, s, `{"toolId":"p1","tasks":[]}`); code != http.StatusOK {
		t.Fatalf("POST code=%d", code)
	}
	if got, ok := activitySubagents(t, s); ok {
		t.Fatalf("빈 목록 보고 뒤에 남았다: %v", got)
	}
}

func TestApiToolSubagents_RejectsMissingTool(t *testing.T) {
	s, _, _ := statusServer(t)
	if code := postSubagents(t, s, `{"tasks":[]}`); code != http.StatusBadRequest {
		t.Fatalf("code=%d", code)
	}
}

// TC-SAU-6: dmctl status 는 허용 목록 항목을 그대로 싣는다 (FR-SAU-15).
func TestApiToolStatus_CarriesSubagents(t *testing.T) {
	s, _, _ := statusServer(t)
	postSubagents(t, s, subagentsBody)
	_, out := getStatus(t, s, "id=p1")
	list, _ := out["subagents"].([]any)
	if len(list) != 3 {
		t.Fatalf("subagents=%v", out["subagents"])
	}
	blob, _ := json.Marshal(list)
	if !strings.Contains(string(blob), `"tokens":19250`) || !strings.Contains(string(blob), `"effortBudget":8000`) {
		t.Errorf("허용 목록 항목 그대로가 아니다: %s", blob)
	}
	if strings.Contains(string(blob), "secret") {
		t.Errorf("허용 목록 밖의 값이 나갔다: %s", blob)
	}
}

// TC-SAU-6: 죽은 도구의 목록은 수거에 지워진다 (FR-SAU-11).
func TestSubagentStore_PruneDropsDeadTools(t *testing.T) {
	var st subagentStore
	now := time.Now()
	st.put("live", nil, now)
	st.put("dead", nil, now)
	if n := st.prune(func(id string) bool { return id == "live" }); n != 1 {
		t.Fatalf("지운 수=%d", n)
	}
	if _, ok := st.get("dead", now); ok {
		t.Fatal("dead 가 남았다")
	}
	if _, ok := st.get("live", now); !ok {
		t.Fatal("live 가 지워졌다")
	}
}

func strPtr(s string) *string { return &s }
