package edgenode

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/edge"
)

// PEER_DAEMON_SRS §3.5a, FR-PDM-2: 노드 하나의 상태와 연산.

type testNode struct {
	*Node
	ln *edge.Listener
	mu sync.Mutex
	// notes 는 Notify 로 받은 값이다.
	notes []Change
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// newTestNode 는 TCP 노드 포트를 직접 듣는 노드다(통로 없이).
func newTestNode(t *testing.T, name string) *testNode {
	t.Helper()
	return newTestNodeOpts(t, name, false)
}

// newTestNodeOpts 는 mesh 면 간선 계층을 세운 노드다 (EDGE_MESH_SRS FR-EGM-1).
func newTestNodeOpts(t *testing.T, name string, mesh bool) *testNode {
	t.Helper()
	home := t.TempDir()
	cfg := edge.Config{Enabled: true, Port: freePort(t), Bind: "127.0.0.1", Name: name, Advertise: "127.0.0.1"}
	raw, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(home, dmenv.EdgesFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	tn := &testNode{}
	n, err := New(Options{
		Home:       home,
		Hostname:   name,
		Mesh:       mesh,
		PortStatus: func() edge.Status { return tn.ln.Status() },
		OnConfig:   func(c edge.Config) { tn.ln.Apply(c) },
		Notify: func(c Change) {
			tn.mu.Lock()
			tn.notes = append(tn.notes, c)
			tn.mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	tn.Node = n
	tn.ln = edge.NewListener(n.Identity(), n.Admission(), n.Handler())
	tn.ln.Apply(n.Config())
	t.Cleanup(tn.ln.Close)
	return tn
}

func (tn *testNode) do(t *testing.T, op string, args any) Response {
	t.Helper()
	raw, _ := json.Marshal(args)
	return tn.Do(context.Background(), Request{Op: op, Args: raw})
}

func body(t *testing.T, r Response) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.Body, &m); err != nil {
		t.Fatalf("body %q: %v", r.Body, err)
	}
	return m
}

// TC-PDM-11 (축약): Do 만으로 초대 → 맺기가 돈다.
func TestNodePairViaDo(t *testing.T) {
	a := newTestNode(t, "node-a")
	b := newTestNode(t, "node-b")
	pairNodes(t, a, b)
	if !a.Store().IsEdge(b.Identity().Fingerprint) || !b.Store().IsEdge(a.Identity().Fingerprint) {
		t.Fatal("양쪽이 간선이 아니다")
	}
	// A 의 노드 포트가 열려 있었으므로 B 는 A 의 주소를 안다 (FR-EPR-2).
	if e, _ := b.Store().Resolve(a.Identity().Fingerprint); e.Addr != "127.0.0.1" || e.Port != a.Config().Port {
		t.Fatalf("B 가 저장한 A 의 주소 = %s:%d", e.Addr, e.Port)
	}
}

// FR-PDM-30: get 은 ETag 를 싣고, 낡은 If-Match 의 node 는 409 stale_revision 이다.
func TestNodeGetAndStaleNode(t *testing.T) {
	n := newTestNode(t, "node-a")
	g := n.do(t, "get", nil)
	if g.Status != http.StatusOK || g.ETag == "" {
		t.Fatalf("get %d etag=%q", g.Status, g.ETag)
	}
	cfg := n.Config()
	cfg.Name = "renamed"
	raw, _ := json.Marshal(cfg)
	if r := n.Do(context.Background(), Request{Op: "node", Args: raw, IfMatch: g.ETag}); r.Status != http.StatusOK {
		t.Fatalf("node %d %s", r.Status, r.Code)
	}
	r := n.Do(context.Background(), Request{Op: "node", Args: raw, IfMatch: g.ETag})
	if r.Status != http.StatusConflict || r.Code != CodeStaleRev || r.ETag == "" {
		t.Fatalf("stale %d %s etag=%q", r.Status, r.Code, r.ETag)
	}
}

func TestNodeUnknownOpAndBadJSON(t *testing.T) {
	n := newTestNode(t, "node-a")
	if r := n.Do(context.Background(), Request{Op: "nope"}); r.Status != http.StatusNotFound || r.Code != CodeNotFound {
		t.Fatalf("unknown op %d %s", r.Status, r.Code)
	}
	if r := n.Do(context.Background(), Request{Op: "add", Args: json.RawMessage("{")}); r.Status != http.StatusBadRequest || r.Code != CodeInvalidJSON {
		t.Fatalf("bad json %d %s", r.Status, r.Code)
	}
}

// 노드 설정을 바꾸면 OnConfig 로 노드 포트에 바로 적용된다.
func TestNodeConfigAppliesPort(t *testing.T) {
	n := newTestNode(t, "node-a")
	cfg := n.Config()
	cfg.Enabled = false
	raw, _ := json.Marshal(cfg)
	if r := n.Do(context.Background(), Request{Op: "node", Args: raw}); r.Status != http.StatusOK {
		t.Fatalf("node %d", r.Status)
	}
	if n.ln.Status().Listening {
		t.Fatal("끈 노드 포트가 열려 있다")
	}
}

// FR-PNW-6: 노드 포트는 `/edge/v1/*` 의 맺기·지우기·간선 연결만 받는다. 나머지는 404 다.
// (DIRECT_MODE_REMOVAL_SRS: 서버의 직접 노드 시험에서 옮겨 왔다.)
func TestHandlerOnlyEdgePaths(t *testing.T) {
	h := newTestNode(t, "node-a").Handler()
	for _, p := range []string{"/", "/index.html", "/api/tools", "/api/edges", "/ws", "/edge", "/edge/v2/node.info", "/peer/v1/pair"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: code %d, 기대 404", p, rec.Code)
		}
	}
}

// FR-PNW-42: 모르는 경로는 404 와 `{code, message}` 다.
func TestHandlerUnknownPath(t *testing.T) {
	rec := httptest.NewRecorder()
	newTestNode(t, "node-a").Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/edge/v1/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code %d, 기대 404", rec.Code)
	}
	var body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("본문이 JSON 이 아니다: %q", rec.Body.String())
	}
	if body.Code != CodeNotFound || body.Message == "" {
		t.Fatalf("본문 %+v", body)
	}
}

// FR-PDM-71 (TC-PDM-26): 노드가 설 때 peers.json 을 edges.json 으로 옮긴다.
func TestNewMigratesLegacyFile(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, dmenv.LegacyPeersFile), []byte(`{"name":"moved"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	n, err := New(Options{Home: home, Hostname: "h"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(n.Close)
	if _, err := os.Stat(filepath.Join(home, dmenv.LegacyPeersFile)); !os.IsNotExist(err) {
		t.Fatalf("peers.json 이 남았다: %v", err)
	}
	if got := n.Config().Name; got != "moved" {
		t.Fatalf("옮긴 설정을 읽지 않았다: %q", got)
	}
}
