package httpapi

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/webserver/hub"
)

// REPO_FIX 02 §3A-2 — SSE 쓰기 시한·진단 슬롯·재연결 스냅샷.

func sseServer(t *testing.T) (*Server, *hub.CommandHub, *httptest.Server) {
	t.Helper()
	cmd := hub.NewCommandHub()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: cmd})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, cmd, ts
}

// 읽지 않는 클라이언트: 쓰기가 막혀도 시한 뒤 핸들러가 돌아가고 구독 정리(Detach)가
// 돈다.
func TestSSE_WriteDeadlineReleasesStuckSubscriber(t *testing.T) {
	old := sseWriteTimeout
	sseWriteTimeout = 150 * time.Millisecond
	t.Cleanup(func() { sseWriteTimeout = old })
	srv, cmd, ts := sseServer(t)
	resp := openSSE(t, ts, "stuck")
	defer resp.Body.Close()
	if srv.Focus.LiveCount() != 1 {
		t.Fatalf("구독이 결선되지 않았다")
	}
	// 소켓 버퍼를 넘길 만큼 큰 진단 — 클라이언트는 더 읽지 않는다.
	big := []byte(`{"action":"lsp_diagnostics","args":{"path":"/x","items":["` + strings.Repeat("x", 32<<20) + `"]}}`)
	cmd.BroadcastDiagnostics("/x", big, false)
	deadline := time.Now().Add(5 * time.Second)
	for srv.Focus.LiveCount() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if srv.Focus.LiveCount() != 0 {
		t.Fatal("막힌 쓰기에서 핸들러가 돌아가지 않았다 — 구독 정리가 돌지 않았다")
	}
}

// 재연결한 구독은 인사 뒤 진단 스냅샷을 받는다.
func TestSSE_ReconnectGetsDiagnosticsSnapshot(t *testing.T) {
	_, cmd, ts := sseServer(t)
	cmd.BroadcastDiagnostics("/a.go", []byte(`{"action":"lsp_diagnostics","args":{"path":"/a.go","items":[1]}}`), false)
	resp, err := http.Get(ts.URL + "/api/commands/sse?clientId=re")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	got := make(chan bool, 1)
	go func() {
		for sc.Scan() {
			if strings.Contains(sc.Text(), `"path":"/a.go"`) {
				got <- true
				return
			}
		}
		got <- false
	}()
	select {
	case ok := <-got:
		if !ok {
			t.Fatal("스트림이 스냅샷 없이 끝났다")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("재연결 구독이 진단 스냅샷을 받지 못했다")
	}
}
