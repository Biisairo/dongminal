package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/peer"
)

// FR-PNW-81·82: 짝 상태가 바뀌면 화면에 `peers_changed` 를 민다. 화면은 주기로 묻지 않는다.

func newPeerNodeObserved(t *testing.T, name string) (*peerNode, *fakeCommandBroker) {
	t.Helper()
	cmds := &fakeCommandBroker{}
	return newPeerNodeWith(t, name, true, Deps{Commands: cmds}), cmds
}

func peerFixture(name string) peer.Peer {
	return peer.Peer{Name: name, Addr: "h", Port: 1, Fingerprint: strings.Repeat("dd", 32)}
}

// peersChanged 는 방송된 `peers_changed` 의 args 를 차례로 꺼내고 비운다.
func peersChanged(t *testing.T, f *fakeCommandBroker) []map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, p := range f.published {
		var m struct {
			Action string         `json:"action"`
			Args   map[string]any `json:"args"`
		}
		if json.Unmarshal(p, &m) == nil && m.Action == "peers_changed" {
			out = append(out, m.Args)
		}
	}
	f.published = nil
	return out
}

func TestPeersChangedOnPairing(t *testing.T) {
	a, ac := newPeerNodeObserved(t, "node-a")
	b, bc := newPeerNodeObserved(t, "node-b")
	invite := b.invite(t)
	if got := peersChanged(t, bc); len(got) != 1 {
		t.Fatalf("초대 뒤 B 의 방송 %v", got)
	}
	if code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": invite}); code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if got := peersChanged(t, bc); len(got) != 1 || got[0]["paired"] != nil {
		t.Fatalf("승인 대기가 생긴 B 의 방송 %v", got)
	}
	if got := peersChanged(t, ac); len(got) != 1 {
		t.Fatalf("등록을 요청한 A 의 방송 %v", got)
	}
	id := b.pending(t)[0]["id"]
	if code, out := b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": id}); code != http.StatusOK {
		t.Fatalf("approve: %d %v", code, out["_raw"])
	}
	if got := peersChanged(t, bc); len(got) != 1 || got[0]["paired"] != "node-a" {
		t.Fatalf("승인한 B 의 방송 %v", got)
	}
	if got := peersChanged(t, ac); len(got) != 1 || got[0]["paired"] != nil {
		t.Fatalf("confirm 을 받은 A 의 방송 %v", got)
	}
}

// 이름 충돌로 승인하지 못하면 바뀐 것이 없다 — 방송하지 않는다.
func TestPeersChangedNotOnFailedApprove(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b, bc := newPeerNodeObserved(t, "node-b")
	if code, out := b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": "nope"}); code != http.StatusNotFound {
		t.Fatalf("approve: %d %v", code, out["_raw"])
	}
	if code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": b.invite(t)}); code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	peersChanged(t, bc)
	if code, _ := b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": b.pending(t)[0]["id"], "name": "bad name"}); code == http.StatusOK {
		t.Fatal("틀린 이름으로 승인됐다")
	}
	if got := peersChanged(t, bc); len(got) != 0 {
		t.Fatalf("실패한 승인이 방송됐다 %v", got)
	}
}

func TestPeersChangedOnLocalEdits(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b, bc := newPeerNodeObserved(t, "node-b")
	if code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": b.invite(t)}); code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	peersChanged(t, bc)
	steps := []struct {
		method, path string
		body         func() map[string]any
	}{
		{http.MethodPost, "/api/peers/reject", func() map[string]any { return map[string]any{"id": b.pending(t)[0]["id"]} }},
		{http.MethodPut, "/api/peers/node", func() map[string]any {
			return map[string]any{"enabled": true, "port": freeLoopbackPort(t), "bind": "127.0.0.1", "name": "node-b2", "advertise": "", "allowedDirs": []string{}}
		}},
	}
	for _, s := range steps {
		if code, out := b.api(t, s.method, s.path, s.body()); code != http.StatusOK {
			t.Fatalf("%s: %d %v", s.path, code, out["_raw"])
		}
		if got := peersChanged(t, bc); len(got) != 1 {
			t.Fatalf("%s 뒤 방송 %v", s.path, got)
		}
	}
	if err := b.srv.peers.AddPeer(peerFixture("c")); err != nil {
		t.Fatal(err)
	}
	for _, s := range []struct {
		method, path string
		body         map[string]any
	}{
		{http.MethodPut, "/api/peers/address", map[string]any{"name": "c", "addr": "10.0.0.7", "port": 60001}},
		{http.MethodPost, "/api/peers/remove", map[string]any{"name": "c"}},
	} {
		if code, out := b.api(t, s.method, s.path, s.body); code != http.StatusOK {
			t.Fatalf("%s: %d %v", s.path, code, out["_raw"])
		}
		if got := peersChanged(t, bc); len(got) != 1 {
			t.Fatalf("%s 뒤 방송 %v", s.path, got)
		}
	}
	if code, _ := b.api(t, http.MethodPost, "/api/peers/remove", map[string]any{"name": "c"}); code != http.StatusNotFound {
		t.Fatal("없는 짝 해제가 성공했다")
	}
	if got := peersChanged(t, bc); len(got) != 0 {
		t.Fatalf("실패한 해제가 방송됐다 %v", got)
	}
}

// 재연결의 복원은 스냅샷 한 요청에 든다 (FR-OPT-4-5).
func TestSnapshotHasPeersPart(t *testing.T) {
	n := newPeerNode(t, "node-a", true)
	code, out := n.api(t, http.MethodGet, "/api/snapshot?parts=peers", nil)
	if code != http.StatusOK {
		t.Fatalf("snapshot: %d", code)
	}
	p, _ := out["peers"].(map[string]any)
	node, _ := p["node"].(map[string]any)
	if node == nil || node["name"] != "node-a" {
		t.Fatalf("peers 조각 %v", out["_raw"])
	}
}

// UX_BATCH12 TC-LIV-6 (FR-LIV-9): 짝에게서 인증된 호출을 받으면 그 짝의 마지막 응답 시각이
// 갱신되고, 그 갱신의 방송은 짝마다 60초에 한 번이다.
func TestPeersChangedOnInboundSeenThrottled(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b, bc := newPeerNodeObserved(t, "node-b")
	pairNodes(t, a, b)
	peersChanged(t, bc)
	for i := 0; i < 2; i++ {
		if code, out := a.call(t, "node-b", "node.info", nil); code != http.StatusOK {
			t.Fatalf("node.info %d: %d %v", i, code, out["_raw"])
		}
	}
	if p := b.peers(t)[0]; p["lastSeen"] == nil {
		t.Fatalf("받은 쪽의 lastSeen 이 없다: %v", p)
	}
	if got := peersChanged(t, bc); len(got) != 1 {
		t.Fatalf("60초 안의 두 호출에 방송 %d번, want 1: %v", len(got), got)
	}
}
