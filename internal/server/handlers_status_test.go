package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"dongminal/internal/toolaccess"
)

// 묶음 S — 상태·대기 계약 (RUN_ORCHESTRATION_SRS §3.2, TC-STA-1~8).

// statusServer wires a direct-mode Server (ToolManager) with the toolaccess
// fakes so /api/tools/activity/{get,wait} can resolve and check liveness.
func statusServer(t *testing.T) (*Server, *ToolManager, *Tool) {
	t.Helper()
	m := NewToolManager("", nil)
	p := &Tool{ID: "p1"}
	m.mu.Lock()
	m.tools["p1"] = p
	m.mu.Unlock()

	io := newFakeToolIO()
	io.setHas("p1", true)
	wi := &fakeWorkIndex{
		resolve: map[string]string{
			"p1":                                   "p1",
			"W1.P1.T1":                             "p1",
			"aaaaaaaa-1111-2222-3333-444444444444": "p1",
		},
		labels: map[string]string{"p1": "W1.P1.T1"},
		coords: map[string]string{},
	}
	return &Server{Tools: m, ToolIO: io, WorkIndex: wi}, m, p
}

func getStatus(t *testing.T, s *Server, query string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiToolStatus(rec, httptest.NewRequest(http.MethodGet, "/api/tools/activity/get?"+query, nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func getWait(t *testing.T, s *Server, query string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiToolStatusWait(rec, httptest.NewRequest(http.MethodGet, "/api/tools/activity/wait?"+query, nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// TC-STA-1 (FR-STA-1): 훅이 보고한 상태를 그대로 낸다.
func TestApiToolStatus_ReportedActivity(t *testing.T) {
	s, _, p := statusServer(t)
	p.setActivity("working", "Bash", "go test ./...")

	code, out := getStatus(t, s, "id=p1")
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if out["state"] != "working" || out["tool"] != "Bash" || out["detail"] != "go test ./..." {
		t.Fatalf("activity not reported: %+v", out)
	}
	if out["live"] != true {
		t.Fatalf("live tool must report live=true: %+v", out)
	}
	if out["toolId"] != "p1" {
		t.Fatalf("toolId must be the resolved tool: %+v", out)
	}
}

// FR-API-4 승계: uuid·라벨·toolId 를 모두 받는다.
func TestApiToolStatus_ResolvesEveryIdentifierForm(t *testing.T) {
	s, _, p := statusServer(t)
	p.setActivity("idle", "", "startup")

	for _, id := range []string{"p1", "W1.P1.T1", "aaaaaaaa-1111-2222-3333-444444444444"} {
		code, out := getStatus(t, s, "id="+id)
		if code != http.StatusOK || out["state"] != "idle" {
			t.Fatalf("id=%s → code=%d out=%+v", id, code, out)
		}
	}
	if code, _ := getStatus(t, s, "id=nope"); code != http.StatusNotFound {
		t.Fatalf("unknown identifier want 404, got %d", code)
	}
	if code, _ := getStatus(t, s, ""); code != http.StatusBadRequest {
		t.Fatalf("missing id want 400, got %d", code)
	}
}

// TC-STA-2 (FR-STA-1): 활동 보고가 없는 도구는 unknown 이며 오류가 아니다.
func TestApiToolStatus_UnknownWhenNeverReported(t *testing.T) {
	s, _, _ := statusServer(t)
	code, out := getStatus(t, s, "id=p1")
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if out["state"] != "unknown" {
		t.Fatalf("never-reported tool must be unknown, got %+v", out)
	}
}

// TC-STA-3 (FR-STA-2/4): working → idle 전이 시점에 ready 로 풀린다.
func TestApiToolStatusWait_ReadyOnTransition(t *testing.T) {
	s, _, p := statusServer(t)
	p.setActivity("working", "", "")

	go func() {
		time.Sleep(120 * time.Millisecond)
		p.setActivity("idle", "", "")
	}()

	start := time.Now()
	code, out := getWait(t, s, "id=p1&for=ready&timeoutMs=5000")
	if code != http.StatusOK || out["status"] != "ready" {
		t.Fatalf("want ready, got code=%d out=%+v", code, out)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("wait should resolve near the transition, took %v", elapsed)
	}
}

// TC-STA-4 (FR-STA-5): waiting(권한 확인 대기)은 준비완료가 아니다 — 즉시 blocked.
func TestApiToolStatusWait_WaitingIsBlockedImmediately(t *testing.T) {
	s, _, p := statusServer(t)
	p.setActivity("waiting", "", "")

	start := time.Now()
	code, out := getWait(t, s, "id=p1&for=ready&timeoutMs=60000")
	if code != http.StatusOK || out["status"] != "blocked" {
		t.Fatalf("want blocked, got code=%d out=%+v", code, out)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("blocked must return immediately, took %v", elapsed)
	}
	if out["state"] != "waiting" {
		t.Fatalf("blocked result must carry the observed state: %+v", out)
	}
}

// FR-STA-5 는 --for done 에도 적용된다 — 권한 대기는 시간이 지난다고 풀리지 않는다.
func TestApiToolStatusWait_WaitingBlocksDoneToo(t *testing.T) {
	s, _, p := statusServer(t)
	p.setActivity("waiting", "", "")
	if _, out := getWait(t, s, "id=p1&for=done&timeoutMs=60000"); out["status"] != "blocked" {
		t.Fatalf("want blocked for --for done, got %+v", out)
	}
}

// TC-STA-5 (FR-STA-6/7): 타임아웃은 실패가 아니다 — 마지막 관측 상태를 함께 낸다.
func TestApiToolStatusWait_TimeoutReportsLastObservation(t *testing.T) {
	s, _, p := statusServer(t)
	p.setActivity("working", "Bash", "sleep 600")
	p.lastOutputAt.Store(time.Now().UnixNano())

	code, out := getWait(t, s, "id=p1&for=ready&timeoutMs=150")
	if code != http.StatusOK || out["status"] != "timeout" {
		t.Fatalf("want timeout, got code=%d out=%+v", code, out)
	}
	if out["state"] != "working" {
		t.Fatalf("timeout must carry last observed state: %+v", out)
	}
	if _, ok := out["lastOutputAt"]; !ok {
		t.Fatalf("timeout must carry lastOutputAt: %+v", out)
	}
	if _, ok := out["waitedMs"]; !ok {
		t.Fatalf("timeout must carry waitedMs: %+v", out)
	}
}

// TC-STA-6 (FR-STA-4 3단계): 훅 상태가 없으면 출력 정적(3초)으로 ready 를 판정한다.
func TestApiToolStatusWait_QuiescenceReady(t *testing.T) {
	s, _, p := statusServer(t)
	p.lastOutputAt.Store(time.Now().Add(-4 * time.Second).UnixNano())

	code, out := getWait(t, s, "id=p1&for=ready&timeoutMs=500")
	if code != http.StatusOK || out["status"] != "ready" {
		t.Fatalf("quiet tool must be ready, got code=%d out=%+v", code, out)
	}
	if out["reason"] != "quiescence" {
		t.Fatalf("ready by quiescence must say so: %+v", out)
	}
}

// FR-STA-4: 아직 조용하지 않으면 ready 가 아니다 (거짓 통과 방지 — 함정 10).
func TestApiToolStatusWait_NotQuietYetIsNotReady(t *testing.T) {
	s, _, p := statusServer(t)
	p.lastOutputAt.Store(time.Now().UnixNano())

	if _, out := getWait(t, s, "id=p1&for=ready&timeoutMs=150"); out["status"] != "timeout" {
		t.Fatalf("a tool that just printed must not be ready, got %+v", out)
	}
}

// FR-STA-4: 정적 폴백은 ready 전용이다. 완료(done)를 출력 침묵으로 추론하지 않는다.
func TestApiToolStatusWait_QuiescenceNeverImpliesDone(t *testing.T) {
	s, _, p := statusServer(t)
	p.lastOutputAt.Store(time.Now().Add(-10 * time.Second).UnixNano())

	if _, out := getWait(t, s, "id=p1&for=done&timeoutMs=150"); out["status"] != "timeout" {
		t.Fatalf("silence must not be read as done, got %+v", out)
	}
}

// FR-STA-2: --for done 은 done 보고에서만 풀린다. idle 은 완료가 아니다.
func TestApiToolStatusWait_DoneCondition(t *testing.T) {
	s, _, p := statusServer(t)
	p.setActivity("idle", "", "")
	if _, out := getWait(t, s, "id=p1&for=done&timeoutMs=150"); out["status"] != "timeout" {
		t.Fatalf("idle must not satisfy --for done, got %+v", out)
	}
	p.setActivity("done", "", "")
	if _, out := getWait(t, s, "id=p1&for=done&timeoutMs=5000"); out["status"] != "done" {
		t.Fatalf("done report must satisfy --for done, got %+v", out)
	}
}

// FR-STA-2: 대기 중 도구가 사라지면 gone 이다 (타임아웃까지 매달리지 않는다).
func TestApiToolStatusWait_ToolDisappears(t *testing.T) {
	s, _, p := statusServer(t)
	p.setActivity("working", "", "")
	io := s.ToolIO.(*fakeToolIO)

	go func() {
		time.Sleep(120 * time.Millisecond)
		io.setHas("p1", false)
	}()

	code, out := getWait(t, s, "id=p1&for=ready&timeoutMs=5000")
	if code != http.StatusOK || out["status"] != "gone" {
		t.Fatalf("want gone, got code=%d out=%+v", code, out)
	}
}

// FR-STA-2: 인자 검증 — for 누락·오타는 400, timeoutMs 는 상한으로 클램프한다.
func TestApiToolStatusWait_ArgumentValidation(t *testing.T) {
	s, _, _ := statusServer(t)

	if code, _ := getWait(t, s, "id=p1&timeoutMs=100"); code != http.StatusBadRequest {
		t.Fatalf("missing for want 400, got %d", code)
	}
	if code, _ := getWait(t, s, "id=p1&for=bogus"); code != http.StatusBadRequest {
		t.Fatalf("unknown for want 400, got %d", code)
	}
	if code, _ := getWait(t, s, "id=p1&for=ready&timeoutMs=abc"); code != http.StatusBadRequest {
		t.Fatalf("non-numeric timeoutMs want 400, got %d", code)
	}
	// 클램프는 조용하지 않아야 한다 — 유효 타임아웃을 응답에 싣는다.
	_, out := getWait(t, s, "id=p1&for=done&timeoutMs=1")
	if got, ok := out["timeoutMs"].(float64); !ok || int(got) != waitMinTimeoutMS {
		t.Fatalf("below-floor timeout must clamp to %d and be reported, got %+v", waitMinTimeoutMS, out)
	}
}

// TC-STA-8 (FR-STA-8): direct 모드와 daemon 모드가 같은 결과를 낸다.
func TestToolStatus_DirectDaemonParity(t *testing.T) {
	io := newFakeToolIO()
	io.setHas("p1", true)
	wi := &fakeWorkIndex{resolve: map[string]string{"p1": "p1"}, labels: map[string]string{}, coords: map[string]string{}}

	// direct: 상태는 ToolManager 의 Tool 에 있다.
	m := NewToolManager("", nil)
	dp := &Tool{ID: "p1"}
	m.mu.Lock()
	m.tools["p1"] = dp
	m.mu.Unlock()
	dp.setActivity("working", "Edit", "a.go")
	direct := &Server{Tools: m, ToolIO: io, WorkIndex: wi}

	// daemon: 상태는 AttnTracker 에 있고 Tools.Get 은 합성 Tool 을 준다.
	tracker := NewAttnTracker(NewCommandHub(), 0)
	tracker.SetActivity("p1", "working", "Edit", "a.go")
	daemon := &Server{Tools: m, ToolIO: io, WorkIndex: wi, AttnTracker: tracker}

	_, a := getStatus(t, direct, "id=p1")
	_, b := getStatus(t, daemon, "id=p1")
	for _, k := range []string{"toolId", "live", "state", "tool", "detail"} {
		if a[k] != b[k] {
			t.Fatalf("direct/daemon differ on %q: %v vs %v", k, a[k], b[k])
		}
	}
}

// FR-STA-8 의 안전망: toolaccess 의존성이 없는 wiring 은 503 이어야 한다 (nil 역참조 금지).
func TestToolStatus_MissingDepsIs503(t *testing.T) {
	s := &Server{}
	if code, _ := getStatus(t, s, "id=p1"); code != http.StatusServiceUnavailable {
		t.Fatalf("status want 503, got %d", code)
	}
	if code, _ := getWait(t, s, "id=p1&for=ready"); code != http.StatusServiceUnavailable {
		t.Fatalf("wait want 503, got %d", code)
	}
}

// 라우터 등재 (FR-API-5 승계): 두 경로가 apiRoutes 를 통해 도달 가능해야 한다.
func TestStatusRoutesRegistered(t *testing.T) {
	var wantGet, wantWait bool
	for _, rt := range apiRoutes {
		if rt.method != http.MethodGet {
			continue
		}
		if rt.match("/api/tools/activity/get") {
			wantGet = true
		}
		if rt.match("/api/tools/activity/wait") {
			wantWait = true
		}
	}
	if !wantGet || !wantWait {
		t.Fatalf("routes missing: get=%v wait=%v", wantGet, wantWait)
	}
}

var _ toolaccess.ToolReader = (*fakeToolIO)(nil)
