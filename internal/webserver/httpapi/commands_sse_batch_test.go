package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/hub"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-1 (IPC-12 · HTTP-M2) — 쌓인 이벤트는 한 번에 쓰고 한 번
// flush 한다. 큐 상한은 한 곳이 한 번에 내는 가장 큰 버스트를 담는다.

// gateWriter 는 첫 쓰기(인사) 뒤의 쓰기를 gate 가 열릴 때까지 막는다. 막힌 쓰기는
// 느린 클라이언트다 — 그 사이에 방송이 큐에 쌓인다.
type gateWriter struct {
	h       http.Header
	mu      sync.Mutex
	buf     bytes.Buffer
	writes  int
	flushes int
	gate    chan struct{}
	blocked chan struct{}
}

func newGateWriter() *gateWriter {
	return &gateWriter{h: http.Header{}, gate: make(chan struct{}), blocked: make(chan struct{}, 1)}
}

func (g *gateWriter) Header() http.Header { return g.h }
func (g *gateWriter) WriteHeader(int)     {}
func (g *gateWriter) Write(p []byte) (int, error) {
	g.mu.Lock()
	n := g.writes
	g.writes++
	g.mu.Unlock()
	if n > 0 {
		select {
		case g.blocked <- struct{}{}:
		default:
		}
		<-g.gate
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.buf.Write(p)
}
func (g *gateWriter) Flush() {
	g.mu.Lock()
	g.flushes++
	g.mu.Unlock()
}
func (g *gateWriter) snapshot() (string, int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.buf.String(), g.flushes
}

func sseWaitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("시간 안에 %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// 도구 전부의 주의를 한 번에 지우면 도구 수(ToolCap)만큼 방송이 연달아 나간다
// (ClearAllAttention). 쓰기가 막혀 있는 동안 그것이 쌓여도 구독은 닫히지 않고,
// 풀리면 쌓인 것이 flush 한 번으로 나간다.
func TestSSE_BurstWhileStalledIsBatchedAndKeepsSubscription(t *testing.T) {
	srv, cmd, _ := sseServer(t)
	gw := newGateWriter()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/commands/sse", nil).WithContext(ctx)
	done := make(chan struct{})
	go func() { srv.handleCommandSSE(gw, req); close(done) }()

	sseWaitFor(t, "인사를 쓰지 않았다", func() bool { _, f := gw.snapshot(); return f == 1 })
	burst := toolhub.ToolCap
	cmd.Broadcast([]byte(`{"n":0}`))
	<-gw.blocked // 첫 방송을 쓰다가 막혔다
	for i := 1; i < burst; i++ {
		if got := cmd.Broadcast([]byte(`{"n":1}`)); got != 1 {
			t.Fatalf("버스트 %d 번째에서 구독이 닫혔다 (delivered=%d) — 큐가 버스트를 담지 못한다", i, got)
		}
	}
	close(gw.gate)
	sseWaitFor(t, "버스트를 다 쓰지 않았다", func() bool {
		b, _ := gw.snapshot()
		return strings.Count(b, `data: {"n":`) == burst
	})
	_, flushes := gw.snapshot()
	// 인사 1 + 막혔던 첫 방송 1 + 쌓인 나머지(64 KiB 상한 안) 1.
	if flushes > 3 {
		t.Fatalf("flush = %d — 쌓인 이벤트를 합쳐 쓰지 않는다 (버스트 %d)", flushes, burst)
	}
	cancel()
	<-done
}

// 진단 N건은 flush 한 번이다 (HTTP-M2).
func TestSSE_DiagnosticsSnapshotOneFlush(t *testing.T) {
	srv, cmd, _ := sseServer(t)
	for _, p := range []string{"/a", "/b", "/c", "/d", "/e"} {
		cmd.BroadcastDiagnostics(p, []byte(`{"action":"lsp_diagnostics","args":{"path":"`+p+`"}}`), false)
	}
	gw := newGateWriter()
	close(gw.gate)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/commands/sse", nil).WithContext(ctx)
	done := make(chan struct{})
	go func() { srv.handleCommandSSE(gw, req); close(done) }()
	sseWaitFor(t, "진단 5건을 쓰지 않았다", func() bool {
		b, _ := gw.snapshot()
		return strings.Count(b, `"lsp_diagnostics"`) == 5
	})
	if _, f := gw.snapshot(); f != 2 {
		t.Fatalf("flush = %d, want 2 (인사 1 + 진단 1)", f)
	}
	cancel()
	<-done
}

// 큐 상한은 버스트를 담는다 — 기본값을 지키는 검사 (CONTRIBUTING §4 "상한은 var").
func TestSSE_QueueHoldsToolCapBurst(t *testing.T) {
	sub := hub.NewCmdSub()
	if c := cap(sub.Messages()); c < toolhub.ToolCap {
		t.Fatalf("구독 큐 = %d < ToolCap %d — ClearAllAttention 한 번이 구독을 닫는다", c, toolhub.ToolCap)
	}
}
