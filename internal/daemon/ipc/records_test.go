package ipc

import (
	"bytes"
	"encoding/json"
	"testing"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-10 — 데몬의 기록 저장소와 push (FR-ARD-10·12).

func recordsPM(t *testing.T, ids ...string) *toolhub.ToolManager {
	t.Helper()
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(func() {
		for _, id := range ids {
			_ = pm.Delete(id)
		}
		pm.StopSaving()
	})
	for _, id := range ids {
		pm.Adopt(toolhub.NewDetachedTool(id, nil))
	}
	return pm
}

// dispatchOne 은 요청 하나를 보내고 응답 줄 하나를 읽는다.
func dispatchOne(t *testing.T, pc *panedConn, buf *bytes.Buffer, method string, params any) map[string]json.RawMessage {
	t.Helper()
	raw, _ := json.Marshal(params)
	buf.Reset()
	pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: method, Params: raw})
	var out map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &out); err != nil {
		t.Fatalf("%s 응답=%q: %v", method, buf.String(), err)
	}
	return out
}

func TestHello_SaysRecords(t *testing.T) {
	if !toolipc.HasFeature(toolipc.DaemonFeatures, toolipc.FeatureRecords) {
		t.Fatal("데몬이 records 기능을 말하지 않는다")
	}
}

func TestRecordSet_ThenRecordsSnapshot(t *testing.T) {
	pm := recordsPM(t, "t1", "t2")
	ps := NewPanedServer(pm, "", "")
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf), records: ps.records}

	agent := toolhub.AgentState{
		Activity:  &toolhub.ActivityState{State: activity.Working, Tool: "Bash", UpdatedAt: 5},
		AgentSeen: true, Attention: true, Turn: toolhub.TurnState{UserTurn: true, InProgress: true},
	}
	agentRaw, _ := json.Marshal(agent)
	for _, p := range []toolipc.RecordSetParams{
		{Kind: toolipc.RecordAgent, Tool: "t1", Value: agentRaw},
		{Kind: toolipc.RecordUsage, Tool: "t1", Value: json.RawMessage(`{"effort":"high"}`)},
		{Kind: toolipc.RecordMigrationTold, Tool: "t1", Value: json.RawMessage(`true`)},
		{Kind: toolipc.RecordMigrationTold, Tool: "t1", Value: json.RawMessage(`null`)},
		{Kind: toolipc.RecordLimits, Value: json.RawMessage(`{"claude":{}}`)},
	} {
		if out := dispatchOne(t, pc, &buf, toolipc.MethodRecordSet, p); out["error"] != nil {
			t.Fatalf("recordset %+v: %s", p, out["error"])
		}
	}
	out := dispatchOne(t, pc, &buf, toolipc.MethodRecords, struct{}{})
	var res toolipc.RecordsResult
	if err := json.Unmarshal(out["result"], &res); err != nil {
		t.Fatalf("records=%s: %v", out["result"], err)
	}
	if string(res.Global[toolipc.RecordLimits]) != `{"claude":{}}` {
		t.Fatalf("global=%v", res.Global)
	}
	byTool := map[string]toolipc.ToolRecords{}
	for _, tr := range res.Tools {
		byTool[tr.Tool] = tr
	}
	if len(byTool) != 2 {
		t.Fatalf("살아 있는 도구 둘을 모두 실어야 한다: %+v", res.Tools)
	}
	t1 := byTool["t1"]
	if t1.Agent.Activity == nil || t1.Agent.Activity.Tool != "Bash" || !t1.Agent.Turn.UserTurn || !t1.Agent.Attention {
		t.Fatalf("t1 agent=%+v", t1.Agent)
	}
	if len(t1.Records) != 1 || string(t1.Records[toolipc.RecordUsage]) != `{"effort":"high"}` {
		t.Fatalf("t1 records=%v", t1.Records)
	}
	if byTool["t2"].Agent.AgentSeen || len(byTool["t2"].Records) != 0 {
		t.Fatalf("t2=%+v", byTool["t2"])
	}

	// FR-ARD-10: 도구가 죽으면 기록도 사라진다.
	if err := pm.Delete("t1"); err != nil {
		t.Fatal(err)
	}
	out = dispatchOne(t, pc, &buf, toolipc.MethodRecords, struct{}{})
	res = toolipc.RecordsResult{}
	_ = json.Unmarshal(out["result"], &res)
	for _, tr := range res.Tools {
		if tr.Tool == "t1" {
			t.Fatalf("죽은 도구의 기록이 남았다: %+v", tr)
		}
	}
}

func TestRecordSet_Rejects(t *testing.T) {
	pm := recordsPM(t, "t1")
	ps := NewPanedServer(pm, "", "")
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf), records: ps.records}
	for name, c := range map[string]struct {
		p    toolipc.RecordSetParams
		code int
	}{
		"없는 도구":       {toolipc.RecordSetParams{Kind: toolipc.RecordUsage, Tool: "nope", Value: json.RawMessage(`{}`)}, toolipc.CodeNotFound},
		"모르는 종류":      {toolipc.RecordSetParams{Kind: "secret", Tool: "t1", Value: json.RawMessage(`{}`)}, toolipc.CodeInvalidParams},
		"도구 없는 도구 기록": {toolipc.RecordSetParams{Kind: toolipc.RecordUsage, Value: json.RawMessage(`{}`)}, toolipc.CodeInvalidParams},
		"도구 붙은 전역 기록": {toolipc.RecordSetParams{Kind: toolipc.RecordLimits, Tool: "t1", Value: json.RawMessage(`{}`)}, toolipc.CodeInvalidParams},
		"깨진 agent":    {toolipc.RecordSetParams{Kind: toolipc.RecordAgent, Tool: "t1", Value: json.RawMessage(`[1]`)}, toolipc.CodeInvalidParams},
	} {
		out := dispatchOne(t, pc, &buf, toolipc.MethodRecordSet, c.p)
		var e toolipc.PanedErrObj
		if err := json.Unmarshal(out["error"], &e); err != nil || e.Code != c.code {
			t.Errorf("%s: 응답=%s, 코드 %d 를 기대", name, buf.String(), c.code)
		}
	}
	if len(pm.Get("t1").Records()) != 0 {
		t.Fatalf("거절한 쓰기가 남았다: %v", pm.Get("t1").Records())
	}
}

// recordset 은 보낸 연결에 되돌려 push 하지 않는다 — 그 값은 보낸 쪽이 이미 안다.
func TestRecordSet_NoEcho(t *testing.T) {
	pm := recordsPM(t, "t1")
	ps := NewPanedServer(pm, "", "")
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf), records: ps.records}
	ps.mu.Lock()
	ps.currConn = pc
	ps.mu.Unlock()
	raw, _ := json.Marshal(toolipc.RecordSetParams{Kind: toolipc.RecordUsage, Tool: "t1", Value: json.RawMessage(`{}`)})
	pc.dispatch(&toolipc.PanedRequest{ID: 9, Method: toolipc.MethodRecordSet, Params: raw})
	if n := bytes.Count(buf.Bytes(), []byte("\n")); n != 1 || bytes.Contains(buf.Bytes(), []byte(`"event"`)) {
		t.Fatalf("응답 하나만 나가야 한다: %s", buf.String())
	}
}
