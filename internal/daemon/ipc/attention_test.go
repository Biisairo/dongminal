package ipc

import (
	"bytes"
	"encoding/json"
	"testing"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-31 — 데몬의 알람 판정과 그 push·메서드 (§3.3a).

var oscSignal = []byte("\x1b]9;hi\x07")

// attnServer 는 알림이 실린 도구 ids 를 가진 데몬과, 그 서버 연결(attention 을 말함)이다.
func attnServer(t *testing.T, attention bool, ids ...string) (*PanedServer, *panedConn, *bytes.Buffer) {
	t.Helper()
	t.Setenv(dmenv.EnvAttentionBell, "")
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	ps := NewPanedServer(pm, "", "")
	t.Cleanup(func() {
		for _, id := range ids {
			_ = pm.Delete(id)
		}
		pm.StopSaving()
	})
	for _, id := range ids {
		pm.AdoptDetached(id)
	}
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf), records: ps.records, srv: ps}
	pc.reports.Store(true)
	pc.attention.Store(attention)
	ps.mu.Lock()
	ps.currConn = pc
	ps.mu.Unlock()
	return ps, pc, &buf
}

// lines 는 buf 의 줄들을 읽고 비운다.
func lines(t *testing.T, buf *bytes.Buffer) []map[string]json.RawMessage {
	t.Helper()
	var out []map[string]json.RawMessage
	for _, l := range bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n")) {
		if len(l) == 0 {
			continue
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(l, &m); err != nil {
			t.Fatalf("줄=%q: %v", l, err)
		}
		out = append(out, m)
	}
	buf.Reset()
	return out
}

func attnEvents(t *testing.T, buf *bytes.Buffer) []toolipc.AttnEvent {
	t.Helper()
	var out []toolipc.AttnEvent
	for _, m := range lines(t, buf) {
		if string(m["event"]) != `"`+toolipc.EventAttn+`"` {
			continue
		}
		raw, _ := json.Marshal(m)
		var ev toolipc.AttnEvent
		if err := json.Unmarshal(raw, &ev); err != nil {
			t.Fatal(err)
		}
		out = append(out, ev)
	}
	return out
}

func call(t *testing.T, pc *panedConn, buf *bytes.Buffer, method string, params any) map[string]json.RawMessage {
	t.Helper()
	raw, _ := json.Marshal(params)
	pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: method, Params: raw})
	for _, m := range lines(t, buf) {
		if _, ok := m["id"]; ok {
			return m
		}
	}
	t.Fatalf("%s 응답이 없다", method)
	return nil
}

func TestFeatures_SayAttention(t *testing.T) {
	if !toolipc.HasFeature(toolipc.DaemonFeatures, toolipc.FeatureAttention) || !toolipc.HasFeature(toolipc.ServerFeatures, toolipc.FeatureAttention) {
		t.Fatal("데몬과 서버가 attention 을 함께 말해야 한다")
	}
}

// 판정 결과는 attention 을 말한 서버에만 push 한다. 판정 자체는 언제나 한다.
func TestAttnPush_OnlyToAttentionServer(t *testing.T) {
	ps, _, buf := attnServer(t, false, "t1")
	p := ps.pm.Get("t1")
	p.ObserveOutput(oscSignal)
	if !p.Attention() {
		t.Fatal("데몬이 판정하지 않았다")
	}
	if evs := attnEvents(t, buf); len(evs) != 0 {
		t.Fatalf("attention 을 모르는 서버에 push 했다: %+v", evs)
	}

	ps, _, buf = attnServer(t, true, "t2")
	p = ps.pm.Get("t2")
	p.ObserveOutput(oscSignal)
	p.Attend()
	p.ReportActivity(activity.Working, "Bash", "ls", true)
	evs := attnEvents(t, buf)
	if len(evs) != 3 {
		t.Fatalf("push=%+v", evs)
	}
	if e := evs[0]; e.Tool != "t2" || e.Kind != toolipc.AttnKindAttention || e.Reason != "signaled" || !e.Agent.Attention {
		t.Fatalf("알람 push=%+v", e)
	}
	if e := evs[1]; e.Kind != toolipc.AttnKindClear || e.Agent.Attention || !e.Agent.RearmLocked {
		t.Fatalf("해제 push=%+v", e)
	}
	if e := evs[2]; e.Kind != toolipc.AttnKindActivity || e.Agent.Activity == nil || e.Agent.Activity.Tool != "Bash" {
		t.Fatalf("활동 push=%+v", e)
	}
}

// 서버가 없어도 판정은 하고 상태만 바뀐다 (FR-ARD-25).
func TestAttn_NoServerStillJudges(t *testing.T) {
	ps, _, _ := attnServer(t, true, "t1")
	ps.mu.Lock()
	ps.currConn = nil
	ps.mu.Unlock()
	p := ps.pm.Get("t1")
	p.ObserveOutput(oscSignal)
	if !p.Attention() {
		t.Fatal("서버가 없을 때 판정하지 않았다")
	}
}

func TestAttend_Methods(t *testing.T) {
	ps, pc, buf := attnServer(t, true, "t1", "t2")
	p1, p2 := ps.pm.Get("t1"), ps.pm.Get("t2")
	p1.ObserveOutput(oscSignal)
	buf.Reset()

	if r := call(t, pc, buf, toolipc.MethodAttend, toolipc.AttendParams{Tool: "t1"}); r["error"] != nil {
		t.Fatalf("attend: %s", r["error"])
	}
	if st := p1.AgentState(); st.Attention || !st.RearmLocked {
		t.Fatalf("보기만 한 해제=%+v", st)
	}
	if r := call(t, pc, buf, toolipc.MethodAttend, toolipc.AttendParams{Tool: "t1", Typed: true}); r["error"] != nil {
		t.Fatalf("attend typed: %s", r["error"])
	}
	if st := p1.AgentState(); st.RearmLocked {
		t.Fatalf("키를 누른 해제가 잠금을 풀지 않았다: %+v", st)
	}
	// 없는 도구는 종전 HTTP 처럼 무동작이다.
	if r := call(t, pc, buf, toolipc.MethodAttend, toolipc.AttendParams{Tool: "nope"}); r["error"] != nil {
		t.Fatalf("없는 도구: %s", r["error"])
	}

	p1.ObserveOutput(oscSignal)
	p2.ObserveOutput(oscSignal)
	r := call(t, pc, buf, toolipc.MethodAttendAll, struct{}{})
	var res toolipc.AttendAllResult
	if err := json.Unmarshal(r["result"], &res); err != nil || res.Cleared != 2 {
		t.Fatalf("attendall=%s err=%v", r["result"], err)
	}
	if p1.Attention() || p2.Attention() {
		t.Fatal("전부 해제가 남겼다")
	}
}

func TestAttnConfig_AppliesToTools(t *testing.T) {
	ps, pc, buf := attnServer(t, true, "t1")
	p := ps.pm.Get("t1")
	p.ObserveOutput([]byte{0x07})
	if p.Attention() {
		t.Fatal("BEL 허용 전에 울었다")
	}
	if r := call(t, pc, buf, toolipc.MethodAttnConfig, toolipc.AttnConfigParams{IdleMS: 1000, AllowBell: true}); r["error"] != nil {
		t.Fatalf("attnconfig: %s", r["error"])
	}
	p.ObserveOutput([]byte{0x07})
	if !p.Attention() {
		t.Fatal("attnconfig 의 BEL 허용이 도구에 닿지 않았다")
	}
}

// 서버 HTTP 로 온 보고는 report 로 넘어와 보고 소켓과 같은 길을 탄다 — 판정 push 가 먼저,
// report push 가 뒤다.
func TestReportMethod_JudgesThenPushesReport(t *testing.T) {
	ps, pc, buf := attnServer(t, true, "t1")
	body, _ := json.Marshal(agentrec.NotifyReport{ToolID: "t1"})
	raw, _ := json.Marshal(toolipc.ReportParams{Method: agentrec.MethodNotify, Body: body})
	pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: toolipc.MethodReport, Params: raw})
	var order []string
	for _, m := range lines(t, buf) {
		if _, ok := m["id"]; ok {
			if m["error"] != nil {
				t.Fatalf("report: %s", m["error"])
			}
			continue
		}
		var ev string
		_ = json.Unmarshal(m["event"], &ev)
		order = append(order, ev)
	}
	if len(order) != 2 || order[0] != toolipc.EventAttn || order[1] != toolipc.EventReport {
		t.Fatalf("push 순서=%v", order)
	}
	if !ps.pm.Get("t1").Attention() {
		t.Fatal("보고가 데몬 판정에 닿지 않았다")
	}

	r := call(t, pc, buf, toolipc.MethodReport, toolipc.ReportParams{Method: agentrec.MethodNotify, Body: json.RawMessage(`{"toolId":"nope"}`)})
	var e toolipc.PanedErrObj
	if err := json.Unmarshal(r["error"], &e); err != nil || e.Code != toolipc.CodeNotFound {
		t.Fatalf("없는 도구=%s", r["error"])
	}
	r = call(t, pc, buf, toolipc.MethodReport, toolipc.ReportParams{Method: "write", Body: json.RawMessage(`{}`)})
	if r["error"] == nil {
		t.Fatal("넷이 아닌 메서드를 받았다")
	}
}
