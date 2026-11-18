package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/webserver/apierr"
)

// DIRECT_MODE_REMOVAL_SRS FR-DMR-20 (TC-DMR-5): 서버는 자기 안에 노드를 세우지 않는다. 노드
// 신원은 데몬이 만든다 — 데몬 없이 선 서버는 신원 파일도 노드 포트도 만들지 않는다.
func TestNewDoesNotCreateNodeIdentity(t *testing.T) {
	home := t.TempDir()
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{dmenv.EdgeKeyFile, dmenv.EdgeCertFile, dmenv.EdgesFile} {
		if _, err := os.Stat(filepath.Join(home, f)); !os.IsNotExist(err) {
			t.Fatalf("%s 가 생겼다: %v", f, err)
		}
	}
	stop := make(chan struct{})
	close(stop)
	select {
	case <-srv.StartEdge(stop):
	default:
		t.Fatal("데몬이 없는데 StartEdge 가 곧바로 끝나지 않았다")
	}
}

// 직접 지은 Server 에서도 패닉하지 않는다.
func TestStartEdgeWithoutDaemon(t *testing.T) {
	srv := &Server{}
	stop := make(chan struct{})
	close(stop)
	<-srv.StartEdge(stop)
}

// FR-DMR-21 (TC-DMR-3): 데몬이 배선되지 않은 서버의 간선 API 는 503 edge_unavailable 이다.
func TestEdgeAPIWithoutDaemonIsUnavailable(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	n := &edgeNode{srv: srv}
	code, out := n.api(t, http.MethodGet, "/api/edges", nil)
	if code != http.StatusServiceUnavailable || errCode(out) != apierr.CodeEdgeUnavailable {
		t.Fatalf("code=%d out=%v, want 503 %s", code, out, apierr.CodeEdgeUnavailable)
	}
}
