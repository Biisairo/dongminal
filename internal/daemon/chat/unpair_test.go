package chat

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/edge"
)

// EDGE_PAIRING_SRS FR-EPR-22 (E2): 간선 상대가 edge_not_edge 로 답하면 그 간선을 지운다.

type unpairFixture struct {
	s     *Service
	dials atomic.Int64
	mu    sync.Mutex
	gone  []string
}

func newUnpairFixture(t *testing.T, e edge.Edge, dialErr error) *unpairFixture {
	t.Helper()
	id, err := edge.LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &unpairFixture{}
	f.s = New(Options{
		Identity: id,
		Name:     func() string { return "me" },
		Edges:    func() []edge.Edge { return []edge.Edge{e} },
		Dial: func(context.Context, edge.Target) (net.Conn, error) {
			f.dials.Add(1)
			return nil, dialErr
		},
		Unpaired: func(fp string) {
			f.mu.Lock()
			f.gone = append(f.gone, fp)
			f.mu.Unlock()
		},
	})
	t.Cleanup(f.s.Close)
	return f
}

func (f *unpairFixture) unpaired() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.gone...)
}

func (f *unpairFixture) dialOnce(t *testing.T) {
	t.Helper()
	f.s.dialEdges(context.Background(), time.Now())
	eventually(t, "다시 걸기가 끝난다", func() bool {
		f.s.mu.Lock()
		defer f.s.mu.Unlock()
		d := f.s.dialing[peerEdge.Fingerprint]
		return f.dials.Load() == 1 && d != nil && !d.running
	})
}

var peerEdge = edge.Edge{Name: "b", Addr: "127.0.0.1", Port: 1, Fingerprint: strings.Repeat("ab", 32)}

func TestDialNotEdgeForgets(t *testing.T) {
	f := newUnpairFixture(t, peerEdge, &edge.RemoteError{Status: 403, Code: edge.CodeNotEdge})
	f.dialOnce(t)
	eventually(t, "Unpaired 를 부른다", func() bool {
		got := f.unpaired()
		return len(got) == 1 && got[0] == peerEdge.Fingerprint
	})
}

func TestDialOtherFailureKeepsEdge(t *testing.T) {
	for _, err := range []error{
		edge.ErrUnreachable,
		edge.ErrRejected,
		&edge.RemoteError{Status: 404, Code: "not_found"},
		errors.New("boom"),
	} {
		f := newUnpairFixture(t, peerEdge, err)
		f.dialOnce(t)
		if got := f.unpaired(); len(got) != 0 {
			t.Fatalf("%v: Unpaired = %v", err, got)
		}
	}
}

// FR-EPR-2: 주소를 모르는 간선에는 걸지 않는다.
func TestNoDialWithoutAddress(t *testing.T) {
	e := peerEdge
	e.Addr, e.Port = "", 0
	f := newUnpairFixture(t, e, nil)
	f.s.dialEdges(context.Background(), time.Now())
	f.s.mu.Lock()
	d := f.s.dialing[e.Fingerprint]
	f.s.mu.Unlock()
	if d != nil || f.dials.Load() != 0 {
		t.Fatal("주소 없는 간선에 걸었다")
	}
}

// FR-EPR-23: 간선을 지우면 그 간선의 채팅 연결을 바로 닫는다. 다음 점검 주기를 기다리지 않는다.
func TestDropClosesLinkAtOnce(t *testing.T) {
	a, b := newTestNode(t, "a"), newTestNode(t, "b")
	defer link(a, b)()
	linked := func(n *testNode, fp string) bool {
		n.Service.mu.Lock()
		defer n.Service.mu.Unlock()
		_, ok := n.links[fp]
		return ok
	}
	if !linked(a, b.fp()) {
		t.Fatal("시험 전제: 이어져 있어야 한다")
	}
	a.Drop(b.fp())
	if linked(a, b.fp()) {
		t.Fatal("Drop 뒤에도 연결이 남았다")
	}
	eventually(t, "상대 쪽도 연결이 끊긴다", func() bool { return !linked(b, a.fp()) })
	a.Drop(b.fp()) // 없는 연결은 아무 일도 없다
}
