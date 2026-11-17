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
