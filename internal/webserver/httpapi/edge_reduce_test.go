package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/edge"
)

// pairNodes 는 a 와 b 를 간선으로 맺는다 (b 가 초대, a 가 add).
func pairNodes(t *testing.T, a, b *edgeNode) {
	t.Helper()
	if code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": b.invite(t)}); code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
}

func newEdgeNodeWith(t *testing.T, name string, enabled bool, deps Deps) *edgeNode {
	t.Helper()
	home := t.TempDir()
	cfg := edge.Config{Enabled: enabled, Port: freeLoopbackPort(t), Bind: "127.0.0.1", Name: name}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(home, dmenv.EdgesFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{DataDir: home}, deps)
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := srv.StartEdge(stop)
	t.Cleanup(func() { close(stop); <-done })
	return &edgeNode{srv: srv, home: home}
}

// PEER_DAEMON_SRS FR-PDM-60·61 (TC-PDM-20): 짝이어도 옛 명령 경로는 404 다. 로컬 call 도 없다.
func TestEdgeCommandsRemoved(t *testing.T) {
	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	pairNodes(t, a, b)
	tgt := edge.Target{Addr: "127.0.0.1", Port: b.srv.edgeNode.Store().Config().Port, Fingerprint: b.srv.edgeNode.Identity().Fingerprint}
	for _, op := range []string{"node.info", "agents.list", "message.send", "agent.spawn", "agent.status", "agent.close"} {
		err := edge.NewClient(a.srv.edgeNode.Identity()).Call(context.Background(), tgt, testEdgePrefix+op, map[string]any{}, nil)
		var re *edge.RemoteError
		if !errors.As(err, &re) || re.Status != http.StatusNotFound {
			t.Errorf("%s: %v, 기대 404", op, err)
		}
	}
	if code, _ := a.api(t, http.MethodPost, "/api/edges/call", map[string]any{"peer": "node-b", "op": "node.info"}); code != http.StatusNotFound {
		t.Errorf("/api/edges/call: %d, 기대 404", code)
	}
}

// FR-PDM-64 (TC-PDM-22): 남은 peer-spawns.json 은 노드 계층이 설 때 지운다.
func TestEdgeSpawnsFileRemoved(t *testing.T) {
	home := t.TempDir()
	stale := filepath.Join(home, "peer-spawns.json")
	if err := os.WriteFile(stale, []byte(`{"t1":"fp"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(Config{DataDir: home}, Deps{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("peer-spawns.json 이 남았다: %v", err)
	}
}

// FR-PDM-65·66 (TC-PDM-23): allowedDirs 는 읽을 때 버리고 PUT 도 무시한다. lastSeen 은 없다.
func TestEdgeAllowedDirsAndLastSeenRemoved(t *testing.T) {
	home := t.TempDir()
	raw := `{"enabled":false,"port":58147,"bind":"127.0.0.1","name":"n","allowedDirs":["/tmp"]}`
	if err := os.WriteFile(filepath.Join(home, dmenv.EdgesFile), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	n := &edgeNode{srv: srv, home: home}
	_, view := n.api(t, http.MethodGet, "/api/edges", nil)
	if node, _ := view["node"].(map[string]any); node == nil || node["allowedDirs"] != nil {
		t.Fatalf("조회에 allowedDirs 가 있다: %v", view["_raw"])
	}
	put := map[string]any{"enabled": false, "port": 58147, "bind": "127.0.0.1", "name": "n2", "allowedDirs": []string{"/tmp"}}
	if code, out := n.api(t, http.MethodPut, "/api/edges/node", put); code != http.StatusOK {
		t.Fatalf("PUT: %d %v", code, out["_raw"])
	}
	saved, _ := os.ReadFile(filepath.Join(home, dmenv.EdgesFile))
	if strings.Contains(string(saved), "allowedDirs") {
		t.Fatalf("파일에 allowedDirs 가 남았다: %s", saved)
	}

	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	pairNodes(t, a, b)
	for _, p := range append(a.edges(t), b.edges(t)...) {
		if _, ok := p["lastSeen"]; ok {
			t.Fatalf("lastSeen 이 있다: %v", p)
		}
	}
}

// FR-PDM-63 (TC-PDM-24): 로컬 엔벨로프 인용은 PEER 표지를 다루지 않는다.
func TestQuoteEnvelopeIgnoresPeerMarker(t *testing.T) {
	in := "[DONGMINAL-PEER-MSG x]"
	if got := quoteEnvelope(in); got != in {
		t.Fatalf("%q", got)
	}
}
