package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/domain/run"
)

// RUN_RECOVERY_SRS — 데몬이 죽은 뒤 Run 복구.

// TC-RRC-4: 판정 1~6 (정적). 처음 걸린 사유가 나온다.
func TestRecoverStatic(t *testing.T) {
	ok := recoverTarget{toolID: "T", agent: "claude", sessionID: "S"}
	with := func(f func(*recoverTarget)) recoverTarget { c := ok; f(&c); return c }
	cases := []struct {
		name string
		t    recoverTarget
		live bool
		want string
	}{
		{"끝난 멤버", with(func(c *recoverTarget) { c.ended = true; c.toolID = "" }), true, reasonEnded},
		{"도구 id 없음", with(func(c *recoverTarget) { c.toolID = ""; c.agent = "" }), true, reasonNoTool},
		{"도구 죽음", ok, false, reasonNoTool},
		{"에이전트 모름", with(func(c *recoverTarget) { c.agent = ""; c.sessionID = "" }), true, reasonNoAgent},
		{"등록부에 없는 에이전트", with(func(c *recoverTarget) { c.agent = "없는것" }), true, reasonNoResume},
		{"재개 미확인(codex)", with(func(c *recoverTarget) { c.agent = "codex"; c.sessionID = "" }), true, reasonNoResume},
		{"세션 없음", with(func(c *recoverTarget) { c.sessionID = "" }), true, reasonNoSession},
		{"세션 형식", with(func(c *recoverTarget) { c.sessionID = "a;b" }), true, reasonBadSession},
		{"통과", ok, true, ""},
	}
	for _, c := range cases {
		if _, got := recoverStatic(c.t, c.live); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

// TC-RRC-4·5: 판정 7~10 (동적). 강제는 판정 불가만 넘는다.
func TestRecoverDynamic(t *testing.T) {
	cases := []struct {
		name       string
		regOK      bool
		shell      toolhub.ShellState
		force      bool
		want       string
		needsForce bool
	}{
		{"등록부 모름", false, toolhub.ShellIdle, false, reasonUnknown, true},
		{"셸 모름", true, toolhub.ShellUnknown, false, reasonUnknown, true},
		{"이 셸에서 돈다", true, toolhub.ShellHere, false, reasonRunningHere, false},
		{"다른 곳에서 돈다", true, toolhub.ShellElsewhere, false, reasonRunningElsewhere, false},
		{"셸 점유", true, toolhub.ShellBusy, false, reasonBusy, false},
		{"빈 셸", true, toolhub.ShellIdle, false, "", false},
		{"강제 + 셸 모름", true, toolhub.ShellUnknown, true, "", false},
		{"강제 + 등록부 모름 + 빈 셸", false, toolhub.ShellIdle, true, "", false},
		{"강제여도 점유는 건너뜀", false, toolhub.ShellBusy, true, reasonBusy, false},
		{"강제여도 이 셸에서 돌면 건너뜀", true, toolhub.ShellHere, true, reasonRunningHere, false},
		{"강제여도 다른 곳에서 돌면 건너뜀", true, toolhub.ShellElsewhere, true, reasonRunningElsewhere, false},
	}
	for _, c := range cases {
		got, nf := recoverDynamic(c.regOK, c.shell, c.force)
		if got != c.want || nf != c.needsForce {
			t.Errorf("%s: got %q/%v want %q/%v", c.name, got, nf, c.want, c.needsForce)
		}
	}
}

// recoverFixture 는 조정자(tool-a) 와 멤버 셋(tool-c·tool-d·tool-e)의 Run 이다.
// 세션 등록부는 임시 폴더이고, 셸 판정은 도구마다 정한 값이다.
type recoverFixture struct {
	s      *Server
	store  *run.Store
	io     *fakeToolIO
	runID  string
	member map[string]string // role → member id
	shell  map[string]toolhub.ShellState
	probed map[string][]int
	reg    string
}

func newRecoverFixture(t *testing.T) *recoverFixture {
	t.Helper()
	s, m, store, _ := runsServer(t, "tool-a")
	io := s.ToolIO.(*fakeToolIO)
	for _, id := range []string{"tool-c", "tool-d", "tool-e"} {
		m.Adopt(&toolhub.Tool{ID: id})
		io.setHas(id, true)
		s.WorkIndex.(*fakeWorkIndex).resolve[id] = id
	}
	f := &recoverFixture{s: s, store: store, io: io, member: map[string]string{},
		shell: map[string]toolhub.ShellState{}, probed: map[string][]int{}, reg: t.TempDir()}
	s.runAux.recoverProbe = func(toolID string, pids []int) toolhub.ShellState {
		f.probed[toolID] = pids
		if st, ok := f.shell[toolID]; ok {
			return st
		}
		return toolhub.ShellIdle
	}
	s.runAux.recoverDirs = func() []string { return []string{f.reg} }
	f.runID = startRun(t, s)
	for role, tool := range map[string]string{"c": "tool-c", "d": "tool-d", "e": "tool-e"} {
		code, out := postRun(t, s, "/api/runs/members",
			`{"runId":`+testpath.JSONQuote(f.runID)+`,"role":"`+role+`","agent":"claude","id":"`+tool+`"}`)
		if code != http.StatusOK {
			t.Fatalf("멤버 등록 %d %+v", code, out)
		}
		f.member[role], _ = out["id"].(string)
	}
	pol := run.DefaultContextPolicy()
	store.ObserveContext("tool-a", run.ContextObservation{SessionID: "coord-s", Agent: "claude"}, pol)
	store.ObserveContext("tool-c", run.ContextObservation{SessionID: "c-s"}, pol)
	store.ObserveContext("tool-d", run.ContextObservation{SessionID: "d-s"}, pol)
	// tool-e 는 세션 id 가 없다.
	return f
}

func (f *recoverFixture) register(t *testing.T, pid, session string) {
	t.Helper()
	dir := filepath.Join(f.reg, "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, pid+".json"), []byte(`{"pid":`+pid+`,"sessionId":"`+session+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func resultsByTool(t *testing.T, out map[string]any) map[string]map[string]any {
	t.Helper()
	list, _ := out["results"].([]any)
	got := map[string]map[string]any{}
	for _, r := range list {
		row, _ := r.(map[string]any)
		id, _ := row["toolId"].(string)
		got[id] = row
	}
	return got
}

// TC-RRC-4·7: Run 단위 복구는 필요한 것만 재개하고, 재개가 있으면 run_changed 를 한 번 보낸다.
func TestApiRunRecover_RunWide(t *testing.T) {
	f := newRecoverFixture(t)
	fb := &fakeCommandBroker{}
	f.s.Commands = fb
	f.shell["tool-d"] = toolhub.ShellBusy
	f.register(t, "4242", "c-s")

	code, out := postRun(t, f.s, "/api/runs/recover", `{"runId":`+testpath.JSONQuote(f.runID)+`}`)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d %+v", code, out)
	}
	got := resultsByTool(t, out)
	if len(got) != 4 {
		t.Fatalf("대상은 조정자 + 멤버 셋이다: %+v", out)
	}
	if got["tool-a"]["target"] != "coordinator" || got["tool-a"]["outcome"] != "resumed" {
		t.Fatalf("조정자: %+v", got["tool-a"])
	}
	if got["tool-c"]["outcome"] != "resumed" {
		t.Fatalf("tool-c: %+v", got["tool-c"])
	}
	// 등록부에 c-s 의 pid 가 있으므로 판정기에 그 pid 가 넘어가야 한다.
	if pids := f.probed["tool-c"]; len(pids) != 1 || pids[0] != 4242 {
		t.Fatalf("세션 등록부의 pid 가 판정기로 넘어가지 않았다: %v", pids)
	}
	if got["tool-d"]["reason"] != reasonBusy || got["tool-e"]["reason"] != reasonNoSession {
		t.Fatalf("d=%+v e=%+v", got["tool-d"], got["tool-e"])
	}
	// 재개한 것은 조정자와 tool-c 둘이다. 조정자 줄에는 멤버 인자가 없다.
	pastes := map[string]string{}
	for _, p := range f.io.pastes {
		if !p.Submit {
			t.Fatalf("재개줄은 실행까지 해야 한다: %+v", p)
		}
		pastes[p.ToolID] = p.Text
	}
	if len(pastes) != 2 {
		t.Fatalf("넣은 곳 = %v", pastes)
	}
	if !strings.Contains(pastes["tool-a"], "--resume") || strings.Contains(pastes["tool-a"], "allowedTools") {
		t.Fatalf("조정자 재개줄 = %q", pastes["tool-a"])
	}
	if !strings.Contains(pastes["tool-c"], "c-s") || !strings.Contains(pastes["tool-c"], "allowedTools") {
		t.Fatalf("멤버 재개줄 = %q", pastes["tool-c"])
	}
	if n := runChangedCount(fb); n != 1 {
		t.Fatalf("run_changed = %d, want 1", n)
	}
}

// TC-RRC-7: 재개한 대상이 없으면 run_changed 를 보내지 않는다.
func TestApiRunRecover_NoResumeNoBroadcast(t *testing.T) {
	f := newRecoverFixture(t)
	for _, id := range []string{"tool-a", "tool-c", "tool-d"} {
		f.shell[id] = toolhub.ShellHere
	}
	fb := &fakeCommandBroker{}
	f.s.Commands = fb
	code, out := postRun(t, f.s, "/api/runs/recover", `{"runId":`+testpath.JSONQuote(f.runID)+`}`)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d %+v", code, out)
	}
	if got := resultsByTool(t, out)["tool-c"]; got["reason"] != reasonRunningHere {
		t.Fatalf("tool-c = %+v", got)
	}
	if len(f.io.pastes) != 0 || runChangedCount(fb) != 0 {
		t.Fatalf("넣음 %d 방송 %d", len(f.io.pastes), runChangedCount(fb))
	}
}

// TC-RRC-5: 대상 하나 — 판정 불가는 needsForce, 강제면 재개.
func TestApiRunRecover_SingleNeedsForce(t *testing.T) {
	f := newRecoverFixture(t)
	f.shell["tool-c"] = toolhub.ShellUnknown
	body := `{"runId":` + testpath.JSONQuote(f.runID) + `,"memberId":` + testpath.JSONQuote(f.member["c"])
	code, out := postRun(t, f.s, "/api/runs/recover", body+`}`)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d %+v", code, out)
	}
	got := resultsByTool(t, out)
	if len(got) != 1 || got["tool-c"]["reason"] != reasonUnknown || got["tool-c"]["needsForce"] != true {
		t.Fatalf("got %+v", got)
	}
	_, out = postRun(t, f.s, "/api/runs/recover", body+`,"force":true}`)
	if got := resultsByTool(t, out)["tool-c"]; got["outcome"] != "resumed" {
		t.Fatalf("강제: %+v", got)
	}
	// 조정자 하나.
	_, out = postRun(t, f.s, "/api/runs/recover", `{"runId":`+testpath.JSONQuote(f.runID)+`,"coordinator":true}`)
	if got := resultsByTool(t, out); len(got) != 1 || got["tool-a"]["target"] != "coordinator" {
		t.Fatalf("조정자 하나: %+v", got)
	}
}

// TC-RRC-6: 요청 오류와 닫힌 Run.
func TestApiRunRecover_Errors(t *testing.T) {
	f := newRecoverFixture(t)
	id := testpath.JSONQuote(f.runID)
	cases := []struct {
		body string
		want int
	}{
		{`{"runId":` + id + `,"force":true}`, http.StatusBadRequest},
		{`{"runId":` + id + `,"coordinator":true,"memberId":` + testpath.JSONQuote(f.member["c"]) + `}`, http.StatusBadRequest},
		{`{"runId":` + id + `,"memberId":"없음"}`, http.StatusNotFound},
		{`{"runId":"없음"}`, http.StatusNotFound},
	}
	for _, c := range cases {
		if code, out := postRun(t, f.s, "/api/runs/recover", c.body); code != c.want {
			t.Errorf("%s: got %d want %d (%+v)", c.body, code, c.want, out)
		}
	}
	// API 의 닫기는 정리 뒤 기록을 지울 수 있으므로 저장소에서 바로 닫는다.
	if _, _, err := f.store.Close(f.runID, true); err != nil {
		t.Fatalf("close: %v", err)
	}
	if code, out := postRun(t, f.s, "/api/runs/recover", `{"runId":`+id+`}`); code != http.StatusConflict {
		t.Fatalf("닫힌 Run: got %d (%+v)", code, out)
	}
}

// TC-RRC-10: 보기의 recoverable 은 판정 1~6 이다.
func TestApiRunView_Recoverable(t *testing.T) {
	f := newRecoverFixture(t)
	_, out := getRun(t, f.s, "/api/runs?id="+f.runID)
	if out["coordinatorRecoverable"] != true {
		t.Fatalf("조정자: %+v", out["coordinatorRecoverable"])
	}
	members := memberMap(t, out)
	if members["c"]["recoverable"] != true || members["e"]["recoverable"] == true {
		t.Fatalf("c=%v e=%v", members["c"]["recoverable"], members["e"]["recoverable"])
	}
}

// TC-RRC-10: 대시보드는 /graph 로 그린다 — 거기에도 복구 버튼의 근거가 실려야 한다.
func TestApiRunGraph_Recoverable(t *testing.T) {
	f := newRecoverFixture(t)
	_, out := getRun(t, f.s, "/api/runs/"+f.runID+"/graph")
	if out["coordinatorRecoverable"] != true || out["coordinatorAgent"] != "claude" {
		t.Fatalf("조정자: rec=%v agent=%v", out["coordinatorRecoverable"], out["coordinatorAgent"])
	}
	members := memberMap(t, out)
	if members["c"]["recoverable"] != true || members["e"]["recoverable"] == true {
		t.Fatalf("c=%v e=%v", members["c"]["recoverable"], members["e"]["recoverable"])
	}
}

// TC-RRC-10 (FR-RRC-31): 트리 노드도 복구 버튼의 근거를 싣는다 — 트리는 여러 Run 에 걸친다.
func TestRunsTree_Recoverable(t *testing.T) {
	s, _, store, _ := runsServer(t, "tool-a")
	_, root := postRun(t, s, "/api/runs", `{"objective":"t","projection":"dedicated-window","tree":"o/r#7"}`)
	postRun(t, s, "/api/runs/members", `{"runId":"`+root["id"].(string)+`","role":"ccr#7","agent":"claude","assign":{"issue":"o/r#7"},"id":"tab-a"}`)
	postRun(t, s, "/api/runs/members", `{"runId":"`+root["id"].(string)+`","role":"ccr#7›8","agent":"claude","assign":{"issue":"o/r#8"},"id":"tab-b"}`)
	store.ObserveContext("tool-b", run.ContextObservation{SessionID: "b-s"}, run.DefaultContextPolicy())
	_, out := getRun(t, s, "/api/runs/tree?ref=o/r%237")
	nodes, _ := out["nodes"].([]any)
	by := map[string]map[string]any{}
	for _, n := range nodes {
		m := n.(map[string]any)
		by[m["role"].(string)] = m
	}
	if by["ccr#7›8"]["recoverable"] != true || by["ccr#7"]["recoverable"] == true {
		t.Fatalf("nodes=%v", nodes)
	}
}

// 리뷰 지적 1: 재개줄을 넣은 도구는 잠시 다시 넣지 않는다 — 에이전트가 뜨기 전의 두 번째
// 요청도 셸을 비었다고 볼 수 있기 때문이다.
func TestApiRunRecover_NoDoubleResume(t *testing.T) {
	f := newRecoverFixture(t)
	body := `{"runId":` + testpath.JSONQuote(f.runID) + `}`
	postRun(t, f.s, "/api/runs/recover", body)
	if len(f.io.pastes) != 3 {
		t.Fatalf("첫 복구 넣음 = %d, want 3 (조정자·c·d)", len(f.io.pastes))
	}
	_, out := postRun(t, f.s, "/api/runs/recover", body)
	got := resultsByTool(t, out)
	for _, id := range []string{"tool-a", "tool-c", "tool-d"} {
		if got[id]["reason"] != reasonRecovering {
			t.Errorf("%s: %+v", id, got[id])
		}
	}
	if len(f.io.pastes) != 3 {
		t.Fatalf("두 번째 복구가 다시 넣었다: %d", len(f.io.pastes))
	}
}

// 리뷰 지적 5·9: Run 단위 복구는 needsForce 를 싣지 않고, 설정 폴더 목록은 요청마다 한 번만 만든다.
func TestApiRunRecover_RunWideUnknownHasNoForceHint(t *testing.T) {
	f := newRecoverFixture(t)
	calls := 0
	f.s.runAux.recoverDirs = func() []string { calls++; return []string{f.reg} }
	f.shell["tool-c"] = toolhub.ShellUnknown
	_, out := postRun(t, f.s, "/api/runs/recover", `{"runId":`+testpath.JSONQuote(f.runID)+`}`)
	if got := resultsByTool(t, out)["tool-c"]; got["reason"] != reasonUnknown || got["needsForce"] != nil {
		t.Fatalf("tool-c = %+v", got)
	}
	if calls != 1 {
		t.Fatalf("설정 폴더 목록 = %d 번, want 1", calls)
	}
}

// 리뷰 지적 8: 조정자 도구가 없는 Run 은 조정자를 대상에 넣지 않는다.
func TestRunWideTargets_NoCoordinatorTool(t *testing.T) {
	rec := run.Record{Members: []run.Member{{ID: "m1", ToolID: "T1"}}}
	got := runWideTargets(rec)
	if len(got) != 1 || got[0].coord {
		t.Fatalf("targets = %+v", got)
	}
	rec.CoordinatorToolID = "T0"
	if got := runWideTargets(rec); len(got) != 2 || !got[0].coord {
		t.Fatalf("targets = %+v", got)
	}
}
