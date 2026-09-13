package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/workspace"
	"dongminal/internal/webserver/domain/agentsess"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/toolclient"
)

// M8_UNIFIED_SRS 묶음 B (P5) 의 HTTP 표면 — 휴면·재개·오류 상태·되살림 (FR-ABG-4·10·11·20·21,
// D-C-11~17). 가짜 에이전트, 직접 모드와 데몬 모드 (V-9).

// directAgentServerAt 은 DataDir 이 있는 직접 모드 배선이다 — 디스크 로그·레코드가 선다.
func directAgentServerAt(t *testing.T, dataDir string) (*Server, *toolhub.ToolManager, *sseCapture) {
	t.Helper()
	fakeAgentBinDirAll(t)
	m := toolhub.NewToolManager(filepath.Join(dataDir, "tools"), nil)
	t.Cleanup(m.StopSaving)
	cmdHub := hub.NewCommandHub()
	hub.WireAttention(m, cmdHub)
	hub.WireActivity(m, cmdHub)
	s := &Server{Deps: Deps{Tools: m, Commands: cmdHub}, cfg: Config{DataDir: dataDir}}
	m.SetOutputObserver(func(id string, kind toolhub.ToolKind, data []byte, end int64) { s.AgentOutput(id, kind, data, end) })
	m.SetExitObserver(s.AgentExit)
	return s, m, captureSSE(t, cmdHub)
}

func agentStateOf(t *testing.T, s *Server, id string) map[string]any {
	t.Helper()
	st, _, _ := agentEvents(t, s, id, 0)
	return st
}

func firstTurn(t *testing.T, s *Server, m *toolhub.ToolManager, id string) {
	t.Helper()
	if tool := m.Get(id); tool != nil {
		waitAgent(t, "idle", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })
	}
	if code, ec := agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"say PONG"}`); code != 200 {
		t.Fatalf("prompt: %d %s", code, ec)
	}
	waitAgent(t, "첫 턴", func() bool {
		st := agentStateOf(t, s, id)
		sid, _ := st["sessionId"].(string)
		return sid != "" && st["status"].(map[string]any)["model"] != nil
	})
	waitAgent(t, "done", func() bool {
		_, kinds, _ := agentEvents(t, s, id, 0)
		return has(kinds, "turn_end")
	})
}

// FR-ABG-10·11 · D-C-11·16·17: 첫 턴 전 휴면은 409 · 첫 턴 뒤 휴면 → 프로세스 없음, 목록에 남음,
// 같은 toolId 로 재개 → 같은 세션 신원으로 다음 턴이 오간다 (U-4: 이력은 우리 로그).
func TestAgentAPI_HibernateResume(t *testing.T) {
	dir := toolTempDir(t)
	s, m, sse := directAgentServerAt(t, dir)
	id := createAgent(t, s, "")
	tool := m.Get(id)
	waitAgent(t, "idle", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })
	if code, ec := agentPost(t, s, "/api/agent/hibernate", `{"toolId":"`+id+`"}`); code != 409 || ec != "agent_no_identity" {
		t.Fatalf("신원 없는 휴면 (D-C-16): %d %s", code, ec)
	}
	firstTurn(t, s, m, id)
	sid := agentStateOf(t, s, id)["sessionId"].(string)
	seqBefore := len(sse.kinds(id))

	if code, ec := agentPost(t, s, "/api/agent/hibernate", `{"toolId":"`+id+`"}`); code != 200 {
		t.Fatalf("hibernate: %d %s", code, ec)
	}
	if m.Get(id) != nil {
		t.Fatal("휴면한 도구의 프로세스가 남았다")
	}
	st := agentStateOf(t, s, id)
	if st["dormant"] != "hibernated" || st["resumable"] != true || st["sessionId"] != sid {
		t.Fatalf("휴면 상태: %v", st)
	}
	if ev := sse.last(id, "exit"); ev["text"] != "hibernated" || ev["isError"] == true {
		t.Fatalf("휴면의 exit (D-C-15): %v", ev)
	}
	if !has(stateToolIDs(t, s), id) {
		t.Fatal("휴면 도구가 /api/state 목록에 없다 (D-C-17)")
	}
	if code, ec := agentPost(t, s, "/api/agent/hibernate", `{"toolId":"`+id+`"}`); code != 409 || ec != "agent_dormant" {
		t.Fatalf("이중 휴면: %d %s", code, ec)
	}
	// 레코드와 로그가 디스크에 있다.
	if b, err := os.ReadFile(filepath.Join(dir, "agents.json")); err != nil || !strings.Contains(string(b), sid) {
		t.Fatalf("agents.json: %v %s", err, b)
	}
	if _, err := os.Stat(filepath.Join(dir, "agents", id+".jsonl")); err != nil {
		t.Fatal("디스크 로그가 없다")
	}

	// 재개 — 같은 toolId, 같은 신원 (가짜의 --resume 은 그 id 로 init).
	rec := httptest.NewRecorder()
	s.apiAgentResume(rec, apiTestRequest(http.MethodPost, "/api/agent/resume", strings.NewReader(`{"toolId":"`+id+`"}`)))
	var resp map[string]string
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if rec.Code != 200 || resp["id"] != id {
		t.Fatalf("resume: %d %s", rec.Code, rec.Body.String())
	}
	tool2 := m.Get(id)
	if tool2 == nil || tool2.Kind != toolhub.KindAgent {
		t.Fatal("재개된 도구가 같은 id 로 등록되지 않았다 (D-C-11)")
	}
	waitAgent(t, "재개 idle", func() bool { a := tool2.Activity(); return a != nil && a.State == "idle" })
	st = agentStateOf(t, s, id)
	if st["dormant"] != nil || st["exited"] == true || st["sessionId"] != sid {
		t.Fatalf("재개 뒤 상태: %v", st)
	}
	agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"say PONG again"}`)
	waitAgent(t, "재개 뒤 턴", func() bool {
		kinds := sse.kinds(id)
		return len(kinds) > seqBefore && kinds[len(kinds)-1] == "turn_end"
	})
	if agentStateOf(t, s, id)["sessionId"] != sid {
		t.Fatal("재개 뒤 신원이 바뀌었다")
	}
	// 재생은 휴면 전·후를 한 로그로 잇는다 — user 둘, exit 하나.
	_, kinds, _ := agentEvents(t, s, id, 0)
	users, exits := 0, 0
	for _, k := range kinds {
		switch k {
		case "user":
			users++
		case "exit":
			exits++
		}
	}
	if users != 2 || exits != 1 {
		t.Fatalf("이어진 재생: users=%d exits=%d %v", users, exits, kinds)
	}
	if code, ec := agentPost(t, s, "/api/agent/resume", `{"toolId":"`+id+`"}`); code != 409 || ec != "agent_not_dormant" {
		t.Fatalf("활성 재개: %d %s", code, ec)
	}
	_ = m.Delete(id)
}

// D-C-14: 서버 재시동(직접 모드 — 프로세스는 죽었다). 레코드가 세션을 오류 상태로 되살리고,
// 재생이 디스크 로그에서 나오며, 재개가 된다. 어느 탭도 참조하지 않는 레코드는 버려진다.
func TestAgentAPI_RestoreAfterRestart(t *testing.T) {
	dir := toolTempDir(t)
	s, m, _ := directAgentServerAt(t, dir)
	id := createAgent(t, s, "")
	firstTurn(t, s, m, id)
	orphan := createAgent(t, s, "")
	firstTurn(t, s, m, orphan)
	sid := agentStateOf(t, s, id)["sessionId"].(string)
	// 프로세스를 죽인다 — 서버가 내려간 것과 같다 (exit 관측은 이 서버의 것).
	_ = m.Delete(id)
	_ = m.Delete(orphan)
	waitAgent(t, "오류 상태", func() bool { return agentStateOf(t, s, id)["dormant"] == "error" })

	// 새 서버 — id 만 탭이 참조한다.
	ws := workspaceReferencing(t, id)
	s2, m2, _ := directAgentServerAt(t, dir)
	s2.Work = ws
	s2.AgentRestore()
	if s2.agentMgr().Get(orphan) != nil {
		t.Fatal("참조 없는 레코드가 되살아났다")
	}
	sess := s2.agentMgr().Get(id)
	if sess == nil {
		t.Fatal("레코드에서 세션이 되살아나지 않았다")
	}
	st, kinds, _ := agentEvents(t, s2, id, 0)
	if st["dormant"] != "error" || st["resumable"] != true || st["sessionId"] != sid || !has(kinds, "user") || !has(kinds, "exit") {
		t.Fatalf("되살린 상태·재생: %v %v", st, kinds)
	}
	if !has(stateToolIDs(t, s2), id) {
		t.Fatal("되살린 오류 세션이 목록에 없다")
	}
	if code, ec := agentPost(t, s2, "/api/agent/resume", `{"toolId":"`+id+`"}`); code != 200 {
		t.Fatalf("되살린 세션의 재개: %d %s", code, ec)
	}
	tool := m2.Get(id)
	if tool == nil {
		t.Fatal("재개된 도구가 없다")
	}
	waitAgent(t, "idle", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })
	agentPost(t, s2, "/api/agent/prompt", `{"toolId":"`+id+`","text":"say PONG"}`)
	waitAgent(t, "턴", func() bool { _, k, _ := agentEvents(t, s2, id, 0); return k[len(k)-1] == "turn_end" })
	if agentStateOf(t, s2, id)["sessionId"] != sid {
		t.Fatal("재개 뒤 신원")
	}
	_ = m2.Delete(id)
}

// workspaceReferencing 은 toolIDs 를 탭으로 참조하는 워크스페이스다 (AgentRestore 의 참조 판정).
func workspaceReferencing(t *testing.T, toolIDs ...string) *workspace.Manager {
	t.Helper()
	tabs := make([]string, 0, len(toolIDs))
	for i, id := range toolIDs {
		tabs = append(tabs, `{"id":"t`+string(rune('a'+i))+`","type":"agent","toolId":"`+id+`"}`)
	}
	blob := `{"activeWindow":"w1","schemaVersion":2,"windows":[{"id":"w1","name":"A","focusedPane":"p1","layout":{"type":"pane","id":"p1","tabs":[` + strings.Join(tabs, ",") + `],"activeTab":"ta"}}]}`
	live := liveSet{}
	for _, id := range toolIDs {
		live[id] = struct{}{}
	}
	mgr, err := workspace.New(live, &memPersister{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { mgr.Close() })
	if _, err := mgr.Save([]byte(blob), ""); err != nil {
		t.Fatal(err)
	}
	return mgr
}

// newAgentMgrWithCap 은 agentMgr 와 같은 배선에 로그 상한만 다르다 (스냅샷 모양 검사).
func newAgentMgrWithCap(s *Server, cap int) *agentsess.Manager {
	return agentsess.New(agentsess.Deps{
		Sink:     agentSink{s: s},
		Write:    func(id string, data []byte) error { return s.Tools.Write(id, data) },
		Snapshot: func(id string) (toolhub.ToolSnapshot, error) { return s.Tools.SnapshotTool(id) },
		LogCap:   cap,
	})
}

// D-C-13 · FR-ABG-21: 상한을 넘긴 재생은 truncated 와 요약 스냅샷을 함께 낸다 — 스냅샷의 seq
// 다음이 첫 이벤트다. (상한은 해석층 단위 테스트가 잰다; 여기서는 HTTP 모양만.)
func TestAgentAPI_ReplaySnapshotShape(t *testing.T) {
	s, m, _ := directAgentServer(t)
	s.agentOnce.Do(func() {}) // 아래에서 상한 8 로 직접 세운다
	s.agents = newAgentMgrWithCap(s, 8)
	id := createAgent(t, s, "")
	firstTurn(t, s, m, id)
	for i := 0; i < 3; i++ {
		agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"say PONG"}`)
		waitAgent(t, "턴", func() bool { _, k, _ := agentEvents(t, s, id, 0); return k[len(k)-1] == "turn_end" })
	}
	rec := httptest.NewRecorder()
	s.apiAgentEvents(rec, apiTestRequest(http.MethodGet, "/api/agent/events?tool="+id+"&since=0", nil))
	var resp struct {
		Truncated bool `json:"truncated"`
		Snapshot  *struct {
			Seq       int64  `json:"seq"`
			SessionID string `json:"sessionId"`
		} `json:"snapshot"`
		Events []struct{ Seq int64 } `json:"events"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if !resp.Truncated || resp.Snapshot == nil || len(resp.Events) != 8 || resp.Events[0].Seq != resp.Snapshot.Seq+1 || resp.Snapshot.SessionID == "" {
		t.Fatalf("스냅샷 모양: %s", rec.Body.String())
	}
	rec = httptest.NewRecorder()
	s.apiAgentEvents(rec, apiTestRequest(http.MethodGet, "/api/agent/events?tool="+id+"&since="+jsonInt(resp.Snapshot.Seq), nil))
	if strings.Contains(rec.Body.String(), `"snapshot"`) {
		t.Fatal("잘리지 않은 since 에 스냅샷이 실렸다")
	}
}

func jsonInt(v int64) string { b, _ := json.Marshal(v); return string(b) }

// V-9: 데몬 모드에서도 휴면·재개가 같다 — 재개는 데몬의 `create` 가 `reuseId` 를 받아 같은 id 로
// 세운다. 서버 재시동(레코드 + 살아 있는 도구)은 Resume 으로 채택한다.
func TestAgentAPI_DaemonHibernateResume(t *testing.T) {
	ad, _ := agentadapter.Get(claudeID)
	fakeAgentBinDir(t, ad)
	dir := toolTempDir(t)
	pm := toolhub.NewToolManager(dir+"/d", nil)
	os.MkdirAll(dir+"/d", 0o755)
	t.Cleanup(pm.StopSaving)
	ps := ipc.NewPanedServer(pm, dir+"/s", "")
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	defer ps.Close()
	go func() { ps.Accept() }()
	pc, err := toolclient.DialToolClient(dir + "/s")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	cmdHub := hub.NewCommandHub()
	tracker := hub.NewAttnTracker(cmdHub, 10000)
	tracker.SetBusyProbe(pc.Busy)
	tracker.SetLiveProbe(pc.IsLive)
	newServer := func() *Server {
		s := &Server{Deps: Deps{Tools: pc, Commands: cmdHub, AttnTracker: tracker}, cfg: Config{DataDir: dir + "/data"}}
		return s
	}
	s := newServer()
	var cur *Server = s
	pc.SetOnOutput(func(toolID string, kind toolhub.ToolKind, data []byte, end int64) {
		if cur.AgentOutput(toolID, kind, data, end) {
			return
		}
		tracker.FeedOutput(toolID, data)
	})
	pc.SetOnExit(func(toolID string, info toolhub.ExitInfo) {
		cur.AgentExit(toolID, info)
		tracker.SetActivity(toolID, "ended", "", "")
		tracker.Forget(toolID)
	})
	sse := captureSSE(t, cmdHub)

	id := createAgent(t, s, "")
	waitAgent(t, "idle", func() bool { a := tracker.Activity(id); return a != nil && a.State == "idle" })
	agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"say PONG"}`)
	waitAgent(t, "turn_end", func() bool { return has(sse.kinds(id), "turn_end") })
	sid := agentStateOf(t, s, id)["sessionId"].(string)
	if sid == "" {
		t.Fatal("신원")
	}

	// 서버 재시동 — 도구는 데몬에 살아 있다. 레코드의 Resume 으로 채택한다 (codex 라면 rejoin).
	s2 := newServer()
	s2.Work = workspaceReferencing(t, id)
	cur = s2
	s2.AgentRestore()
	st := agentStateOf(t, s2, id)
	if st["dormant"] != nil || st["sessionId"] != sid || st["agent"] != claudeID {
		t.Fatalf("채택: %v", st)
	}

	// 휴면 → 데몬에서 프로세스가 사라지고 exit push 가 세션을 마감한다.
	if code, ec := agentPost(t, s2, "/api/agent/hibernate", `{"toolId":"`+id+`"}`); code != 200 {
		t.Fatalf("hibernate: %d %s", code, ec)
	}
	if pc.Get(id) != nil {
		t.Fatal("휴면 뒤 데몬에 도구가 남았다")
	}
	if agentStateOf(t, s2, id)["dormant"] != "hibernated" {
		t.Fatalf("휴면 상태: %v", agentStateOf(t, s2, id))
	}
	// 재개 — 데몬의 create 가 reuseId 로 같은 id.
	if code, ec := agentPost(t, s2, "/api/agent/resume", `{"toolId":"`+id+`"}`); code != 200 {
		t.Fatalf("resume: %d %s", code, ec)
	}
	if tool := pc.Get(id); tool == nil || tool.Kind != toolhub.KindAgent {
		t.Fatal("재개된 도구가 같은 id 로 데몬에 서지 않았다")
	}
	waitAgent(t, "idle", func() bool { a := tracker.Activity(id); return a != nil && a.State == "idle" })
	agentPost(t, s2, "/api/agent/prompt", `{"toolId":"`+id+`","text":"say PONG"}`)
	waitAgent(t, "턴", func() bool { _, k, _ := agentEvents(t, s2, id, 0); return k[len(k)-1] == "turn_end" })
	if agentStateOf(t, s2, id)["sessionId"] != sid {
		t.Fatal("재개 뒤 신원")
	}
	_ = pm.Delete(id)
}
