package httpapi

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-34 — 데몬이 판정하면 서버는 보고·해제를 데몬에 넘기고
// 스스로 판정하지 않는다 (§3.3a).

type fakeAttnDaemon struct {
	judges  bool
	err     error
	reports []string
	attends []string
	all     int
}

func (f *fakeAttnDaemon) Judges() bool { return f.judges }

func (f *fakeAttnDaemon) Report(method string, body any) error {
	id := ""
	switch b := body.(type) {
	case agentrec.ActivityReport:
		id = b.ToolID
	case agentrec.NotifyReport:
		id = b.ToolID
	}
	f.reports = append(f.reports, method+"/"+id)
	return f.err
}

func (f *fakeAttnDaemon) Attend(toolID string, typed bool) error {
	if typed {
		toolID += "+typed"
	}
	f.attends = append(f.attends, toolID)
	return f.err
}

func (f *fakeAttnDaemon) AttendAll() (int, error) {
	f.all++
	return 3, f.err
}

func post(t *testing.T, h func(http.ResponseWriter, *http.Request), path, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h(rec, apiTestRequest(http.MethodPost, path, strings.NewReader(body)))
	return rec
}

func TestAttnDaemon_HTTPReportsForwarded(t *testing.T) {
	s, tr, fb := reportServer(t, "t1")
	d := &fakeAttnDaemon{judges: true}
	s.AttnDaemon = d
	before := fb.count()

	if rec := post(t, s.apiToolActivitySet, "/api/tools/activity/set", `{"toolId":"t1","state":"done"}`); rec.Code != http.StatusOK {
		t.Fatalf("activity → %d", rec.Code)
	}
	if rec := post(t, s.apiToolAttentionSet, "/api/tools/attention/set", `{"toolId":"t1","reason":"waiting"}`); rec.Code != http.StatusOK {
		t.Fatalf("notify → %d", rec.Code)
	}
	if len(d.reports) != 2 || d.reports[0] != agentrec.MethodActivity+"/t1" || d.reports[1] != agentrec.MethodNotify+"/t1" {
		t.Fatalf("넘긴 보고=%v", d.reports)
	}
	if tr.Activity("t1") != nil || tr.Attention("t1") || fb.count() != before {
		t.Fatal("서버가 스스로 판정했다")
	}
	// 틀린 보고는 넘기지 않고 종전처럼 400 이다.
	if rec := post(t, s.apiToolActivitySet, "/api/tools/activity/set", `{"toolId":"t1","state":"nap"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("틀린 상태 → %d", rec.Code)
	}
	if len(d.reports) != 2 {
		t.Fatalf("틀린 보고를 넘겼다: %v", d.reports)
	}
}

func TestAttnDaemon_ForwardErrors(t *testing.T) {
	s, _, _ := reportServer(t, "t1")
	d := &fakeAttnDaemon{judges: true, err: &toolipc.RPCError{Code: toolipc.CodeNotFound, Message: "nope"}}
	s.AttnDaemon = d
	if rec := post(t, s.apiToolAttentionSet, "/api/tools/attention/set", `{"toolId":"nope"}`); rec.Code != http.StatusOK {
		t.Fatalf("없는 도구 → %d, want 200 (종전의 무동작)", rec.Code)
	}
	d.err = errors.New("연결 끊김")
	if rec := post(t, s.apiToolAttentionSet, "/api/tools/attention/set", `{"toolId":"t1"}`); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("연결 오류 → %d, want 503", rec.Code)
	}
}

// 데몬이 넘긴 보고(report push)는 이미 판정된 것이다 — 서버는 판정하지 않고 나머지만 한다.
func TestAttnDaemon_ReportPushNotJudged(t *testing.T) {
	s, tr, fb := reportServer(t, "t1")
	s.AttnDaemon = &fakeAttnDaemon{judges: true}
	before := fb.count()
	applyReport(t, s, agentrec.MethodActivity, map[string]any{"toolId": "t1", "agent": "claude", "state": activity.Working})
	applyReport(t, s, agentrec.MethodActivity, map[string]any{"toolId": "t1", "agent": "claude", "state": activity.Done})
	applyReport(t, s, agentrec.MethodNotify, map[string]any{"toolId": "t1"})
	if tr.Activity("t1") != nil || tr.Attention("t1") {
		t.Fatal("report push 로 서버가 판정했다")
	}
	for _, p := range fb.sentSince(before) {
		if bytes.Contains(p, []byte(`"action":"tool_attention"`)) {
			t.Fatal("서버가 알람을 방송했다 — 방송은 데몬의 attn push 몫이다")
		}
	}
	applyReport(t, s, agentrec.MethodActivity, map[string]any{"toolId": "t1", "agentId": "a1", "agentType": "Explore", "state": activity.Working})
	if acts := s.subActs.list("t1", time.Now()); acts["a1"].AgentType != "Explore" {
		t.Fatalf("서브에이전트 활동은 서버가 그대로 맡는다: %v", acts)
	}
}

func TestAttnDaemon_ClearGoesToDaemon(t *testing.T) {
	s, tr, _ := reportServer(t, "t1")
	tr.SignalAttention("t1", "signaled")
	d := &fakeAttnDaemon{judges: true}
	s.AttnDaemon = d
	post(t, s.apiToolAttentionClear, "/api/tools/attention/clear", `{"toolId":"t1","typed":true}`)
	rec := post(t, s.apiToolAttentionClearAll, "/api/tools/attention/clear-all", ``)
	if len(d.attends) != 1 || d.attends[0] != "t1+typed" || d.all != 1 {
		t.Fatalf("attends=%v all=%d", d.attends, d.all)
	}
	if !strings.Contains(rec.Body.String(), `"cleared":3`) {
		t.Fatalf("clear-all 응답=%s", rec.Body.String())
	}
	if !tr.Attention("t1") {
		t.Fatal("서버가 스스로 해제했다 — 해제는 데몬의 attn push 로 온다")
	}
}

// 옛 데몬이면 종전 그대로 서버가 판정한다.
func TestAttnDaemon_OldDaemonUnchanged(t *testing.T) {
	s, tr, _ := reportServer(t, "t1")
	d := &fakeAttnDaemon{judges: false}
	s.AttnDaemon = d
	post(t, s.apiToolAttentionSet, "/api/tools/attention/set", `{"toolId":"t1"}`)
	post(t, s.apiToolAttentionClear, "/api/tools/attention/clear", `{"toolId":"t1"}`)
	if len(d.reports) != 0 || len(d.attends) != 0 {
		t.Fatalf("옛 데몬에 보냈다: %v %v", d.reports, d.attends)
	}
	if tr.Attention("t1") || !tr.AgentStateOf("t1").RearmLocked {
		t.Fatal("서버가 종전처럼 판정·해제하지 않았다")
	}
}
