package runtimebin

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
)

// AGENT_RECORD_DAEMON_SRS TC-ARD-21 — 보고는 데몬의 보고 소켓에 먼저 가고, 없거나 실패하면
// HTTP 로 간다. 두 시도의 합이 예산을 넘지 않는다 (FR-ARD-23, §3.2a).

type fakeReportSock struct {
	mu   sync.Mutex
	reqs []agentrec.Request
}

func (f *fakeReportSock) got() []agentrec.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agentrec.Request(nil), f.reqs...)
}

// startReportSock 는 짧은 홈에 보고 소켓을 연다. reply 가 nil 이면 받기만 하고 답하지 않는다.
func startReportSock(t *testing.T, reply *agentrec.Reply) *fakeReportSock {
	t.Helper()
	home, err := os.MkdirTemp("", "rbs")
	if err != nil {
		t.Fatal(err)
	}
	ln, err := platform.Current().IPC.Listen(agentrec.SocketPath(home))
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeReportSock{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				var req agentrec.Request
				if json.NewDecoder(c).Decode(&req) != nil {
					return
				}
				f.mu.Lock()
				f.reqs = append(f.reqs, req)
				f.mu.Unlock()
				if reply == nil {
					time.Sleep(5 * time.Second)
					return
				}
				_ = json.NewEncoder(c).Encode(reply)
			}(c)
		}
	}()
	t.Cleanup(func() { ln.Close(); os.RemoveAll(home) })
	t.Setenv(dmenv.EnvHome, home)
	return f
}

type httpHits struct {
	mu    sync.Mutex
	paths []string
}

func (h *httpHits) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.paths)
}

func startReportHTTP(t *testing.T) *httpHits {
	t.Helper()
	h := &httpHits{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		h.paths = append(h.paths, r.URL.Path)
		h.mu.Unlock()
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(ts.Close)
	pointDmctlAtServer(t, ts, "t1")
	return h
}

func TestPostReport_SocketFirst(t *testing.T) {
	hits := startReportHTTP(t)
	sock := startReportSock(t, &agentrec.Reply{OK: true})
	status, resp, err := postReport(agentrec.MethodActivity, "/api/tools/activity/set", map[string]any{"toolId": "t1", "state": "working"}, hookBudget)
	if err != nil || status != http.StatusOK || !strings.Contains(string(resp), `"ok":true`) {
		t.Fatalf("status=%d resp=%s err=%v", status, resp, err)
	}
	if hits.count() != 0 {
		t.Fatalf("소켓이 받았는데 HTTP 도 보냈다: %v", hits.paths)
	}
	got := sock.got()
	if len(got) != 1 || got[0].Method != agentrec.MethodActivity || !strings.Contains(string(got[0].Body), `"toolId":"t1"`) {
		t.Fatalf("소켓 요청=%+v", got)
	}
}

func TestPostReport_NoSocketGoesHTTP(t *testing.T) {
	hits := startReportHTTP(t)
	home, _ := os.MkdirTemp("", "rbn")
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv(dmenv.EnvHome, home)
	if status, _, err := postReport(agentrec.MethodNotify, "/api/tools/attention/set", map[string]any{"toolId": "t1"}, hookBudget); err != nil || status != http.StatusOK {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if hits.count() != 1 || hits.paths[0] != "/api/tools/attention/set" {
		t.Fatalf("HTTP=%v", hits.paths)
	}
}

func TestPostReport_NoHomeGoesHTTP(t *testing.T) {
	hits := startReportHTTP(t)
	if status, _, err := postReport(agentrec.MethodUsage, "/api/tools/usage", map[string]any{"toolId": "t1"}, slReportBudget); err != nil || status != http.StatusOK {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if hits.count() != 1 {
		t.Fatalf("HTTP=%v", hits.paths)
	}
}

func TestPostReport_SocketRejectsGoesHTTP(t *testing.T) {
	hits := startReportHTTP(t)
	sock := startReportSock(t, &agentrec.Reply{Error: "no such tool"})
	if status, _, err := postReport(agentrec.MethodSubagents, "/api/tools/subagents", map[string]any{"toolId": "t1"}, hookBudget); err != nil || status != http.StatusOK {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if len(sock.got()) != 1 || hits.count() != 1 {
		t.Fatalf("소켓=%d HTTP=%d, 둘 다 1 을 기대", len(sock.got()), hits.count())
	}
}

// 소켓이 답하지 않아도 두 시도의 합은 예산 안이고, HTTP 는 남은 예산으로 간다.
func TestPostReport_SocketHangsStaysWithinBudget(t *testing.T) {
	hits := startReportHTTP(t)
	startReportSock(t, nil)
	const budget = 400 * time.Millisecond
	start := time.Now()
	status, _, err := postReport(agentrec.MethodActivity, "/api/tools/activity/set", map[string]any{"toolId": "t1"}, budget)
	elapsed := time.Since(start)
	if err != nil || status != http.StatusOK || hits.count() != 1 {
		t.Fatalf("status=%d err=%v HTTP=%d", status, err, hits.count())
	}
	if elapsed > budget+100*time.Millisecond {
		t.Fatalf("걸린 시간 %v 가 예산 %v 를 넘었다", elapsed, budget)
	}
}

// dmctl notify 가 소켓으로 보내도 종료 코드는 성공이다.
func TestDmctlNotify_ViaSocket(t *testing.T) {
	hits := startReportHTTP(t)
	sock := startReportSock(t, &agentrec.Reply{OK: true})
	var out, errb strings.Builder
	if code := runDmctlNotify([]string{"done"}, &out, &errb); code != 0 {
		t.Fatalf("code=%d stderr=%s", code, errb.String())
	}
	got := sock.got()
	if len(got) != 1 || got[0].Method != agentrec.MethodNotify || !strings.Contains(string(got[0].Body), `"reason":"done"`) || hits.count() != 0 {
		t.Fatalf("소켓=%+v HTTP=%v", got, hits.paths)
	}
}

// dmctl activity 의 맥락 관측은 넷에 들지 않으므로 HTTP 에 남는다.
func TestDmctlActivity_ViaSocketKeepsContextOnHTTP(t *testing.T) {
	hits := startReportHTTP(t)
	sock := startReportSock(t, &agentrec.Reply{OK: true})
	code := runDmctlActivity([]string{"claude"}, strings.NewReader(`{"hook_event_name":"UserPromptSubmit","session_id":"s1"}`), &strings.Builder{}, &strings.Builder{})
	if code != 0 {
		t.Fatalf("code=%d", code)
	}
	if got := sock.got(); len(got) != 1 || got[0].Method != agentrec.MethodActivity {
		t.Fatalf("소켓=%+v", got)
	}
	hits.mu.Lock()
	defer hits.mu.Unlock()
	if len(hits.paths) != 1 || hits.paths[0] != contextObservePath {
		t.Fatalf("HTTP=%v, 맥락 관측 하나를 기대", hits.paths)
	}
}

func TestStatusline_ViaSocket(t *testing.T) {
	hits := startReportHTTP(t)
	sock := startReportSock(t, &agentrec.Reply{OK: true})
	env := map[string]string{"HOME": t.TempDir(), "DONGMINAL_TOOL_ID": "t1"}
	runStatusline(strings.NewReader(slSample), &strings.Builder{}, &strings.Builder{}, env)
	runSubagentStatusline(strings.NewReader(sslSample), &strings.Builder{}, &strings.Builder{}, env)
	got := sock.got()
	if len(got) != 2 || got[0].Method != agentrec.MethodUsage || got[1].Method != agentrec.MethodSubagents || hits.count() != 0 {
		t.Fatalf("소켓=%+v HTTP=%v", got, hits.paths)
	}
}
