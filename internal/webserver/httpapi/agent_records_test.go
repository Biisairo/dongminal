package httpapi

import (
	"bytes"
	"encoding/json"
	"strconv"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/hub"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-11·12(서버 몫) — 기록을 바꾸는 쓰기는 데몬으로 가고,
// 스냅샷은 거울을 통째로 바꾼다.

type fakeRecordSink struct {
	mu  sync.Mutex
	got map[string]json.RawMessage
}

func (f *fakeRecordSink) Put(kind, tool string, v any) {
	raw, _ := json.Marshal(v)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.got == nil {
		f.got = map[string]json.RawMessage{}
	}
	f.got[kind+"/"+tool] = raw
}

func (f *fakeRecordSink) value(key string) (json.RawMessage, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.got[key]
	return v, ok
}

func TestRecords_WritesGoToDaemon(t *testing.T) {
	s := activityUsageServer(t)
	sink := &fakeRecordSink{}
	s.Records = sink

	postUsage(t, s, `{"toolId":"p1","usage":{"effort":"high","rateLimits":{"five_hour":{"usedPct":34}}}}`)
	postSubagents(t, s, `{"toolId":"p1","tasks":[{"id":"a1","status":"running"}]}`)
	postActivitySet(t, s, map[string]any{"toolId": "p1", "agentId": "a1", "agentType": "Explore", "state": "working", "tool": "Read"})
	s.migrationVerdict("p9", migrationConf{HookOn: true, HookPct: 50}, map[string]any{})

	for key, want := range map[string]string{
		"usage/p1":         `"effort":"high"`,
		"limits/":          `"five_hour"`,
		"subagents/p1":     `"id":"a1"`,
		"subagentActs/p1":  `"agentType":"Explore"`,
		"migrationTold/p9": `true`,
	} {
		v, ok := sink.value(key)
		if !ok || !bytes.Contains(v, []byte(want)) {
			t.Errorf("%s=%s, %s 를 기대", key, v, want)
		}
	}

	// main 이 끝나면 서브에이전트 활동이 지워진다 — 데몬의 기록도 지운다.
	postActivitySet(t, s, map[string]any{"toolId": "p1", "state": "ended"})
	if v, _ := sink.value("subagentActs/p1"); string(v) != "null" {
		t.Fatalf("ended 뒤 subagentActs=%s", v)
	}
}

// TC-ARD-12: 데몬이 records 를 말하지 않으면 쓰기 자리는 비어 있고, 동작은 종전 그대로다.
func TestRecords_NoSinkStillMirrors(t *testing.T) {
	s := activityUsageServer(t)
	postUsage(t, s, `{"toolId":"p1","usage":{"effort":"high"}}`)
	if u, ok := s.usage.get("p1"); !ok || u.Effort == nil || *u.Effort != "high" {
		t.Fatalf("거울에 반영되지 않았다: %+v", u)
	}
}

func TestRecords_ApplySnapshotReplacesMirror(t *testing.T) {
	fb := &fakeCommandBroker{}
	tr := hub.NewAttnTracker(fb, 0)
	s := &Server{Deps: Deps{AttnTracker: tr, Commands: fb}, limits: defaultLimits()}
	// 스냅샷 전 거울: 낡은 값과 스냅샷에 없는 도구.
	s.usage.put("old", toolUsage{})
	s.subagents.put("old", nil, time.Now())
	s.migrationUnknownTold.Store("old", true)
	tr.SetActivity("old", activity.Working, "", "")
	before := fb.count()

	now := time.Now()
	subAct, _ := json.Marshal(map[string]subagentActivity{"a1": {AgentType: "Explore", State: activity.Working, UpdatedAt: now}})
	res := toolipc.RecordsResult{
		Global: map[string]json.RawMessage{toolipc.RecordLimits: json.RawMessage(
			`{"claude":{"windows":{"five_hour":{"usedPct":12}},"observedAt":` + ms(now) + `}}`)},
		Tools: []toolipc.ToolRecords{{
			Tool:  "t1",
			Agent: toolhub.AgentState{Activity: &toolhub.ActivityState{State: activity.Waiting}, AgentSeen: true, Attention: true},
			Records: map[string]json.RawMessage{
				toolipc.RecordUsage:         json.RawMessage(`{"effort":"low","observedAt":5}`),
				toolipc.RecordSubagents:     json.RawMessage(`{"tasks":[{"id":"a1"}],"observedAt":` + ms(now) + `}`),
				toolipc.RecordSubagentActs:  subAct,
				toolipc.RecordMigrationTold: json.RawMessage(`true`),
			},
		}},
	}
	s.ApplyRecords(res)

	if _, ok := s.usage.get("old"); ok {
		t.Error("스냅샷에 없는 사용량이 남았다")
	}
	if u, ok := s.usage.get("t1"); !ok || *u.Effort != "low" || u.ObservedAt != 5 {
		t.Errorf("usage=%+v", u)
	}
	if tasks, ok := s.subagents.get("t1", now); !ok || len(tasks) != 1 {
		t.Errorf("subagents=%v", tasks)
	}
	if acts := s.subActs.list("t1", now); acts["a1"].AgentType != "Explore" {
		t.Errorf("subActs=%v", acts)
	}
	if _, told := s.migrationUnknownTold.Load("old"); told {
		t.Error("스냅샷에 없는 안내 표시가 남았다")
	}
	if _, told := s.migrationUnknownTold.Load("t1"); !told {
		t.Error("안내 표시가 반영되지 않았다")
	}
	if v := s.rateLimits.view(now); len(v) != 1 || v[0].Windows[0].Name != "five_hour" {
		t.Errorf("limits=%+v", v)
	}
	if !tr.Attention("t1") || tr.Activity("old") != nil {
		t.Errorf("추적기가 반영되지 않았다")
	}
	for _, p := range fb.sentSince(before) {
		if bytes.Contains(p, []byte(`"action":"tool_attention"`)) {
			t.Fatalf("스냅샷 반영이 알람을 방송했다: %s", p)
		}
	}
}

func (f *fakeCommandBroker) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.published)
}

func (f *fakeCommandBroker) sentSince(n int) [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte(nil), f.published[n:]...)
}

func ms(t time.Time) string { return strconv.FormatInt(t.UnixMilli(), 10) }
