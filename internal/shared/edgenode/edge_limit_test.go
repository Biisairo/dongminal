package edgenode

import (
	"fmt"
	"net/http"
	"testing"

	"dongminal/internal/shared/edge"
)

// ATTIC_FIX_SRS TC-ATF-80 (FR-ATF-80 · AT-ECFG-3): 간선이 가득 찬 노드는 더 맺지 않는다.

func fillEdges(t *testing.T, tn *testNode) {
	t.Helper()
	for i := range edge.MaxEdges {
		e := edge.Edge{Name: fmt.Sprintf("n%d", i), Fingerprint: fmt.Sprintf("%064x", i+1)}
		if err := tn.Store().AddEdge(e); err != nil {
			t.Fatal(err)
		}
	}
}

// 맺는 쪽(A)이 가득 차면 상대에게 묻기 전에 bad_request 로 거절한다.
func TestAddRejectedWhenFull(t *testing.T) {
	a, b := newTestNode(t, "node-a"), newTestNode(t, "node-b")
	fillEdges(t, a)
	add := a.do(t, "add", map[string]any{"code": inviteCode(t, b)})
	if add.Status != http.StatusBadRequest || add.Code != CodeBadRequest {
		t.Fatalf("add %d %s %s, want 400 %s", add.Status, add.Code, add.Message, CodeBadRequest)
	}
	if len(a.Config().Edges) != edge.MaxEdges || len(b.Config().Edges) != 0 {
		t.Fatalf("간선 수 A=%d B=%d", len(a.Config().Edges), len(b.Config().Edges))
	}
}

// 받는 쪽(B)이 가득 차면 초대를 쓰지 않고 bad_request 로 거절한다. A 도 간선을 더하지 않는다.
func TestPairRejectedWhenPeerFull(t *testing.T) {
	a, b := newTestNode(t, "node-a"), newTestNode(t, "node-b")
	fillEdges(t, b)
	code := inviteCode(t, b)
	add := a.do(t, "add", map[string]any{"code": code})
	if add.Status != http.StatusBadRequest || add.Code != CodeBadRequest {
		t.Fatalf("add %d %s %s, want 400 %s", add.Status, add.Code, add.Message, CodeBadRequest)
	}
	if len(a.Config().Edges) != 0 || len(b.Config().Edges) != edge.MaxEdges {
		t.Fatalf("간선 수 A=%d B=%d", len(a.Config().Edges), len(b.Config().Edges))
	}
	// 초대는 남는다 — B 가 간선을 비우면 같은 코드로 맺는다.
	if err := b.Store().Remove(fmt.Sprintf("%064x", 1)); err != nil {
		t.Fatal(err)
	}
	if add := a.do(t, "add", map[string]any{"code": code}); add.Status != http.StatusOK {
		t.Fatalf("비운 뒤 add %d %s %s", add.Status, add.Code, add.Message)
	}
}
