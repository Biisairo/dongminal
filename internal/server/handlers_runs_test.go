package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/run"
	"dongminal/internal/toolaccess"
)

// 묶음 R — Run 레코드의 서버 계층 (RUN_ORCHESTRATION_SRS §3.1, TC-RUN-5~11).

type fakeWhoAmI struct{ toolID string }

func (f *fakeWhoAmI) ResolveClientPane(string) (string, int, error) {
	if f.toolID == "" {
		return "", 0, errNoCaller
	}
	return f.toolID, 0, nil
}

var errNoCaller = &callerErr{}

type callerErr struct{}

func (*callerErr) Error() string { return "no caller" }

// runsServer wires a direct-mode Server with a Run store and the toolaccess
// fakes. caller is what the PID-chain resolver reports for every request.
func runsServer(t *testing.T, caller string) (*Server, *ToolManager, *run.Store, *fakeWhoAmI) {
	t.Helper()
	m := NewToolManager("", nil)
	io := newFakeToolIO()
	wi := &fakeWorkIndex{resolve: map[string]string{}, labels: map[string]string{}, coords: map[string]string{}}
	for _, id := range []string{"tool-a", "tool-b"} {
		p := &Tool{ID: id}
		m.mu.Lock()
		m.tools[id] = p
		m.mu.Unlock()
		io.setHas(id, true)
		wi.resolve[id] = id
	}
	wi.resolve["tab-a"] = "tool-a"
	wi.resolve["tab-b"] = "tool-b"
	wi.entries = []toolaccess.WorkspaceEntry{
		{ToolID: "tool-a", TabUUID: "tab-a", Label: "W1.P1.T1"},
		{ToolID: "tool-b", TabUUID: "tab-b", Label: "W1.P2.T1"},
	}

	store := run.NewStore(t.TempDir(), "epoch-test")
	if err := store.Load(); err != nil {
		t.Fatalf("store load: %v", err)
	}
	who := &fakeWhoAmI{toolID: caller}
	return &Server{Tools: m, ToolIO: io, WorkIndex: wi, Runs: store, WhoAmI: who}, m, store, who
}

func postRun(t *testing.T, s *Server, path, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	s.Handler().ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func getRun(t *testing.T, s *Server, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func startRun(t *testing.T, s *Server) string {
	t.Helper()
	code, out := postRun(t, s, "/api/runs", `{"objective":"팬아웃","projection":"dedicated-window","isolation":"none"}`)
	if code != http.StatusOK {
		t.Fatalf("run start want 200, got %d (%+v)", code, out)
	}
	id, _ := out["id"].(string)
	if id == "" {
		t.Fatalf("run id 가 없다: %+v", out)
	}
	return id
}

// FR-RUN-1/8: 시작 응답이 조정자 도구까지 담는다.
func TestApiRunStart(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	code, out := postRun(t, s, "/api/runs", `{"objective":"팬아웃","projection":"inline","isolation":"none"}`)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d (%+v)", code, out)
	}
	if out["state"] != "open" || out["projection"] != "inline" || out["isolation"] != "none" {
		t.Fatalf("Run 필드가 어긋난다: %+v", out)
	}
	if out["coordinatorToolId"] != "tool-a" {
		t.Fatalf("조정자는 발신 도구다: %+v", out)
	}
	if code, out := postRun(t, s, "/api/runs", `{"objective":"x","projection":"sideways","isolation":"none"}`); code != http.StatusBadRequest {
		t.Fatalf("알 수 없는 projection want 400, got %d (%+v)", code, out)
	}
}

// FR-RUN-2: 멤버 등록은 uuid·toolId 어느 형식으로도 도구를 지목할 수 있고,
// 탭 uuid 를 스스로 채운다 (FR-RUN-9 가 요구하는 location 의 원천이다).
func TestApiRunMember(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	runID := startRun(t, s)

	code, out := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"writer","agent":"claude","id":"tab-b"}`)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d (%+v)", code, out)
	}
	if out["toolId"] != "tool-b" || out["tabId"] != "tab-b" || out["role"] != "writer" {
		t.Fatalf("멤버 필드가 어긋난다: %+v", out)
	}
	if out["state"] != "starting" {
		t.Fatalf("새 멤버는 starting 이다: %+v", out)
	}

	// 같은 도구 재등록은 1:1 위반이다.
	if code, _ := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"other","agent":"claude","id":"tool-b"}`); code != http.StatusConflict {
		t.Fatalf("도구 중복 등록 want 409, got %d", code)
	}
	// 없는 도구.
	if code, _ := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"x","agent":"claude","id":"no-such"}`); code != http.StatusNotFound {
		t.Fatalf("없는 도구 want 404, got %d", code)
	}
	// 없는 Run.
	if code, _ := postRun(t, s, "/api/runs/members",
		`{"runId":"no-such-run","role":"x","agent":"claude","id":"tool-a"}`); code != http.StatusNotFound {
		t.Fatalf("없는 Run want 404, got %d", code)
	}
}

// FR-PRE-5/6: 보고 권한은 발신 도구다. 거부 사유는 타입으로 나온다.
func TestApiRunReport_AuthorityAndReasons(t *testing.T) {
	s, _, _, who := runsServer(t, "tool-a")
	runID := startRun(t, s)
	_, member := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"writer","agent":"claude","id":"tool-a"}`)
	memberID, _ := member["id"].(string)

	// 멤버가 아닌 도구의 보고.
	who.toolID = "tool-b"
	code, out := postRun(t, s, "/api/runs/report", `{"outcome":"succeeded","summary":"했다"}`)
	if code != http.StatusForbidden || out["error"] != "sender_not_member" {
		t.Fatalf("비멤버 보고 want 403/sender_not_member, got %d (%+v)", code, out)
	}

	// 남의 memberId 를 알고 있어도 자기 정체로만 보고된다.
	code, out = postRun(t, s, "/api/runs/report",
		`{"memberId":"`+memberID+`","outcome":"succeeded","summary":"했다"}`)
	if code != http.StatusForbidden {
		t.Fatalf("남의 memberId 로 보고 want 403, got %d (%+v)", code, out)
	}

	// 정당한 보고.
	who.toolID = "tool-a"
	code, out = postRun(t, s, "/api/runs/report",
		`{"runId":"`+runID+`","memberId":"`+memberID+`","outcome":"succeeded","summary":"했다. 봤다. 남았다.","files":["a.go","b.go"]}`)
	if code != http.StatusOK || out["state"] != "done" {
		t.Fatalf("정당한 보고가 거부됐다: %d (%+v)", code, out)
	}
	// 재보고.
	code, out = postRun(t, s, "/api/runs/report", `{"outcome":"succeeded","summary":"또"}`)
	if code != http.StatusConflict || out["error"] != "member_already_reported" {
		t.Fatalf("재보고 want 409/member_already_reported, got %d (%+v)", code, out)
	}
	// outcome 누락.
	who.toolID = "tool-b"
	_, _ = postRun(t, s, "/api/runs/members", `{"runId":"`+runID+`","role":"r2","agent":"claude","id":"tool-b"}`)
	if code, out := postRun(t, s, "/api/runs/report", `{"summary":"결과만"}`); code != http.StatusBadRequest {
		t.Fatalf("outcome 누락 want 400, got %d (%+v)", code, out)
	}
}

// FR-PRE-5: PID 체인이 답하지 못하면 호출자가 제시한 toolId 로 내려간다
// (daemon 모드의 정상 경로다).
func TestApiRunReport_FallsBackToClaimedToolID(t *testing.T) {
	s, _, _, who := runsServer(t, "")
	who.toolID = "" // resolver 가 실패한다
	runID := startRun(t, s)
	_, _ = postRun(t, s, "/api/runs/members", `{"runId":"`+runID+`","role":"w","agent":"claude","id":"tool-a"}`)

	code, out := postRun(t, s, "/api/runs/report", `{"toolId":"tool-a","outcome":"succeeded","summary":"ok"}`)
	if code != http.StatusOK {
		t.Fatalf("claimed toolId 폴백이 실패했다: %d (%+v)", code, out)
	}
}

// TC-RUN-5 (FR-RUN-6): 도구가 죽으면 그 멤버는 lost 다. 상태는 조회 시점 파생이다.
func TestApiRunStatus_DerivesMemberState(t *testing.T) {
	s, m, _, _ := runsServer(t, "tool-a")
	runID := startRun(t, s)
	_, _ = postRun(t, s, "/api/runs/members", `{"runId":"`+runID+`","role":"a","agent":"claude","id":"tool-a"}`)
	_, _ = postRun(t, s, "/api/runs/members", `{"runId":"`+runID+`","role":"b","agent":"claude","id":"tool-b"}`)

	// 훅 상태를 넣으면 그대로 파생된다.
	m.Get("tool-a").setActivity("working", "Bash", "go test")
	m.Get("tool-b").setActivity("waiting", "", "")

	code, out := getRun(t, s, "/api/runs?id="+runID)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	members := memberMap(t, out)
	if members["a"]["state"] != "working" || members["b"]["state"] != "waiting" {
		t.Fatalf("훅 상태가 멤버 상태로 파생되지 않았다: %+v", members)
	}

	// 도구가 사라지면 lost.
	s.ToolIO.(*fakeToolIO).setHas("tool-b", false)
	_, out = getRun(t, s, "/api/runs?id="+runID)
	members = memberMap(t, out)
	if members["b"]["state"] != "lost" {
		t.Fatalf("죽은 도구의 멤버는 lost 여야 한다: %+v", members["b"])
	}
	// 보고한 멤버는 관측이 아니라 기록이 이긴다.
	m.Get("tool-a").setActivity("working", "", "")
	_, _ = postRun(t, s, "/api/runs/report", `{"outcome":"succeeded","summary":"끝"}`)
	_, out = getRun(t, s, "/api/runs?id="+runID)
	members = memberMap(t, out)
	if members["a"]["state"] != "done" {
		t.Fatalf("보고한 멤버가 관측에 덮였다: %+v", members["a"])
	}
}

func memberMap(t *testing.T, out map[string]any) map[string]map[string]any {
	t.Helper()
	raw, ok := out["members"].([]any)
	if !ok {
		t.Fatalf("members 가 없다: %+v", out)
	}
	byRole := map[string]map[string]any{}
	for _, it := range raw {
		m, _ := it.(map[string]any)
		role, _ := m["role"].(string)
		byRole[role] = m
	}
	return byRole
}

// TC-RUN-10 (FR-RUN-11): 미보고 멤버가 있으면 close 는 거부하고 목록을 낸다.
func TestApiRunClose_GuardAndCleanupList(t *testing.T) {
	s, _, _, who := runsServer(t, "tool-a")
	runID := startRun(t, s)
	_, _ = postRun(t, s, "/api/runs/members", `{"runId":"`+runID+`","role":"a","agent":"claude","id":"tool-a"}`)
	_, _ = postRun(t, s, "/api/runs/members", `{"runId":"`+runID+`","role":"b","agent":"claude","id":"tool-b"}`)
	_, _ = postRun(t, s, "/api/runs/report", `{"outcome":"succeeded","summary":"ok"}`)

	code, out := postRun(t, s, "/api/runs/close", `{"runId":"`+runID+`"}`)
	if code != http.StatusConflict || out["error"] != "unreported_members" {
		t.Fatalf("미보고 멤버 close want 409/unreported_members, got %d (%+v)", code, out)
	}
	pend, _ := out["unreported"].([]any)
	if len(pend) != 1 {
		t.Fatalf("거부는 미보고 목록을 내야 한다: %+v", out)
	}

	// force 는 통과하고, 정리 대상을 돌려준다 — 실제 탭 닫기는 조정자의 몫이다
	// (실행 중 도구를 서버가 닫으면 브라우저가 확인창을 띄운다, FR-BG-3).
	who.toolID = "tool-a"
	code, out = postRun(t, s, "/api/runs/close", `{"runId":"`+runID+`","force":true}`)
	if code != http.StatusOK || out["state"] != "closed" {
		t.Fatalf("force close 실패: %d (%+v)", code, out)
	}
	cleanup, _ := out["cleanup"].([]any)
	if len(cleanup) != 2 {
		t.Fatalf("정리 대상 2건이어야 한다: %+v", out)
	}
	first, _ := cleanup[0].(map[string]any)
	if first["tabId"] == nil || first["toolId"] == nil {
		t.Fatalf("정리 대상은 tabId·toolId 를 담아야 한다: %+v", first)
	}
}

// FR-RUN-8: 목록은 최근 것이 앞이며 멤버 요약을 담는다.
func TestApiRunList(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	first := startRun(t, s)
	second := startRun(t, s)

	code, out := getRun(t, s, "/api/runs")
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	runs, _ := out["runs"].([]any)
	if len(runs) != 2 {
		t.Fatalf("Run 2건이어야 한다: %+v", out)
	}
	r0, _ := runs[0].(map[string]any)
	r1, _ := runs[1].(map[string]any)
	if r0["id"] != second || r1["id"] != first {
		t.Fatalf("최근 Run 이 앞이어야 한다: %+v", runs)
	}
}

// NFR-RUN-1/2: Run 스토어가 없는 wiring 은 503 이며 nil 역참조가 아니다.
func TestApiRuns_MissingStoreIs503(t *testing.T) {
	s := &Server{}
	if code, _ := getRun(t, s, "/api/runs"); code != http.StatusServiceUnavailable {
		t.Fatalf("list want 503, got %d", code)
	}
	if code, _ := postRun(t, s, "/api/runs", `{"objective":"x","projection":"inline","isolation":"none"}`); code != http.StatusServiceUnavailable {
		t.Fatalf("start want 503, got %d", code)
	}
}

// FR-RUN-7: 멤버 등록은 탭에 runId 를, 전용 창에 ownerRunId 를 남긴다.
// 워크스페이스의 쓰기 주체는 브라우저이므로 이 표식은 best-effort 이며,
// 실패해도 등록 자체는 성공해야 한다 (NFR-RUN-3).
func TestApiRunMember_MarksWorkspaceBestEffort(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	ws := newFakeWorkspaceStore()
	ws.raw = []byte(`{"schemaVersion":2,"windows":[{"id":"win-1","layout":{"type":"pane","id":"p1","tabs":[{"id":"tab-a","name":"Shell","toolId":"tool-a"}]}}]}`)
	s.Work = ws

	code, out := postRun(t, s, "/api/runs", `{"objective":"x","projection":"dedicated-window","isolation":"none","windowId":"win-1"}`)
	if code != http.StatusOK {
		t.Fatalf("start: %d (%+v)", code, out)
	}
	runID, _ := out["id"].(string)
	if code, out := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"a","agent":"claude","id":"tab-a"}`); code != http.StatusOK {
		t.Fatalf("member: %d (%+v)", code, out)
	}

	var got map[string]any
	if err := json.Unmarshal(ws.raw, &got); err != nil {
		t.Fatalf("workspace 파싱: %v", err)
	}
	wins, _ := got["windows"].([]any)
	w0, _ := wins[0].(map[string]any)
	if w0["ownerRunId"] != runID {
		t.Fatalf("전용 창에 ownerRunId 가 없다: %+v", w0)
	}
	layout, _ := w0["layout"].(map[string]any)
	tabs, _ := layout["tabs"].([]any)
	t0, _ := tabs[0].(map[string]any)
	if t0["runId"] != runID {
		t.Fatalf("탭에 runId 가 없다: %+v", t0)
	}
	// 표식은 기존 필드를 보존해야 한다 — 브라우저가 쓴 미지의 키를 지우면 안 된다.
	if t0["name"] != "Shell" || t0["toolId"] != "tool-a" {
		t.Fatalf("표식이 기존 필드를 훼손했다: %+v", t0)
	}

	// close 는 표식을 되돌린다.
	_, _ = postRun(t, s, "/api/runs/report", `{"outcome":"succeeded","summary":"ok"}`)
	if code, out := postRun(t, s, "/api/runs/close", `{"runId":"`+runID+`"}`); code != http.StatusOK {
		t.Fatalf("close: %d (%+v)", code, out)
	}
	_ = json.Unmarshal(ws.raw, &got)
	wins, _ = got["windows"].([]any)
	w0, _ = wins[0].(map[string]any)
	if _, still := w0["ownerRunId"]; still {
		t.Fatalf("close 후에도 ownerRunId 가 남았다: %+v", w0)
	}
	layout, _ = w0["layout"].(map[string]any)
	tabs, _ = layout["tabs"].([]any)
	t0, _ = tabs[0].(map[string]any)
	if _, still := t0["runId"]; still {
		t.Fatalf("close 후에도 runId 가 남았다: %+v", t0)
	}
}

// FR-RUN-7 / NFR-RUN-3: 워크스페이스가 없어도(표식을 쓸 곳이 없어도) 등록은 성공한다.
func TestApiRunMember_WorksWithoutWorkspaceStore(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	s.Work = nil
	runID := startRun(t, s)
	if code, out := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"a","agent":"claude","id":"tool-a"}`); code != http.StatusOK {
		t.Fatalf("workspace 없이 멤버 등록 실패: %d (%+v)", code, out)
	}
}
