package ipc

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-20·22·24 — 데몬의 보고 소켓 (FR-ARD-20~22·25, §3.2a).

func reportReq(t *testing.T, method string, body any) agentrec.Request {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return agentrec.Request{Method: method, Body: raw}
}

// attachServer 는 currConn 을 가짜 서버 연결로 세운다. reports 는 그 서버가 hello 에서
// reports 기능을 말했는가다.
func attachServer(ps *PanedServer, reports bool) *bytes.Buffer {
	var buf bytes.Buffer
	pc := &panedConn{pm: ps.pm, encoder: json.NewEncoder(&buf), records: ps.records}
	pc.reports.Store(reports)
	ps.mu.Lock()
	ps.currConn = pc
	ps.mu.Unlock()
	return &buf
}

func TestReport_RejectsUnknownMethodAndTool(t *testing.T) {
	pm := recordsPM(t, "t1")
	ps := NewPanedServer(pm, "", "")
	for name, req := range map[string]agentrec.Request{
		"넷이 아닌 메서드": reportReq(t, "write", map[string]any{"toolId": "t1"}),
		"recordset": reportReq(t, toolipc.MethodRecordSet, map[string]any{"toolId": "t1"}),
		"없는 도구":     reportReq(t, agentrec.MethodNotify, map[string]any{"toolId": "nope"}),
		"빈 toolId":  reportReq(t, agentrec.MethodNotify, map[string]any{}),
		"깨진 본문":     {Method: agentrec.MethodActivity, Body: json.RawMessage(`[1]`)},
		"틀린 상태":     reportReq(t, agentrec.MethodActivity, map[string]any{"toolId": "t1", "state": "nap"}),
		"틀린 하위 상태":  reportReq(t, agentrec.MethodActivity, map[string]any{"toolId": "t1", "state": "idle", "agentId": "a1"}),
	} {
		if r := ps.handleReport(req); r.OK || r.Error == "" {
			t.Errorf("%s: 받았다 %+v", name, r)
		}
	}
	p := pm.Get("t1")
	if p.Activity() != nil || p.Attention() || len(p.Records()) != 0 {
		t.Fatalf("거절한 보고가 남았다: act=%v attn=%v rec=%v", p.Activity(), p.Attention(), p.Records())
	}
}

// FR-ARD-25 · TC-ARD-22: 서버 없이 받은 보고가 스냅샷에 실린다.
func TestReport_NoServer_RecordsIntoSnapshot(t *testing.T) {
	pm := recordsPM(t, "t1")
	ps := NewPanedServer(pm, "", "")
	agent, ok := agentadapter.StatusLineReporter()
	if !ok {
		t.Skip("statusLine 보고 에이전트가 없다")
	}
	pct := 30.0
	reqs := []agentrec.Request{
		reportReq(t, agentrec.MethodActivity, map[string]any{"toolId": "t1", "state": activity.Working, "tool": "Bash\x07"}),
		reportReq(t, agentrec.MethodActivity, map[string]any{"toolId": "t1", "state": activity.Done}),
		reportReq(t, agentrec.MethodActivity, map[string]any{"toolId": "t1", "state": activity.Working, "agentId": "a1", "agentType": "Explore"}),
		reportReq(t, agentrec.MethodUsage, map[string]any{"toolId": "t1", "usage": map[string]any{"effort": "high",
			"rateLimits": map[string]any{"five_hour": map[string]any{"usedPct": pct}}}}),
		reportReq(t, agentrec.MethodSubagents, map[string]any{"toolId": "t1", "tasks": []map[string]any{{"id": "a1"}}}),
	}
	for _, req := range reqs {
		if r := ps.handleReport(req); !r.OK {
			t.Fatalf("%s 거절: %s", req.Method, r.Error)
		}
	}
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf), records: ps.records}
	out := dispatchOne(t, pc, &buf, toolipc.MethodRecords, struct{}{})
	var res toolipc.RecordsResult
	if err := json.Unmarshal(out["result"], &res); err != nil || len(res.Tools) != 1 {
		t.Fatalf("records=%s: %v", out["result"], err)
	}
	tr := res.Tools[0]
	if tr.Agent.Activity == nil || tr.Agent.Activity.State != activity.Done || !tr.Agent.AgentSeen || !tr.Agent.Attention {
		t.Fatalf("agent=%+v (사용자 턴의 done 은 상태를 알람으로 둔다)", tr.Agent)
	}
	var u agentrec.Usage
	if err := json.Unmarshal(tr.Records[toolipc.RecordUsage], &u); err != nil || u.Effort == nil || *u.Effort != "high" || u.ObservedAt == 0 {
		t.Fatalf("usage=%s", tr.Records[toolipc.RecordUsage])
	}
	var subs agentrec.SubagentList
	if err := json.Unmarshal(tr.Records[toolipc.RecordSubagents], &subs); err != nil || len(subs.Tasks) != 1 || subs.ObservedAt == 0 {
		t.Fatalf("subagents=%s", tr.Records[toolipc.RecordSubagents])
	}
	var acts map[string]agentrec.SubagentActivity
	if err := json.Unmarshal(tr.Records[toolipc.RecordSubagentActs], &acts); err != nil || acts["a1"].AgentType != "Explore" {
		t.Fatalf("subagentActs=%s", tr.Records[toolipc.RecordSubagentActs])
	}
	var limits map[string]agentrec.LimitRecord
	if err := json.Unmarshal(res.Global[toolipc.RecordLimits], &limits); err != nil || limits[agent].Windows["five_hour"].UsedPct == nil {
		t.Fatalf("limits=%s", res.Global[toolipc.RecordLimits])
	}
	if len(buf.Bytes()) == 0 {
		t.Fatal("records 응답이 없다")
	}

	// ended 는 카드와 서브에이전트 활동을 함께 거둔다 (FR-ASV-12).
	if r := ps.handleReport(reportReq(t, agentrec.MethodActivity, map[string]any{"toolId": "t1", "state": activity.Ended})); !r.OK {
		t.Fatal(r.Error)
	}
	p := pm.Get("t1")
	if p.Activity() != nil {
		t.Fatal("ended 뒤 카드가 남았다")
	}
	if _, ok := p.Records()[toolipc.RecordSubagentActs]; ok {
		t.Fatal("ended 뒤 서브에이전트 활동이 남았다")
	}
}

func TestReport_Notify_SetsAttentionOnly(t *testing.T) {
	pm := recordsPM(t, "t1")
	ps := NewPanedServer(pm, "", "")
	if r := ps.handleReport(reportReq(t, agentrec.MethodNotify, map[string]any{"toolId": "t1", "reason": "permission"})); !r.OK {
		t.Fatal(r.Error)
	}
	if !pm.Get("t1").Attention() {
		t.Fatal("notify 가 알람 상태를 세우지 않았다")
	}
}

// §3.2a: 붙은 서버에는 기록이 아니라 보고 자체를 push 한다.
func TestReport_WithServer_PushesReport(t *testing.T) {
	pm := recordsPM(t, "t1")
	ps := NewPanedServer(pm, "", "")
	buf := attachServer(ps, true)
	body := map[string]any{"toolId": "t1", "state": activity.Working}
	if r := ps.handleReport(reportReq(t, agentrec.MethodActivity, body)); !r.OK {
		t.Fatal(r.Error)
	}
	var ev toolipc.ReportEvent
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &ev); err != nil {
		t.Fatalf("push=%q: %v", buf.String(), err)
	}
	if ev.Event != toolipc.EventReport || ev.Method != agentrec.MethodActivity {
		t.Fatalf("push=%+v", ev)
	}
	var got map[string]any
	if json.Unmarshal(ev.Body, &got) != nil || got["toolId"] != "t1" || got["state"] != activity.Working {
		t.Fatalf("body=%s", ev.Body)
	}
	if bytes.Count(buf.Bytes(), []byte("\n")) != 1 {
		t.Fatalf("report push 하나만 나가야 한다(record push 없음): %s", buf.String())
	}
	if pm.Get("t1").Activity() == nil {
		t.Fatal("데몬이 먼저 기록하지 않았다")
	}
}

// TC-ARD-24: reports 를 모르는 서버가 붙어 있으면 거절한다 — dmctl 이 HTTP 로 간다.
func TestReport_OldServer_Rejects(t *testing.T) {
	pm := recordsPM(t, "t1")
	ps := NewPanedServer(pm, "", "")
	buf := attachServer(ps, false)
	if r := ps.handleReport(reportReq(t, agentrec.MethodActivity, map[string]any{"toolId": "t1", "state": activity.Working})); r.OK {
		t.Fatal("옛 서버가 붙었는데 받았다")
	}
	if pm.Get("t1").Activity() != nil || buf.Len() != 0 {
		t.Fatalf("거절했는데 기록이나 push 가 남았다: %s", buf.String())
	}
}

func TestHello_ServerSaysReports(t *testing.T) {
	if !toolipc.HasFeature(toolipc.ServerFeatures, toolipc.FeatureReports) {
		t.Fatal("서버가 reports 기능을 말하지 않는다")
	}
	pm := recordsPM(t)
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}
	dispatchOne(t, pc, &buf, toolipc.MethodHello, toolipc.HelloParams{Features: []string{toolipc.FeatureReports}})
	if !pc.reports.Load() {
		t.Fatal("hello 의 reports 를 적지 않았다")
	}
}

// TC-ARD-20: 실제 소켓. 연결을 동시에 받고, 연결마다 요청 하나에 답한다. 0600 이다.
func TestReportSocket_ServesConcurrently(t *testing.T) {
	pm := recordsPM(t, "t1", "t2")
	ps := NewPanedServer(pm, "", "")
	dir, err := os.MkdirTemp("", "rsk")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, agentrec.SocketFile)
	if err := ps.ListenReports(path); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() { ps.ServeReports(); close(served) }()
	t.Cleanup(func() {
		ps.Close()
		<-served
	})
	// Windows 의 AF_UNIX 소켓 파일에는 POSIX 권한 비트가 없다 — 접근은 폴더(0700)의 ACL 이 막는다.
	if platform.Current().OS != platform.Windows {
		if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
			t.Fatalf("소켓 모드: %v %v", fi, err)
		}
	}

	// 한 연결이 아무것도 보내지 않고 붙들고 있어도 다른 연결은 답을 받는다.
	idle, err := platform.Current().IPC.Dial(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()

	var wg sync.WaitGroup
	for _, id := range []string{"t1", "t2"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			c, err := platform.Current().IPC.Dial(path, time.Second)
			if err != nil {
				t.Error(err)
				return
			}
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(2 * time.Second))
			if err := json.NewEncoder(c).Encode(reportReq(t, agentrec.MethodNotify, map[string]any{"toolId": id})); err != nil {
				t.Error(err)
				return
			}
			var r agentrec.Reply
			if err := json.NewDecoder(c).Decode(&r); err != nil || !r.OK {
				t.Errorf("%s: reply=%+v err=%v", id, r, err)
			}
		}(id)
	}
	wg.Wait()
	if !pm.Get("t1").Attention() || !pm.Get("t2").Attention() {
		t.Fatal("두 보고가 모두 반영되지 않았다")
	}
	ps.Close()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("Close 가 보고 소켓을 치우지 않았다: %v", err)
	}
}
