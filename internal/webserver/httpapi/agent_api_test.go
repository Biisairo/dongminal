package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/agentadapter/fakeagent"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/toolclient"
)

// M8_UNIFIED_SRS 묶음 P·T — 에이전트 도구의 서버 표면을 **가짜 에이전트**로 돈다
// (V-1 형태 · V-2 승인 왕복 · V-8 끊김 · V-9 두 모드 · V-13 소비자는 에이전트를
// 모른다). 가짜는 이 테스트 바이너리 자신이다 — `DM_FAKEAGENT=1` 로 다시 실행되면
// fakeagent.Main 을 돈다 (go build 없이).

const fakeAgentEnv = "DM_FAKEAGENT"

func init() {
	if os.Getenv(fakeAgentEnv) == "1" {
		os.Exit(fakeagent.Main(os.Args[1:], os.Stdin, os.Stdout))
	}
}

// fakeAgentBinDir 은 어댑터의 DetectCmd 이름으로 이 테스트 바이너리를 가리키는
// 디렉터리다 (D-C-7). 이름은 등록부에서 온다 — 리터럴이 아니다.
func fakeAgentBinDir(t *testing.T, ad agentadapter.Adapter) string {
	t.Helper()
	if !testpath.POSIXShell() {
		t.Skip("symlink·환경 상속이 다르다")
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	// 심볼릭 링크로는 환경변수를 실을 수 없다 — 래퍼 스크립트가 표식을 심는다.
	script := "#!/bin/sh\n" + fakeAgentEnv + "=1 exec '" + self + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, ad.DetectCmd), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(dmenv.EnvAgentBinDir, dir)
	return dir
}

// fakeAgentBinDirAll 은 프로토콜 표면이 있는 모든 어댑터의 이름으로 가짜를 놓는다.
func fakeAgentBinDirAll(t *testing.T) string {
	t.Helper()
	var dir string
	for _, id := range agentadapter.IDs() {
		ad, _ := agentadapter.Get(id)
		if ad.Proto == nil {
			continue
		}
		if dir == "" {
			dir = fakeAgentBinDir(t, ad)
			continue
		}
		self, _ := os.Executable()
		script := "#!/bin/sh\n" + fakeAgentEnv + "=1 exec '" + self + "' \"$@\"\n"
		if err := os.WriteFile(filepath.Join(dir, ad.DetectCmd), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// sseCapture 는 CommandHub 의 방송을 모은다.
type sseCapture struct {
	mu     sync.Mutex
	events []map[string]any
}

func captureSSE(t *testing.T, h *hub.CommandHub) *sseCapture {
	t.Helper()
	c := &sseCapture{}
	sub := h.Add()
	go func() {
		for msg := range sub.Messages() {
			var ev map[string]any
			if json.Unmarshal(msg, &ev) == nil {
				c.mu.Lock()
				c.events = append(c.events, ev)
				c.mu.Unlock()
			}
		}
	}()
	t.Cleanup(func() { h.Remove(sub) })
	return c
}

func (c *sseCapture) kinds(toolID string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, ev := range c.events {
		if ev["action"] != "agent_event" {
			continue
		}
		args, _ := ev["args"].(map[string]any)
		if args["toolId"] != toolID {
			continue
		}
		e, _ := args["ev"].(map[string]any)
		out = append(out, e["kind"].(string))
	}
	return out
}

// last 는 그 도구의 want 종류 마지막 이벤트 본문이다. 없으면 nil.
func (c *sseCapture) last(toolID, want string) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out map[string]any
	for _, ev := range c.events {
		if ev["action"] != "agent_event" {
			continue
		}
		args, _ := ev["args"].(map[string]any)
		e, _ := args["ev"].(map[string]any)
		if args["toolId"] == toolID && e["kind"] == want {
			out = e
		}
	}
	return out
}

// stateToolIDs 는 `/api/state` 의 도구 id 들이다 — D-C-17 의 합친 목록.
func stateToolIDs(t *testing.T, s *Server) []string {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiStateGet(rec, apiTestRequest(http.MethodGet, "/api/state", nil))
	var resp struct {
		Tools []struct {
			ID      string `json:"id"`
			Kind    string `json:"kind"`
			Dormant string `json:"dormant"`
		} `json:"tools"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	var ids []string
	for _, ti := range resp.Tools {
		ids = append(ids, ti.ID)
	}
	return ids
}

func waitAgent(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s 를 기다리다 시한", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// claudeID 는 검증 대상 어댑터다 — 이 테스트만 이름을 안다 (테스트는 게이트 밖).
const claudeID = "claude"

// directAgentServer 는 직접 모드 배선이다 (main.go 의 것과 같다). 가짜는 등록부의
// 모든 어댑터 이름으로 놓인다 — 세 프로토콜을 같은 바이너리가 말한다.
func directAgentServer(t *testing.T) (*Server, *toolhub.ToolManager, *sseCapture) {
	t.Helper()
	fakeAgentBinDirAll(t)
	m := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	cmdHub := hub.NewCommandHub()
	hub.WireAttention(m, cmdHub)
	hub.WireActivity(m, cmdHub)
	s := &Server{Deps: Deps{Tools: m, Commands: cmdHub}}
	m.SetOutputObserver(func(id string, kind toolhub.ToolKind, data []byte, end int64) { s.AgentOutput(id, kind, data, end) })
	m.SetExitObserver(s.AgentExit)
	return s, m, captureSSE(t, cmdHub)
}

func createAgent(t *testing.T, s *Server, query string) string {
	t.Helper()
	return createAgentAs(t, s, claudeID, query)
}

func createAgentAs(t *testing.T, s *Server, agent, query string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiToolsCreate(rec, apiTestRequest(http.MethodPost, "/api/tools?kind=agent&agent="+agent+query, nil))
	if rec.Code != 200 {
		t.Fatalf("create: %d %s %s", rec.Code, rec.Header().Get("X-Error-Code"), rec.Body.String())
	}
	var resp map[string]string
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["kind"] != "agent" || resp["agent"] != agent || resp["id"] == "" {
		t.Fatalf("응답: %v", resp)
	}
	t.Cleanup(func() { _ = s.Tools.Delete(resp["id"]) })
	return resp["id"]
}

func agentPost(t *testing.T, s *Server, path, body string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := apiTestRequest(http.MethodPost, path, strings.NewReader(body))
	switch path {
	case "/api/agent/prompt":
		s.apiAgentPrompt(rec, req)
	case "/api/agent/approve":
		s.apiAgentApprove(rec, req)
	case "/api/agent/control":
		s.apiAgentControl(rec, req)
	case "/api/agent/interrupt":
		s.apiAgentInterrupt(rec, req)
	case "/api/agent/hibernate":
		s.apiAgentHibernate(rec, req)
	case "/api/agent/resume":
		s.apiAgentResume(rec, req)
	}
	return rec.Code, rec.Header().Get("X-Error-Code")
}

func agentEvents(t *testing.T, s *Server, toolID string, since int64) (state map[string]any, kinds []string, truncated bool) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiAgentEvents(rec, apiTestRequest(http.MethodGet, "/api/agent/events?tool="+toolID+"&since="+strconv.FormatInt(since, 10), nil))
	if rec.Code != 200 {
		t.Fatalf("events: %d %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		State     map[string]any                       `json:"state"`
		Events    []struct{ Ev struct{ Kind string } } `json:"events"`
		Truncated bool                                 `json:"truncated"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	for _, e := range resp.Events {
		kinds = append(kinds, e.Ev.Kind)
	}
	return resp.State, kinds, resp.Truncated
}

func has(list []string, want string) bool {
	for _, k := range list {
		if k == want {
			return true
		}
	}
	return false
}

// V-1 (형태) · FR-AGT-8: 같은 Create 종단, 핸드셰이크 응답이 `idle` 로 보고되고
// (`dmctl wait --for ready` 가 답을 얻는 길 — D-C-16: 첫 턴 전에는 신원이 없다), 첫 턴 뒤에
// 세션 신원이 선다.
func TestAgentAPI_CreateAndSession(t *testing.T) {
	s, m, sse := directAgentServer(t)
	id := createAgent(t, s, "&model=fake-x")
	tool := m.Get(id)
	if tool == nil || tool.Kind != toolhub.KindAgent {
		t.Fatal("에이전트 도구가 목록에 없다")
	}
	waitAgent(t, "idle 활동", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })
	waitAgent(t, "SSE session", func() bool { return has(sse.kinds(id), "session") })
	st, _, _ := agentEvents(t, s, id, 0)
	if sid, _ := st["sessionId"].(string); sid != "" {
		t.Fatalf("첫 턴 전에는 신원이 없다 (D-C-16): %v", st)
	}
	agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"say PONG"}`)
	waitAgent(t, "session", func() bool {
		st, _, _ := agentEvents(t, s, id, 0)
		return st["sessionId"] != nil && st["sessionId"] != ""
	})
	st, kinds, _ := agentEvents(t, s, id, 0)
	if !has(kinds, "session") || !has(kinds, "user") {
		t.Fatalf("재생: %v", kinds)
	}
	status, _ := st["status"].(map[string]any)
	if status["model"] != "fake-x" || status["models"] == nil {
		t.Fatalf("상태: %v", st)
	}
	// 터미널 도구의 종단은 그대로다 — 종류 없는 생성은 셸이다.
	rec := httptest.NewRecorder()
	s.apiToolsCreate(rec, apiTestRequest(http.MethodPost, "/api/tools", nil))
	var sh map[string]string
	json.Unmarshal(rec.Body.Bytes(), &sh)
	if rec.Code != 200 || sh["kind"] != "" {
		t.Fatalf("터미널 생성: %d %v", rec.Code, sh)
	}
	t.Cleanup(func() { _ = m.Delete(sh["id"]) })
}

// V-2 · FR-APS-5·6 · FR-AAL-2·3·4: 승인 요청이 열리면 waiting 알람이 그 내용과 함께
// 서고, 답은 한 프레임으로 에이전트에 닿아 턴이 끝난다(done 알람).
func TestAgentAPI_ApprovalRoundTrip(t *testing.T) {
	s, m, sse := directAgentServer(t)
	id := createAgent(t, s, "")
	tool := m.Get(id)
	waitAgent(t, "idle", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })
	if code, _ := agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"please APPROVE this"}`); code != 200 {
		t.Fatalf("prompt: %d", code)
	}
	waitAgent(t, "approval_open", func() bool { return has(sse.kinds(id), "approval_open") })
	a := tool.Activity()
	if a == nil || a.State != "waiting" || a.Tool != "Bash" || !strings.Contains(a.Detail, "touch") {
		t.Fatalf("waiting 활동에 내용이 실려야 한다 (FR-AAL-4): %+v", a)
	}
	if !tool.Attention() {
		t.Fatal("열린 승인 요청은 알람이다 (FR-AAL-3)")
	}
	st, _, _ := agentEvents(t, s, id, 0)
	open, _ := st["open"].([]any)
	if len(open) != 1 {
		t.Fatalf("열린 요청: %v", st["open"])
	}
	req := open[0].(map[string]any)
	opts, _ := req["options"].([]any)
	if len(opts) != 3 {
		t.Fatalf("선택지는 프로토콜이 준 그대로다 (FR-AGT-5): %v", opts)
	}
	// 모르는 요청 id 는 409.
	if code, ec := agentPost(t, s, "/api/agent/approve", `{"toolId":"`+id+`","id":"nope","choice":"allow"}`); code != http.StatusConflict || ec != "approval_not_open" {
		t.Fatalf("닫힌 요청: %d %s", code, ec)
	}
	tool.Attend()
	if code, _ := agentPost(t, s, "/api/agent/approve", `{"toolId":"`+id+`","id":"`+req["id"].(string)+`","choice":"suggestion:0"}`); code != 200 {
		t.Fatalf("approve: %d", code)
	}
	waitAgent(t, "turn_end", func() bool { return has(sse.kinds(id), "turn_end") })
	kinds := sse.kinds(id)
	for _, want := range []string{"approval_closed", "status", "tool_end", "text_delta", "message", "usage", "turn_end"} {
		if !has(kinds, want) {
			t.Fatalf("승인 뒤 %s 가 없다: %v", want, kinds)
		}
	}
	waitAgent(t, "done", func() bool { a := tool.Activity(); return a != nil && a.State == "done" })
	if !tool.Attention() {
		t.Fatal("사용자 프롬프트로 시작한 턴의 끝은 알람이다 (FR-AAL-2)")
	}
	if len(s.agentMgr().Get(id).Open()) != 0 {
		t.Fatal("답한 요청이 남았다")
	}
}

// FR-AGT-4 질문 답변 · FR-AGT-4a 인터럽트 · FR-AGT-11 제어.
func TestAgentAPI_QuestionInterruptControl(t *testing.T) {
	s, m, sse := directAgentServer(t)
	id := createAgent(t, s, "")
	tool := m.Get(id)
	waitAgent(t, "idle", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })
	agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"QUESTION"}`)
	waitAgent(t, "approval_open", func() bool { return has(sse.kinds(id), "approval_open") })
	st, _, _ := agentEvents(t, s, id, 0)
	req := st["open"].([]any)[0].(map[string]any)
	if req["kind"] != "question" || req["questions"] == nil {
		t.Fatalf("질문: %v", req)
	}
	if code, _ := agentPost(t, s, "/api/agent/approve", `{"toolId":"`+id+`","id":"`+req["id"].(string)+`","answers":{"Pick a color":"Blue"}}`); code != 200 {
		t.Fatalf("answer: %d", code)
	}
	waitAgent(t, "turn_end", func() bool { return has(sse.kinds(id), "turn_end") })

	// 제어: 모델 전환은 status 로 돌아온다. 없는 제어는 400.
	before := len(sse.kinds(id))
	if code, _ := agentPost(t, s, "/api/agent/control", `{"toolId":"`+id+`","kind":"set_model","value":"fast"}`); code != 200 {
		t.Fatalf("control: %d", code)
	}
	waitAgent(t, "model status", func() bool {
		st, _, _ := agentEvents(t, s, id, 0)
		return st["status"].(map[string]any)["model"] == "fast"
	})
	if code, ec := agentPost(t, s, "/api/agent/control", `{"toolId":"`+id+`","kind":"login"}`); code != 400 || ec != "agent_control_unsupported" {
		t.Fatalf("없는 제어: %d %s", code, ec)
	}
	_ = before
	// 인터럽트: 느린 턴이 aborted 로 끝난다.
	agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"SLOW"}`)
	waitAgent(t, "text_delta", func() bool {
		_, kinds, _ := agentEvents(t, s, id, 0)
		n := 0
		for _, k := range kinds {
			if k == "text_delta" {
				n++
			}
		}
		return n >= 3
	})
	if code, _ := agentPost(t, s, "/api/agent/interrupt", `{"toolId":"`+id+`"}`); code != 200 {
		t.Fatalf("interrupt: %d", code)
	}
	waitAgent(t, "aborted", func() bool {
		rec := httptest.NewRecorder()
		s.apiAgentEvents(rec, apiTestRequest(http.MethodGet, "/api/agent/events?tool="+id+"&since=0", nil))
		return strings.Contains(rec.Body.String(), `"aborted_streaming"`)
	})
	// TUI 출구: 같은 세션 신원의 한 줄.
	rec := httptest.NewRecorder()
	s.apiAgentTUILine(rec, apiTestRequest(http.MethodGet, "/api/agent/tui-line?tool="+id, nil))
	var line map[string]string
	json.Unmarshal(rec.Body.Bytes(), &line)
	if rec.Code != 200 || !strings.Contains(line["line"], "--resume "+line["sessionId"]) || line["sessionId"] == "" {
		t.Fatalf("tui-line: %d %v", rec.Code, line)
	}
}

// V-8 · FR-ABG-20: 프로세스가 죽으면 exit 이벤트(사유 died)·ended 활동, 세션은 **오류 상태로
// 남는다** (P5 D-C-11·15) — 프롬프트는 409, 닫기(DELETE)가 세션을 지운다.
func TestAgentAPI_ExitAndErrors(t *testing.T) {
	s, m, sse := directAgentServer(t)
	id := createAgent(t, s, "")
	tool := m.Get(id)
	waitAgent(t, "idle", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })
	agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"DIE"}`)
	waitAgent(t, "exit", func() bool { return has(sse.kinds(id), "exit") })
	waitAgent(t, "오류 상태", func() bool { st, _, _ := agentEvents(t, s, id, 0); return st["dormant"] == "error" })
	st, _, _ := agentEvents(t, s, id, 0)
	if st["exited"] != true || st["resumable"] != true {
		t.Fatalf("오류 상태: %v", st)
	}
	if ev := sse.last(id, "exit"); ev["text"] != "died" || ev["isError"] != true || !strings.Contains(ev["detail"].(string), "exit 1") {
		t.Fatalf("exit 이벤트의 사유 (D-C-15): %v", ev)
	}
	if code, ec := agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"x"}`); code != 409 || ec != "agent_dormant" {
		t.Fatalf("죽은 세션에 프롬프트: %d %s", code, ec)
	}
	// D-C-17: 휴면·오류 세션은 /api/state 의 목록에 합쳐진다.
	if !has(stateToolIDs(t, s), id) {
		t.Fatal("오류 상태의 에이전트 도구가 목록에 없다")
	}
	// 닫기가 세션을 지운다.
	rec := httptest.NewRecorder()
	s.apiToolDelete(rec, apiTestRequest(http.MethodDelete, "/api/tools/"+id, nil))
	if s.agentMgr().Get(id) != nil || has(stateToolIDs(t, s), id) {
		t.Fatal("닫은 뒤에도 세션이 남았다")
	}
	if code, ec := agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"x"}`); code != 404 || ec != "agent_session_not_found" {
		t.Fatalf("닫은 세션: %d %s", code, ec)
	}
	// FR-APS-4 · FR-U-1: 모르는 에이전트와 프로토콜 표면이 없는 에이전트는 코드로 거절된다.
	rec = httptest.NewRecorder()
	s.apiToolsCreate(rec, apiTestRequest(http.MethodPost, "/api/tools?kind=agent&agent=nope", nil))
	if rec.Code != 400 || rec.Header().Get("X-Error-Code") != "unknown_agent" {
		t.Fatalf("unknown: %d %s", rec.Code, rec.Header().Get("X-Error-Code"))
	}
	for _, other := range agentadapter.IDs() {
		ad, _ := agentadapter.Get(other)
		if ad.Proto != nil {
			continue
		}
		rec := httptest.NewRecorder()
		s.apiToolsCreate(rec, apiTestRequest(http.MethodPost, "/api/tools?kind=agent&agent="+other, nil))
		if rec.Code != 400 || rec.Header().Get("X-Error-Code") != "agent_no_proto" {
			t.Fatalf("%s: %d %s", other, rec.Code, rec.Header().Get("X-Error-Code"))
		}
	}
	// 실행 파일이 없으면 404 코드.
	t.Setenv(dmenv.EnvAgentBinDir, t.TempDir())
	t.Setenv("PATH", t.TempDir())
	rec = httptest.NewRecorder()
	s.apiToolsCreate(rec, apiTestRequest(http.MethodPost, "/api/tools?kind=agent&agent="+claudeID, nil))
	if rec.Code != 404 || rec.Header().Get("X-Error-Code") != "agent_bin_missing" {
		t.Fatalf("bin missing: %d %s", rec.Code, rec.Header().Get("X-Error-Code"))
	}
}

// GET /api/agents 는 등록부에서 파생한다 — 프로토콜 표면과 실행 파일의 유무.
func TestAgentAPI_List(t *testing.T) {
	s, _, _ := directAgentServer(t)
	rec := httptest.NewRecorder()
	s.apiAgentsList(rec, apiTestRequest(http.MethodGet, "/api/agents", nil))
	var list []map[string]any
	json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != len(agentadapter.IDs()) {
		t.Fatalf("목록: %v", list)
	}
	for _, e := range list {
		ad, _ := agentadapter.Get(e["id"].(string))
		if e["proto"] != (ad.Proto != nil) {
			t.Fatalf("proto 표시: %v", e)
		}
		if e["id"] == claudeID && e["available"] != true {
			t.Fatalf("가짜 실행 파일이 있는데 available 이 아니다: %v", e)
		}
	}
}

// V-9: 데몬 모드 — 같은 세 요청이 같은 답을 낸다. 배선은 main.go 의 것과 같다.
func TestAgentAPI_DaemonMode(t *testing.T) {
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
	s := &Server{Deps: Deps{Tools: pc, Commands: cmdHub, AttnTracker: tracker}}
	pc.SetOnOutput(func(toolID string, kind toolhub.ToolKind, data []byte, end int64) {
		if s.AgentOutput(toolID, kind, data, end) {
			return
		}
		tracker.FeedOutput(toolID, data)
	})
	pc.SetOnExit(func(toolID string, info toolhub.ExitInfo) {
		s.AgentExit(toolID, info)
		tracker.SetActivity(toolID, "ended", "", "")
		tracker.Forget(toolID)
	})
	sse := captureSSE(t, cmdHub)

	id := createAgent(t, s, "")
	waitAgent(t, "idle", func() bool { a := tracker.Activity(id); return a != nil && a.State == "idle" })
	if tool := pc.Get(id); tool == nil || tool.Kind != toolhub.KindAgent || tool.Agent != claudeID {
		t.Fatalf("데몬 모드의 합성 Tool 도 종류를 든다 (GO-47): %+v", tool)
	}
	agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+id+`","text":"APPROVE"}`)
	waitAgent(t, "approval_open", func() bool { return has(sse.kinds(id), "approval_open") })
	if !tracker.Attention(id) {
		t.Fatal("데몬 모드에서도 열린 요청은 알람이다 (FR-AAL-6)")
	}
	st, _, _ := agentEvents(t, s, id, 0)
	req := st["open"].([]any)[0].(map[string]any)
	if code, _ := agentPost(t, s, "/api/agent/approve", `{"toolId":"`+id+`","id":"`+req["id"].(string)+`","choice":"allow"}`); code != 200 {
		t.Fatalf("approve: %d", code)
	}
	waitAgent(t, "turn_end", func() bool { return has(sse.kinds(id), "turn_end") })
	waitAgent(t, "done", func() bool { a := tracker.Activity(id); return a != nil && a.State == "done" })

	// 서버 재시동의 자리: 새 서버가 살아 있는 에이전트 도구를 되찾는다 (AgentRestore — 레코드 없이도 채택한다).
	s2 := &Server{Deps: Deps{Tools: pc, Commands: cmdHub, AttnTracker: tracker}}
	s2.AgentRestore()
	if s2.agentMgr().Get(id) == nil {
		t.Fatal("살아 있는 에이전트 도구에 세션이 서지 않았다")

	}
	st2, kinds2, _ := agentEvents(t, s2, id, 0)
	if st2["agent"] != claudeID || !has(kinds2, "session") {
		t.Fatalf("되찾은 세션: %v %v", st2, kinds2)
	}
	_ = pm.Delete(id)
}

// D-C-10 (§2-25): 데몬 모드에서 **터미널 도구**의 첫 청크가 readLoop 을 세우지
// 않는다. 종전의 입구는 종류를 `Tools.Get` 으로 되물었고, 그것은 readLoop 안에서
// 자기 응답을 기다리는 RPC 라 시한(5초)까지 막혔다가 연결을 떨어뜨렸다 — 그 사이의
// `IsLive`·`Cwd`·WS attach 가 전부 실패했다 (e2e TC-AGT-6 의 `── exited ──`).
func TestAgentAPI_DaemonTermChunkNoStall(t *testing.T) {
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
	s := &Server{Deps: Deps{Tools: pc, Commands: cmdHub, AttnTracker: tracker}}
	var chunks atomic.Int64
	pc.SetOnOutput(func(toolID string, kind toolhub.ToolKind, data []byte, end int64) {
		chunks.Add(1)
		if s.AgentOutput(toolID, kind, data, end) {
			return
		}
		tracker.FeedOutput(toolID, data)
	})

	tool, err := pc.Create("", 80, 24, toolhub.Placement{Command: "echo hello; sleep 30"})
	if err != nil {
		t.Fatal(err)
	}
	defer pm.Delete(tool.ID)
	waitAgent(t, "첫 청크", func() bool { return chunks.Load() > 0 })
	// 청크가 지나간 직후의 RPC 가 곧바로 답해야 한다 — 막혔다면 5초 시한 뒤 실패다.
	started := time.Now()
	if !pc.IsLive(tool.ID) {
		t.Fatalf("살아 있는 도구가 IsLive 아니다 (readLoop 이 막혔나) — %v", time.Since(started))
	}
	if d := time.Since(started); d > 2*time.Second {
		t.Fatalf("청크 뒤의 RPC 가 %v 걸렸다 — readLoop 이 자기 RPC 를 기다렸다", d)
	}
}

// P4 · §9.2 R-a: 프로토콜 표면이 있는 어댑터 전부가 같은 HTTP 표면에서 같은 시나리오를
// 돈다 — 세션 신원·idle · 승인 왕복(waiting→done, 알람) · 죽음(exit). 소비자 쪽은 어댑터를
// 모른다 (FR-U-1·2).
func TestAgentAPI_AllProtocols(t *testing.T) {
	for _, id := range agentadapter.IDs() {
		ad, _ := agentadapter.Get(id)
		if ad.Proto == nil || id == claudeID {
			continue
		}
		t.Run(id, func(t *testing.T) {
			s, m, sse := directAgentServer(t)
			tid := createAgentAs(t, s, id, "")
			tool := m.Get(tid)
			waitAgent(t, "idle", func() bool { a := tool.Activity(); return a != nil && a.State == "idle" })
			st, kinds, _ := agentEvents(t, s, tid, 0)
			if st["sessionId"] == nil || st["sessionId"] == "" || !has(kinds, "session") {
				t.Fatalf("세션: %v %v", st, kinds)
			}
			waitAgent(t, "models", func() bool {
				st, _, _ := agentEvents(t, s, tid, 0)
				status, _ := st["status"].(map[string]any)
				return status["models"] != nil
			})
			agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+tid+`","text":"please APPROVE this"}`)
			waitAgent(t, "approval_open", func() bool { return has(sse.kinds(tid), "approval_open") })
			a := tool.Activity()
			if a == nil || a.State != "waiting" || a.Tool == "" || !strings.Contains(a.Detail, "touch") {
				t.Fatalf("waiting 활동에 내용이 실려야 한다 (FR-AAL-4): %+v", a)
			}
			if !tool.Attention() {
				t.Fatal("열린 승인 요청은 알람이다 (FR-AAL-3)")
			}
			st, _, _ = agentEvents(t, s, tid, 0)
			open, _ := st["open"].([]any)
			if len(open) != 1 {
				t.Fatalf("열린 요청: %v", st["open"])
			}
			req := open[0].(map[string]any)
			opts, _ := req["options"].([]any)
			if len(opts) < 2 || opts[0].(map[string]any)["id"] != "allow" {
				t.Fatalf("선택지: %v", opts)
			}
			tool.Attend()
			if code, _ := agentPost(t, s, "/api/agent/approve", `{"toolId":"`+tid+`","id":"`+req["id"].(string)+`","choice":"allow"}`); code != 200 {
				t.Fatalf("approve: %d", code)
			}
			waitAgent(t, "turn_end", func() bool { return has(sse.kinds(tid), "turn_end") })
			for _, want := range []string{"approval_closed", "tool_end", "text_delta", "message", "usage", "turn_end"} {
				if !has(sse.kinds(tid), want) {
					t.Fatalf("승인 뒤 %s 가 없다: %v", want, sse.kinds(tid))
				}
			}
			waitAgent(t, "done", func() bool { a := tool.Activity(); return a != nil && a.State == "done" })
			if !tool.Attention() {
				t.Fatal("사용자 프롬프트로 시작한 턴의 끝은 알람이다 (FR-AAL-2)")
			}
			agentPost(t, s, "/api/agent/prompt", `{"toolId":"`+tid+`","text":"DIE"}`)
			waitAgent(t, "exit", func() bool { return has(sse.kinds(tid), "exit") })
			// P5 D-C-11: 죽음은 오류 상태다 — 세션은 남고 재개할 수 있다 (신원이 있다).
			waitAgent(t, "오류 상태", func() bool { st := agentStateOf(t, s, tid); return st["dormant"] == "error" && st["resumable"] == true })
		})
	}
}
