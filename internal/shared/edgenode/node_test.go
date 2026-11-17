package edgenode

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
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
	// notes 는 Notify 로 받은 paired 값이다.
	notes []string
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

// newTestNode 는 직접 모드처럼 TCP 노드 포트를 직접 듣는 노드다.
func newTestNode(t *testing.T, name string) *testNode {
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
		PortStatus: func() edge.Status { return tn.ln.Status() },
		OnConfig:   func(c edge.Config) { tn.ln.Apply(c) },
		Notify: func(paired string) {
			tn.mu.Lock()
			tn.notes = append(tn.notes, paired)
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

// TC-PDM-11 (축약): Do 만으로 초대 → 등록 → 승인이 돈다.
func TestNodePairViaDo(t *testing.T) {
	a := newTestNode(t, "node-a")
	b := newTestNode(t, "node-b")
	inv := b.do(t, "invite", map[string]any{})
	if inv.Status != http.StatusOK {
		t.Fatalf("invite %d %s %s", inv.Status, inv.Code, inv.Message)
	}
	code, _ := body(t, inv)["code"].(string)
	if add := a.do(t, "add", map[string]any{"code": code}); add.Status != http.StatusOK {
		t.Fatalf("add %d %s %s", add.Status, add.Code, add.Message)
	}
	pend := body(t, b.do(t, "pending", nil))["pending"].([]any)
	if len(pend) != 1 {
		t.Fatalf("pending %v", pend)
	}
	id := pend[0].(map[string]any)["id"]
	ap := b.do(t, "approve", map[string]any{"id": id})
	if ap.Status != http.StatusOK || body(t, ap)["confirmed"] != true {
		t.Fatalf("approve %d %s", ap.Status, ap.Body)
	}
	if !a.Store().IsEdge(b.Identity().Fingerprint) || !b.Store().IsEdge(a.Identity().Fingerprint) {
		t.Fatal("양쪽이 간선이 아니다")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if last := b.notes[len(b.notes)-1]; last != "node-a" {
		t.Fatalf("승인 알림의 paired = %q", last)
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
