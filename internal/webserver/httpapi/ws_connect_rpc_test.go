package httpapi

import (
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/toolclient"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-5 (IPC-23) — WS 연결당 데몬 RPC 2 → 1.
//
// snapshot 이 "없음" 을 CodeNotFound 로 말하는 데몬에는 존재 확인용 Get(list)을
// 부르지 않는다. 말하지 않는 옛 데몬에는 종전대로 Get 을 먼저 부른다.

type getCountingHub struct {
	*toolclient.ToolClient
	gets atomic.Int64
}

func (h *getCountingHub) Get(id string) *toolhub.Tool {
	h.gets.Add(1)
	return h.ToolClient.Get(id)
}

func wsFirstOp(t *testing.T, h *getCountingHub, toolID string) byte {
	t.Helper()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: h})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	ws := mustWS(t, ts, "/ws?tool="+toolID)
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, err := ws.ReadMessage()
	if err != nil || len(msg) == 0 {
		t.Fatalf("첫 프레임: msg=%q err=%v", msg, err)
	}
	return msg[0]
}

func TestWSDaemonConnectSkipsGet(t *testing.T) {
	pm, pc := daemonPair(t)
	p, err := pm.Create("/tmp", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer pm.Delete(p.ID)

	h := &getCountingHub{ToolClient: pc}
	if op := wsFirstOp(t, h, p.ID); op != toolhub.OpToolID {
		t.Fatalf("첫 op=0x%02x want OpToolID", op)
	}
	if got := h.gets.Load(); got != 0 {
		t.Fatalf("Get %d회 — snapnotfound 데몬에는 0 이어야 한다", got)
	}
	// 없는 도구는 snapshot 의 NotFound 로 판정해 OpExit 를 보낸다 — 종전과 같은 바이트다.
	if op := wsFirstOp(t, h, "nope"); op != toolhub.OpExit {
		t.Fatalf("없는 도구의 첫 op=0x%02x want OpExit", op)
	}
	if got := h.gets.Load(); got != 0 {
		t.Fatalf("없는 도구에도 Get %d회", got)
	}
}

// 교차 판: 새 서버 · 옛 데몬 — Get 으로 존재를 확인한다.
func TestWSLegacyDaemonConnectUsesGet(t *testing.T) {
	saved := toolipc.DaemonFeatures
	toolipc.DaemonFeatures = nil
	t.Cleanup(func() { toolipc.DaemonFeatures = saved })
	pm, pc := daemonPair(t)
	p, err := pm.Create("/tmp", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer pm.Delete(p.ID)

	h := &getCountingHub{ToolClient: pc}
	if op := wsFirstOp(t, h, p.ID); op != toolhub.OpToolID {
		t.Fatalf("첫 op=0x%02x want OpToolID", op)
	}
	if got := h.gets.Load(); got != 1 {
		t.Fatalf("옛 데몬에 Get %d회 — 1 이어야 한다", got)
	}
	if op := wsFirstOp(t, h, "nope"); op != toolhub.OpExit {
		t.Fatalf("없는 도구의 첫 op=0x%02x want OpExit", op)
	}
}

// subCountingDaemon 은 살아 있는 구독 수를 센다.
type subCountingDaemon struct {
	toolhub.DaemonHub
	active atomic.Int64
}

func (d *subCountingDaemon) Subscribe(id string, ch chan toolhub.OutChunk) (<-chan struct{}, func()) {
	ex, un := d.DaemonHub.Subscribe(id, ch)
	d.active.Add(1)
	var once sync.Once
	return ex, func() { once.Do(func() { d.active.Add(-1) }); un() }
}

type subCountingHub struct {
	*toolclient.ToolClient
	d *subCountingDaemon
}

func (h *subCountingHub) Daemon() toolhub.DaemonHub { return h.d }

// 없는 도구의 구독은 OpExit 를 보내기 전에 푼다 — 붙잡는 동안(holdMiss, 최대
// MissHoldMax) 없는 도구의 구독이 남지 않는다 (FR-OPT-2-5).
func TestWSDaemonMissReleasesSubscription(t *testing.T) {
	_, pc := daemonPair(t)
	d := &subCountingDaemon{DaemonHub: pc}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: &subCountingHub{ToolClient: pc, d: d}})
	// 임계 바로 앞까지 미스를 쌓아 이번 연결이 붙잡히게 한다.
	for i := 1; i < MissHoldAfter; i++ {
		srv.misses.count("nope", time.Now())
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	ws := mustWS(t, ts, "/ws?tool=nope")
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(MissDelay + 5*time.Second))
	_, msg, err := ws.ReadMessage()
	if err != nil || len(msg) == 0 || msg[0] != toolhub.OpExit {
		t.Fatalf("첫 프레임: msg=%q err=%v — OpExit 여야 한다", msg, err)
	}
	if n := d.active.Load(); n != 0 {
		t.Fatalf("OpExit 뒤에 없는 도구의 구독 %d개가 남았다", n)
	}
}
