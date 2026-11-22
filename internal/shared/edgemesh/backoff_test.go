package edgemesh

import (
	"context"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/edge"
)

// dialWait 는 간선 fp 의 다음 걸기 간격과 걸고 있는가다.
func (tm *testMesh) dialWait(fp string) (time.Duration, bool) {
	tm.Mesh.mu.Lock()
	defer tm.Mesh.mu.Unlock()
	d := tm.dialing[fp]
	if d == nil {
		return 0, false
	}
	return d.wait, d.running
}

// TC-ATF-77 (FR-ATF-77 · AT-MESH-1): 붙자마자 끊기는 상대에는 걸 때마다 간격이 늘어난다.
func TestRedialBackoffGrowsOnShortLink(t *testing.T) {
	a := newTestMesh(t, "a")
	peer := edge.Edge{Name: "b", Addr: "127.0.0.1", Port: 1, Fingerprint: strings.Repeat("ef", 32)}
	a.mu.Lock()
	a.edges = []edge.Edge{peer}
	a.mu.Unlock()
	var dials atomic.Int64
	a.opts.Dial = func(context.Context, edge.Target) (net.Conn, error) {
		dials.Add(1)
		p1, p2 := net.Pipe()
		_ = p2.Close()
		return p1, nil
	}
	at := time.Now()
	want := redialMin
	for i := int64(1); i <= 3; i++ {
		a.dialEdges(context.Background(), at)
		eventually(t, "걸고 끊긴다", func() bool {
			w, running := a.dialWait(peer.Fingerprint)
			return dials.Load() == i && !running && !a.Linked(peer.Fingerprint) && w == want*2
		})
		want *= 2
		at = at.Add(redialMax)
	}
}

// TC-ATF-77: 생존 판정 시간 동안 유지된 연결이 끊기면 간격을 처음 값으로 되돌린다.
func TestRedialBackoffResetsAfterLongLink(t *testing.T) {
	a := newTestMesh(t, "a")
	a.Mesh.mu.Lock()
	a.deadAfter = 50 * time.Millisecond
	a.Mesh.mu.Unlock()
	peer := edge.Edge{Name: "b", Addr: "127.0.0.1", Port: 1, Fingerprint: strings.Repeat("ef", 32)}
	a.mu.Lock()
	a.edges = []edge.Edge{peer}
	a.mu.Unlock()
	var dials atomic.Int64
	kept := make(chan net.Conn, 1)
	a.opts.Dial = func(context.Context, edge.Target) (net.Conn, error) {
		p1, p2 := net.Pipe()
		if dials.Add(1) == 1 {
			_ = p2.Close()
		} else {
			kept <- p2
		}
		return p1, nil
	}
	a.dialEdges(context.Background(), time.Now())
	eventually(t, "첫 연결이 끊긴다", func() bool {
		w, running := a.dialWait(peer.Fingerprint)
		return !running && !a.Linked(peer.Fingerprint) && w == 2*redialMin
	})
	a.dialEdges(context.Background(), time.Now().Add(redialMax))
	eventually(t, "두 번째 연결", func() bool { return a.Linked(peer.Fingerprint) })
	time.Sleep(80 * time.Millisecond)
	_ = (<-kept).Close()
	eventually(t, "간격이 처음 값", func() bool {
		w, _ := a.dialWait(peer.Fingerprint)
		return !a.Linked(peer.Fingerprint) && w == redialMin
	})
}

// TC-ATF-77: Attach 가 중복으로 버린 연결은 실패로 센다.
func TestRedialDuplicateCountsAsFailure(t *testing.T) {
	a := newTestMesh(t, "a")
	// 지문이 작은 쪽이 건 연결을 남긴다 — 상대가 건 연결이 먼저 있으면 이쪽이 건 것은 버려진다.
	peer := edge.Edge{Name: "b", Addr: "127.0.0.1", Port: 1, Fingerprint: strings.Repeat("00", 32)}
	a.mu.Lock()
	a.edges = []edge.Edge{peer}
	a.mu.Unlock()
	a.opts.Dial = func(context.Context, edge.Target) (net.Conn, error) {
		in, _ := net.Pipe()
		a.Attach(peer.Fingerprint, in, false)
		p1, _ := net.Pipe()
		return p1, nil
	}
	a.dialEdges(context.Background(), time.Now())
	eventually(t, "걸기가 끝난다", func() bool {
		a.Mesh.mu.Lock()
		defer a.Mesh.mu.Unlock()
		d := a.dialing[peer.Fingerprint]
		return d != nil && !d.running && d.done != nil
	})
	a.Mesh.mu.Lock()
	d := a.dialing[peer.Fingerprint]
	err, wait := d.err, d.wait
	a.Mesh.mu.Unlock()
	if err == nil || wait != 2*redialMin {
		t.Fatalf("중복 연결: err=%v wait=%v, want 실패·%v", err, wait, 2*redialMin)
	}
	if !a.Linked(peer.Fingerprint) {
		t.Fatal("먼저 있던 연결이 사라졌다")
	}
}
