package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 묶음 R 의 CLI 절반 (RUN_ORCHESTRATION_SRS FR-RUN-8).

type runCall struct {
	Method string
	Path   string
	Body   map[string]any
	Query  string
}

// runStub records what dmctl sent and replies with canned bodies keyed by path.
func runStub(t *testing.T, replies map[string]string, status ...int) (*httptest.Server, *[]runCall) {
	t.Helper()
	code := http.StatusOK
	if len(status) > 0 {
		code = status[0]
	}
	var calls []runCall
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := runCall{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery}
		if r.Method == http.MethodPost {
			_ = json.NewDecoder(r.Body).Decode(&c.Body)
		}
		calls = append(calls, c)
		body, ok := replies[r.URL.Path]
		if !ok {
			body = `{}`
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(ts.Close)
	return ts, &calls
}

// FR-RUN-8: run start 는 목적·투영·격리를 보내고 id 를 낸다.
func TestDmctlRun_Start(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs": `{"id":"run-1","short":"run-1","objective":"팬아웃","projection":"dedicated-window","isolation":"none","state":"open","members":[]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	code := runDmctlRun([]string{"start", "--objective", "팬아웃", "--projection", "dedicated-window"}, &out, io.Discard)
	if code != 0 {
		t.Fatalf("exit = %d, want 0 (%s)", code, out.String())
	}
	if len(*calls) != 1 || (*calls)[0].Path != "/api/runs" || (*calls)[0].Method != http.MethodPost {
		t.Fatalf("요청이 다르다: %+v", *calls)
	}
	body := (*calls)[0].Body
	if body["objective"] != "팬아웃" || body["projection"] != "dedicated-window" {
		t.Fatalf("본문이 다르다: %+v", body)
	}
	if !strings.Contains(out.String(), "run-1") {
		t.Fatalf("출력에 run id 가 없다: %q", out.String())
	}
}

// FR-WKT-1: 격리 기본값은 none 이다 — 조용히 격리되면 안 된다.
func TestDmctlRun_StartDefaultsToNoIsolation(t *testing.T) {
	ts, calls := runStub(t, map[string]string{"/api/runs": `{"id":"run-1","state":"open"}`})
	pointDmctlAtServer(t, ts, "tool-a")

	if code := runDmctlRun([]string{"start", "--objective", "x"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	body := (*calls)[0].Body
	if body["isolation"] != "none" {
		t.Fatalf("기본 격리는 none 이어야 한다: %+v", body)
	}
	if body["projection"] != "dedicated-window" {
		t.Fatalf("기본 투영은 전용 창이어야 한다 (사용자 공간 비침범): %+v", body)
	}
}

// FR-RUN-2: member 는 run·role·agent·대상 도구를 보낸다.
func TestDmctlRun_Member(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/members": `{"id":"m-1","role":"writer","agent":"claude","toolId":"tool-b","tabId":"tab-b","state":"starting"}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	code := runDmctlRun([]string{"member", "--run", "run-1", "--role", "writer", "--agent", "claude", "--at", "tab-b"}, &out, io.Discard)
	if code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	body := (*calls)[0].Body
	if body["runId"] != "run-1" || body["role"] != "writer" || body["agent"] != "claude" || body["id"] != "tab-b" {
		t.Fatalf("본문이 다르다: %+v", body)
	}
	if !strings.Contains(out.String(), "tab-b") {
		t.Fatalf("출력에 탭 uuid 가 없다 — 조정자가 location 으로 쓴다: %q", out.String())
	}
}

// FR-PRE-2/3: report 는 outcome 을 명시해야 하고 요약을 함께 보낸다.
func TestDmctlRun_Report(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/report": `{"id":"m-1","role":"writer","state":"done","outcome":"succeeded"}`,
	})
	pointDmctlAtServer(t, ts, "tool-b")

	code := runDmctlRun([]string{"report", "--outcome", "succeeded", "--summary", "했다. 봤다. 남았다.", "--files", "a.go,b.go"}, io.Discard, io.Discard)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	body := (*calls)[0].Body
	if body["outcome"] != "succeeded" || body["summary"] != "했다. 봤다. 남았다." {
		t.Fatalf("본문이 다르다: %+v", body)
	}
	files, _ := body["files"].([]any)
	if len(files) != 2 || files[0] != "a.go" {
		t.Fatalf("files 가 분해되지 않았다: %+v", body)
	}
	// 발신자 정체는 서버가 정하지만, daemon 모드 폴백을 위해 toolId 를 함께 보낸다.
	if body["toolId"] != "tool-b" {
		t.Fatalf("toolId 폴백이 빠졌다: %+v", body)
	}
}

// FR-PRE-3: outcome 누락·오타는 사용법 오류다 (서버에 가기 전에 막는다).
func TestDmctlRun_ReportValidatesOutcome(t *testing.T) {
	ts, calls := runStub(t, map[string]string{})
	pointDmctlAtServer(t, ts, "tool-b")

	for _, args := range [][]string{
		{"report", "--summary", "x"},
		{"report", "--outcome", "kinda", "--summary", "x"},
		{"report", "--outcome", "succeeded"},
	} {
		if code := runDmctlRun(args, io.Discard, io.Discard); code != 2 {
			t.Fatalf("args %v → exit %d, want 2", args, code)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("검증 실패인데 서버를 불렀다: %+v", *calls)
	}
}

// FR-RUN-11: close 거부(409)는 사유와 미보고 목록을 사람이 읽을 수 있게 낸다.
func TestDmctlRun_CloseRefusalExplains(t *testing.T) {
	ts, _ := runStub(t, map[string]string{
		"/api/runs/close": `{"error":"unreported_members","detail":"unreported_members","unreported":[{"id":"m-2","role":"critic","state":"working"}]}`,
	}, http.StatusConflict)
	pointDmctlAtServer(t, ts, "tool-a")

	var out, errBuf bytes.Buffer
	code := runDmctlRun([]string{"close", "--run", "run-1"}, &out, &errBuf)
	if code == 0 {
		t.Fatal("거부인데 성공으로 끝났다")
	}
	combined := out.String() + errBuf.String()
	for _, want := range []string{"unreported_members", "critic"} {
		if !strings.Contains(combined, want) {
			t.Fatalf("출력 %q 에 %q 가 없다", combined, want)
		}
	}
}

// FR-RUN-10/11: close 성공은 정리 대상을 낸다 — 탭 닫기는 조정자의 몫이다.
func TestDmctlRun_ClosePrintsCleanupTargets(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/close": `{"id":"run-1","short":"run-1","state":"closed","cleanup":[{"memberId":"m-1","role":"writer","toolId":"tool-b","tabId":"tab-b","live":true}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"close", "--run", "run-1", "--force"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if (*calls)[0].Body["force"] != true {
		t.Fatalf("--force 가 전달되지 않았다: %+v", (*calls)[0].Body)
	}
	if !strings.Contains(out.String(), "tab-b") {
		t.Fatalf("정리 대상이 출력되지 않았다: %q", out.String())
	}
}

// FR-RUN-8: status 는 id 로 조회하고, 생략하면 목록이다.
func TestDmctlRun_StatusAndList(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs": `{"id":"run-1","short":"run-1","objective":"팬아웃","state":"open","members":[{"id":"m-1","role":"writer","state":"working","toolId":"tool-b","tabId":"tab-b"}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"status", "--run", "run-1"}, &out, io.Discard); code != 0 {
		t.Fatalf("status exit = %d", code)
	}
	if !strings.Contains((*calls)[0].Query, "id=run-1") {
		t.Fatalf("id 질의가 없다: %+v", (*calls)[0])
	}
	for _, want := range []string{"writer", "working", "tab-b"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("status 출력 %q 에 %q 가 없다", out.String(), want)
		}
	}

	out.Reset()
	if code := runDmctlRun([]string{"list"}, &out, io.Discard); code != 0 {
		t.Fatalf("list exit = %d", code)
	}
	if (*calls)[1].Query != "" {
		t.Fatalf("list 는 전체 조회다: %+v", (*calls)[1])
	}
}

// FR-RUN-8: --json 은 서버 응답을 그대로 통과시킨다.
func TestDmctlRun_JSONPassthrough(t *testing.T) {
	ts, _ := runStub(t, map[string]string{"/api/runs": `{"id":"run-1","state":"open","members":[]}`})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"status", "--run", "run-1", "--json"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	var rec map[string]any
	if err := json.Unmarshal(out.Bytes(), &rec); err != nil {
		t.Fatalf("--json 이 JSON 이 아니다: %v (%q)", err, out.String())
	}
}

// 사용법 오류는 2 다.
func TestDmctlRun_UsageErrors(t *testing.T) {
	ts, _ := runStub(t, map[string]string{})
	pointDmctlAtServer(t, ts, "tool-a")

	cases := [][]string{
		{},                       // 서브커맨드 없음
		{"bogus"},                // 알 수 없는 서브커맨드
		{"start"},                // --objective 없음
		{"member", "--run", "r"}, // role/agent/at 없음
		{"member", "--role", "w", "--agent", "claude"}, // --run 없음
		{"close"},                                // --run 없음
		{"start", "--objective", "x", "--bogus"}, // 알 수 없는 플래그
	}
	for _, args := range cases {
		if code := runDmctlRun(args, io.Discard, io.Discard); code != 2 {
			t.Fatalf("args %v → exit %d, want 2", args, code)
		}
	}
}

// FR-DMA-9 승계: 도움말과 디스패치 등재.
func TestDmctlRun_HelpAndDispatch(t *testing.T) {
	var out bytes.Buffer
	if code := runDmctlRun([]string{"--help"}, &out, io.Discard); code != 0 {
		t.Fatalf("run --help exit = %d", code)
	}
	for _, want := range []string{"start", "member", "report", "status", "close", "list"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("run 도움말에 %q 가 없다", want)
		}
	}
	if !strings.Contains(dmctlHelp, "dmctl run") {
		t.Fatal("최상위 도움말에 run 이 없다")
	}

	ts, _ := runStub(t, map[string]string{"/api/runs": `{"runs":[]}`})
	pointDmctlAtServer(t, ts, "tool-a")
	if _, handled := runDmctlSpecial("run", []string{"list"}, io.Discard, io.Discard); !handled {
		t.Fatal("`dmctl run` 이 디스패치되지 않는다")
	}
}
