package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/toolipc"
)

// FR-PNW-81·82: 짝 상태가 바뀌면 화면에 `edges_changed` 를 민다. 화면은 주기로 묻지 않는다.

func newEdgeNodeObserved(t *testing.T, name string) (*edgeNode, *fakeCommandBroker) {
	t.Helper()
	cmds := &fakeCommandBroker{}
	return newEdgeNodeWith(t, name, true, Deps{Commands: cmds}), cmds
}

func edgeFixture(name string) edge.Edge {
	return edge.Edge{Name: name, Addr: "127.0.0.1", Port: 1, Fingerprint: strings.Repeat("dd", 32)}
}

// edgesChanged 는 방송된 `edges_changed` 의 args 를 차례로 꺼내고 비운다.
func edgesChanged(t *testing.T, f *fakeCommandBroker) []map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, p := range f.published {
		var m struct {
			Action string         `json:"action"`
			Args   map[string]any `json:"args"`
		}
		if json.Unmarshal(p, &m) == nil && m.Action == "edges_changed" {
			out = append(out, m.Args)
		}
	}
	f.published = nil
	return out
}

// FR-EPR-5: 맺으면 양쪽이 `paired` `{fp, name}` 을 방송한다.
func TestEdgesChangedOnPairing(t *testing.T) {
	a, ac := newEdgeNodeObserved(t, "node-a")
	b, bc := newEdgeNodeObserved(t, "node-b")
	invite := b.invite(t)
	if got := edgesChanged(t, bc); len(got) != 1 {
		t.Fatalf("초대 뒤 B 의 방송 %v", got)
	}
	if code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": invite}); code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if got := edgesChanged(t, bc); len(got) != 1 || refOf(got[0], "paired")["name"] != "node-a" || refOf(got[0], "paired")["fp"] != a.fingerprint(t) {
		t.Fatalf("B 의 방송 %v", got)
	}
	if got := edgesChanged(t, ac); len(got) != 1 || refOf(got[0], "paired")["name"] != "node-b" {
		t.Fatalf("A 의 방송 %v", got)
	}
}

// FR-EPR-23: 지우면 양쪽이 `removed` `{fp, name}` 을 방송한다.
func TestEdgesChangedOnRemove(t *testing.T) {
	a, ac := newEdgeNodeObserved(t, "node-a")
	b, bc := newEdgeNodeObserved(t, "node-b")
	pairNodes(t, a, b)
	edgesChanged(t, ac)
	edgesChanged(t, bc)
	if code, out := a.api(t, http.MethodPost, "/api/edges/remove", map[string]any{"fp": b.fingerprint(t)}); code != http.StatusOK {
		t.Fatalf("remove: %d %v", code, out["_raw"])
	}
	if got := edgesChanged(t, ac); len(got) != 1 || refOf(got[0], "removed")["name"] != "node-b" || got[0]["byPeer"] != nil {
		t.Fatalf("A 의 방송 %v", got)
	}
	if got := edgesChanged(t, bc); len(got) != 1 || refOf(got[0], "removed")["fp"] != a.fingerprint(t) || got[0]["byPeer"] != true {
		t.Fatalf("B 의 방송 %v", got)
	}
}

func refOf(args map[string]any, key string) map[string]any {
	m, _ := args[key].(map[string]any)
	return m
}

func TestEdgesChangedOnLocalEdits(t *testing.T) {
	b, bc := newEdgeNodeObserved(t, "node-b")
	if code, out := b.api(t, http.MethodPut, "/api/edges/node", map[string]any{"enabled": true, "port": freeLoopbackPort(t), "bind": "127.0.0.1", "name": "node-b2", "advertise": ""}); code != http.StatusOK {
		t.Fatalf("node: %d %v", code, out["_raw"])
	}
	if got := edgesChanged(t, bc); len(got) != 1 {
		t.Fatalf("node 뒤 방송 %v", got)
	}
	fx := edgeFixture("c")
	if err := b.srv.edgeNode.Store().AddEdge(fx); err != nil {
		t.Fatal(err)
	}
	for _, s := range []struct {
		method, path string
		body         map[string]any
	}{
		{http.MethodPut, "/api/edges/address", map[string]any{"fp": fx.Fingerprint, "addr": "127.0.0.1", "port": 1}},
		{http.MethodPost, "/api/edges/remove", map[string]any{"fp": fx.Fingerprint}},
	} {
		if code, out := b.api(t, s.method, s.path, s.body); code != http.StatusOK {
			t.Fatalf("%s: %d %v", s.path, code, out["_raw"])
		}
		if got := edgesChanged(t, bc); len(got) != 1 {
			t.Fatalf("%s 뒤 방송 %v", s.path, got)
		}
	}
	if code, _ := b.api(t, http.MethodPost, "/api/edges/remove", map[string]any{"fp": fx.Fingerprint}); code != http.StatusNotFound {
		t.Fatal("없는 간선 지우기가 성공했다")
	}
	if got := edgesChanged(t, bc); len(got) != 0 {
		t.Fatalf("실패한 지우기가 방송됐다 %v", got)
	}
}

// 재연결의 복원은 스냅샷 한 요청에 든다 (FR-OPT-4-5).
func TestSnapshotHasEdgesPart(t *testing.T) {
	n := newEdgeNode(t, "node-a", true)
	code, out := n.api(t, http.MethodGet, "/api/snapshot?parts=edges", nil)
	if code != http.StatusOK {
		t.Fatalf("snapshot: %d", code)
	}
	p, _ := out["edges"].(map[string]any)
	node, _ := p["node"].(map[string]any)
	if node == nil || node["name"] != "node-a" {
		t.Fatalf("edges 조각 %v", out["_raw"])
	}
}

// FR-EPR-23: 데몬의 edges push 는 byPeer 까지 그대로 방송한다.
func TestEdgePushedCarriesByPeer(t *testing.T) {
	cmds := &fakeCommandBroker{}
	srv := &Server{}
	srv.Commands = cmds
	srv.EdgePushed(toolipc.EdgesEvent{Event: toolipc.EventEdges, Removed: &toolipc.EdgeRef{FP: "f", Name: "b"}, ByPeer: true})
	got := edgesChanged(t, cmds)
	if len(got) != 1 || refOf(got[0], "removed")["name"] != "b" || got[0]["byPeer"] != true {
		t.Fatalf("방송 %v", got)
	}
}
