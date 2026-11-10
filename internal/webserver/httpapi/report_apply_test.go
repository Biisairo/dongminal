package httpapi

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/hub"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-23 — 데몬이 넘긴 보고는 HTTP 처리기와 같은 함수를 지난다 (§3.2a).

func reportServer(t *testing.T, ids ...string) (*Server, *hub.AttnTracker, *fakeCommandBroker) {
	t.Helper()
	m := toolhub.NewToolManager("", nil)
	t.Cleanup(m.StopSaving)
	for _, id := range ids {
		m.Adopt(toolhub.NewDetachedTool(id, nil))
	}
	fb := &fakeCommandBroker{}
	tr := hub.NewAttnTracker(fb, 0)
	return &Server{Deps: Deps{Tools: m, AttnTracker: tr, Commands: fb}, limits: defaultLimits()}, tr, fb
}

func applyReport(t *testing.T, s *Server, method string, body any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	s.ApplyReport(method, raw)
}

func TestApplyReport_ActivityDoneRaisesAlarm(t *testing.T) {
	s, tr, fb := reportServer(t, "t1")
	before := fb.count()
	applyReport(t, s, agentrec.MethodActivity, map[string]any{"toolId": "t1", "agent": "claude", "state": activity.Working, "tool": "Bash", "userPrompt": true})
	applyReport(t, s, agentrec.MethodActivity, map[string]any{"toolId": "t1", "agent": "claude", "state": activity.Done})
	if a := tr.Activity("t1"); a == nil || a.State != activity.Done {
		t.Fatalf("활동 = %+v", a)
	}
	if !tr.Attention("t1") {
		t.Fatal("사용자 턴의 done 이 알람을 세우지 않았다")
	}
	alarmed := false
	for _, p := range fb.sentSince(before) {
		if bytes.Contains(p, []byte(`"action":"tool_attention"`)) {
			alarmed = true
		}
	}
	if !alarmed {
		t.Fatal("알람 방송이 없다")
	}
}

func TestApplyReport_SubagentAndRecords(t *testing.T) {
	s, _, _ := reportServer(t, "t1")
	sink := &fakeRecordSink{}
	s.Records = sink
	applyReport(t, s, agentrec.MethodActivity, map[string]any{"toolId": "t1", "agentId": "a1", "agentType": "Explore", "state": activity.Working})
	applyReport(t, s, agentrec.MethodUsage, map[string]any{"toolId": "t1", "usage": map[string]any{"effort": "high"}})
	applyReport(t, s, agentrec.MethodSubagents, map[string]any{"toolId": "t1", "tasks": []map[string]any{{"id": "a1"}}})
	now := time.Now()
	if acts := s.subActs.list("t1", now); acts["a1"].AgentType != "Explore" {
		t.Fatalf("subActs=%v", acts)
	}
	if u, ok := s.usage.get("t1"); !ok || u.Effort == nil || *u.Effort != "high" || u.ObservedAt == 0 {
		t.Fatalf("usage=%+v", u)
	}
	if tasks, ok := s.subagents.get("t1", now); !ok || len(tasks) != 1 {
		t.Fatalf("subagents=%v", tasks)
	}
	for _, key := range []string{"usage/t1", "subagents/t1", "subagentActs/t1"} {
		if _, ok := sink.value(key); !ok {
			t.Errorf("%s 를 데몬에 되쓰지 않았다", key)
		}
	}
}

func TestApplyReport_Notify(t *testing.T) {
	s, tr, _ := reportServer(t, "t1")
	applyReport(t, s, agentrec.MethodNotify, map[string]any{"toolId": "t1", "reason": "permission"})
	if !tr.Attention("t1") {
		t.Fatal("notify 가 알람을 세우지 않았다")
	}
}

// 깨진 보고·모르는 메서드는 아무것도 바꾸지 않는다. 데몬이 이미 거른 것이지만 서버도 다시 본다.
func TestApplyReport_IgnoresBad(t *testing.T) {
	s, tr, _ := reportServer(t, "t1")
	s.ApplyReport("write", json.RawMessage(`{"toolId":"t1"}`))
	s.ApplyReport(agentrec.MethodActivity, json.RawMessage(`[1]`))
	applyReport(t, s, agentrec.MethodActivity, map[string]any{"toolId": "t1", "state": "nap"})
	applyReport(t, s, agentrec.MethodUsage, map[string]any{"usage": map[string]any{"effort": "x"}})
	if tr.Activity("t1") != nil {
		t.Fatal("깨진 보고가 활동을 바꿨다")
	}
	if _, ok := s.usage.get(""); ok {
		t.Fatal("toolId 없는 사용량이 들어갔다")
	}
}
