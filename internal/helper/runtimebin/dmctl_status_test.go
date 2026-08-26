package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// 묶음 S 의 CLI 절반 (RUN_ORCHESTRATION_SRS FR-STA-1/2/7, TC-STA-1~7).

// statusStub serves /api/tools/activity/{get,wait} with a canned body and
// counts requests, so a client-side polling loop is detectable (TC-STA-7).
func statusStub(t *testing.T, body string) (*httptest.Server, *int32) {
	t.Helper()
	var hits int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(ts.Close)
	return ts, &hits
}

// TC-STA-1 (FR-STA-1): status 는 보고된 상태를 사람이 읽을 수 있게 낸다.
func TestDmctlStatus_Text(t *testing.T) {
	ts, _ := statusStub(t, `{"toolId":"p1","live":true,"state":"working","tool":"Bash","detail":"go test","updatedAt":1,"lastOutputAt":2,"quietMs":40}`)
	pointDmctlAtServer(t, ts, "p1")

	var out bytes.Buffer
	if code := runDmctlStatus(nil, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	got := out.String()
	for _, want := range []string{"state=working", "tool=Bash", "live=true"} {
		if !strings.Contains(got, want) {
			t.Fatalf("output %q missing %q", got, want)
		}
	}
}

// FR-STA-1: --json 은 서버 응답을 그대로 통과시킨다 (스킬이 파싱한다).
func TestDmctlStatus_JSON(t *testing.T) {
	ts, _ := statusStub(t, `{"toolId":"p1","live":true,"state":"idle","updatedAt":1,"lastOutputAt":2,"quietMs":40}`)
	pointDmctlAtServer(t, ts, "p1")

	var out bytes.Buffer
	if code := runDmctlStatus([]string{"--json"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	var rec map[string]any
	if err := json.Unmarshal(out.Bytes(), &rec); err != nil {
		t.Fatalf("--json must emit JSON: %v (%q)", err, out.String())
	}
	if rec["state"] != "idle" {
		t.Fatalf("json body lost fields: %+v", rec)
	}
}

// TC-STA-2 (FR-STA-1): 활동 보고가 없어도 rc=0 이다.
func TestDmctlStatus_UnknownIsNotAnError(t *testing.T) {
	ts, _ := statusStub(t, `{"toolId":"p1","live":true,"state":"unknown","updatedAt":0,"lastOutputAt":0,"quietMs":-1}`)
	pointDmctlAtServer(t, ts, "p1")
	if code := runDmctlStatus(nil, io.Discard, io.Discard); code != 0 {
		t.Fatalf("unknown state must be rc=0, got %d", code)
	}
}

// FR-STA-7: 대상을 알 수 없으면 사용법 오류(2)다.
func TestDmctlStatus_NoTargetIsUsageError(t *testing.T) {
	ts, _ := statusStub(t, `{}`)
	pointDmctlAtServer(t, ts, "")
	var errBuf bytes.Buffer
	if code := runDmctlStatus(nil, io.Discard, &errBuf); code != 2 {
		t.Fatalf("missing target want 2, got %d", code)
	}
	if !strings.Contains(errBuf.String(), "--at") {
		t.Fatalf("error must name --at: %q", errBuf.String())
	}
}

// FR-STA-7: 종료 코드 매핑 — 조건 충족 0 / 타임아웃 4 / blocked 5 / 소멸 1.
func TestDmctlWait_ExitCodeMapping(t *testing.T) {
	cases := []struct {
		status string
		want   int
	}{
		{"ready", 0},
		{"done", 0},
		{"timeout", 4},
		{"blocked", 5},
		{"gone", 1},
	}
	for _, tc := range cases {
		ts, _ := statusStub(t, `{"toolId":"p1","status":"`+tc.status+`","state":"working","live":true,"waitedMs":5,"timeoutMs":1000}`)
		pointDmctlAtServer(t, ts, "p1")
		if code := runDmctlWait([]string{"--at", "p1", "--for", "ready"}, io.Discard, io.Discard); code != tc.want {
			t.Fatalf("status=%s → exit %d, want %d", tc.status, code, tc.want)
		}
	}
}

// TC-STA-5 (FR-STA-6): 타임아웃 출력은 마지막 관측 상태를 담아야 한다 —
// "실패"로 읽히는 문구를 쓰지 않는다.
func TestDmctlWait_TimeoutReportsLastObservation(t *testing.T) {
	ts, _ := statusStub(t, `{"toolId":"p1","status":"timeout","state":"working","tool":"Bash","detail":"sleep 600","live":true,"waitedMs":150,"quietMs":20,"timeoutMs":150}`)
	pointDmctlAtServer(t, ts, "p1")

	var out, errBuf bytes.Buffer
	if code := runDmctlWait([]string{"--for", "ready"}, &out, &errBuf); code != 4 {
		t.Fatalf("exit = %d, want 4", code)
	}
	combined := out.String() + errBuf.String()
	for _, want := range []string{"timeout", "state=working"} {
		if !strings.Contains(combined, want) {
			t.Fatalf("output %q missing %q", combined, want)
		}
	}
}

// TC-STA-4 (FR-STA-5): blocked 는 사유를 사람이 알아볼 수 있게 낸다.
func TestDmctlWait_BlockedExplains(t *testing.T) {
	ts, _ := statusStub(t, `{"toolId":"p1","status":"blocked","state":"waiting","live":true,"reason":"permission","waitedMs":1,"timeoutMs":1000}`)
	pointDmctlAtServer(t, ts, "p1")

	var out, errBuf bytes.Buffer
	if code := runDmctlWait([]string{"--for", "done"}, &out, &errBuf); code != 5 {
		t.Fatalf("exit = %d, want 5", code)
	}
	if !strings.Contains(out.String()+errBuf.String(), "blocked") {
		t.Fatalf("blocked must be named in the output")
	}
}

// TC-STA-7 (FR-STA-3): 대기는 서버 long-poll 이다 — 클라이언트가 폴링하지 않는다.
func TestDmctlWait_IssuesOneRequest(t *testing.T) {
	ts, hits := statusStub(t, `{"toolId":"p1","status":"ready","state":"idle","live":true,"waitedMs":10,"timeoutMs":1000}`)
	pointDmctlAtServer(t, ts, "p1")

	if code := runDmctlWait([]string{"--for", "ready", "--timeout-ms", "1000"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if n := atomic.LoadInt32(hits); n != 1 {
		t.Fatalf("wait must issue exactly one request, got %d", n)
	}
}

// FR-STA-2/7: 인자 검증은 사용법 오류(2)다.
func TestDmctlWait_UsageErrors(t *testing.T) {
	ts, _ := statusStub(t, `{"toolId":"p1","status":"ready"}`)
	pointDmctlAtServer(t, ts, "p1")

	cases := [][]string{
		{},                                      // --for 누락
		{"--for", "sideways"},                   // 알 수 없는 조건
		{"--for", "ready", "--timeout-ms"},      // 값 없는 플래그
		{"--for", "ready", "--timeout-ms", "x"}, // 정수 아님
		{"--for", "ready", "--bogus"},           // 알 수 없는 플래그
	}
	for _, args := range cases {
		if code := runDmctlWait(args, io.Discard, io.Discard); code != 2 {
			t.Fatalf("args %v → exit %d, want 2", args, code)
		}
	}
}

// FR-DMA-9 승계: 두 명령 모두 자기 도움말을 갖고 최상위 도움말에 등재된다.
func TestDmctlStatusWait_Help(t *testing.T) {
	var out bytes.Buffer
	if code := runDmctlStatus([]string{"--help"}, &out, io.Discard); code != 0 {
		t.Fatalf("status --help exit = %d", code)
	}
	if !strings.Contains(out.String(), "dmctl status") {
		t.Fatalf("status help missing usage: %q", out.String())
	}
	out.Reset()
	if code := runDmctlWait([]string{"-h"}, &out, io.Discard); code != 0 {
		t.Fatalf("wait -h exit = %d", code)
	}
	for _, want := range []string{"--for", "ready", "done"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("wait help missing %q: %q", want, out.String())
		}
	}
	if !strings.Contains(dmctlHelp, "status") || !strings.Contains(dmctlHelp, "wait") {
		t.Fatalf("top-level help must list status and wait")
	}
}

// 디스패치 등재: `dmctl status` / `dmctl wait` 가 실제로 라우팅돼야 한다.
func TestDmctlDispatch_StatusAndWait(t *testing.T) {
	ts, _ := statusStub(t, `{"toolId":"p1","live":true,"state":"idle","status":"ready"}`)
	pointDmctlAtServer(t, ts, "p1")

	if _, handled := runDmctlSpecial("status", nil, io.Discard, io.Discard); !handled {
		t.Fatalf("`dmctl status` must be dispatched")
	}
	if _, handled := runDmctlSpecial("wait", []string{"--for", "ready"}, io.Discard, io.Discard); !handled {
		t.Fatalf("`dmctl wait` must be dispatched")
	}
}
