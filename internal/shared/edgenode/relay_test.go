package edgenode

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgerelay"
)

// relayNode 는 데몬 모드의 노드 하나다 — 서버 쪽 통로(노드 포트 Port·발신 소켓)와 데몬 쪽
// 노드(노드 소켓을 듣는 리스너, 발신 소켓을 지나는 클라이언트).
func relayNode(t *testing.T, name string) *Node {
	t.Helper()
	home, err := os.MkdirTemp("", "en")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	cfg := edge.Config{Enabled: true, Port: freePort(t), Bind: "127.0.0.1", Name: name, Advertise: "127.0.0.1"}
	raw, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(home, dmenv.EdgesFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	dialLn, err := edgerelay.ListenDial(edgerelay.DialSocketPath(home))
	if err != nil {
		t.Fatal(err)
	}
	go edgerelay.ServeDial(dialLn)
	t.Cleanup(func() { _ = dialLn.Close() })
	port := edgerelay.NewPort(edgerelay.NodeSocketPath(home))
	t.Cleanup(port.Close)
	n, err := New(Options{Home: home, Hostname: name, Dial: edgerelay.Dialer(edgerelay.DialSocketPath(home)), PortStatus: port.Status})
	if err != nil {
		t.Fatal(err)
	}
	ln := edge.NewListener(n.Identity(), n.Admission(), n.Handler())
	ln.UseListen(func(string, int) (net.Listener, error) { return edgerelay.ListenNode(edgerelay.NodeSocketPath(home)) })
	ln.Apply(n.Config())
	t.Cleanup(ln.Close)
	c := n.Config()
	port.Apply(c.Enabled, c.Bind, c.Port)
	return n
}

// TC-PDM-4 (FR-PDM-20~22·2): 서버는 바이트만 잇고 TLS·판정은 노드가 한다. 통로를 지나도
// 간선 맺기 전 과정이 통로 없이 맺을 때와 같다.
func TestRelayPairFullFlow(t *testing.T) {
	a := relayNode(t, "node-a")
	b := relayNode(t, "node-b")
	do := func(n *Node, op string, args any) Response {
		raw, _ := json.Marshal(args)
		return n.Do(t.Context(), Request{Op: op, Args: raw})
	}
	inv := do(b, "invite", map[string]any{})
	if inv.Status != http.StatusOK {
		t.Fatalf("invite %d %s %s", inv.Status, inv.Code, inv.Message)
	}
	code, _ := body(t, inv)["code"].(string)
	if add := do(a, "add", map[string]any{"code": code}); add.Status != http.StatusOK {
		t.Fatalf("add %d %s %s", add.Status, add.Code, add.Message)
	}
	if !a.Store().IsEdge(b.Identity().Fingerprint) || !b.Store().IsEdge(a.Identity().Fingerprint) {
		t.Fatal("양쪽이 간선이 아니다")
	}
}
