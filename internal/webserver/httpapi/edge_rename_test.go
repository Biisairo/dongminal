package httpapi

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/edge"
)

// PEER_DAEMON_SRS FR-PDM-70, D-PDM-17 (TC-PDM-25): 짝맞춤은 새 경로·새 초대 머리로 돈다.
// 옛 노드 포트 경로와 옛 로컬 API 는 404 다.
func TestEdgeRenamedPaths(t *testing.T) {
	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	if code := b.invite(t); !strings.HasPrefix(code, "dmedge1:") {
		t.Fatalf("초대 머리: %q", code)
	}
	pairNodes(t, a, b)
	tgt := edge.Target{Addr: "127.0.0.1", Port: b.srv.edges.Config().Port, Fingerprint: b.srv.edgeID.Fingerprint}
	for _, p := range []string{"/peer/v1/pair", "/peer/v1/pair/confirm"} {
		err := a.srv.edgeClient.Call(context.Background(), tgt, p, map[string]any{}, nil)
		var re *edge.RemoteError
		if !errors.As(err, &re) || re.Status != http.StatusNotFound {
			t.Errorf("%s: %v, 기대 404", p, err)
		}
	}
	if code, _ := a.api(t, http.MethodGet, "/api/peers", nil); code != http.StatusNotFound {
		t.Errorf("GET /api/peers: %d, 기대 404", code)
	}
	if code, _ := a.api(t, http.MethodGet, "/api/edges", nil); code != http.StatusOK {
		t.Errorf("GET /api/edges: %d, 기대 200", code)
	}
}

// FR-PDM-71 (TC-PDM-26): 노드 계층이 설 때 peers.json 을 edges.json 으로 옮긴다.
func TestEdgeLegacyFileMigratedOnInit(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, dmenv.LegacyPeersFile), []byte(`{"name":"moved"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, dmenv.EdgesFile)); err != nil {
		t.Fatalf("edges.json 이 없다: %v", err)
	}
	if got := srv.edges.Config().Name; got != "moved" {
		t.Errorf("옮긴 설정을 읽지 않았다: %q", got)
	}
}
