package edgenode

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"

	"dongminal/internal/shared/edge"
)

// PEER_CHAT_SRS §3.9, TC-PCH-14: 채팅 연결 경로는 간선 상대만 닿고, 채팅이 없으면 404 다.

func pairNodes(t *testing.T, a, b *testNode) {
	t.Helper()
	inv := b.do(t, "invite", map[string]any{})
	code, _ := body(t, inv)["code"].(string)
	if add := a.do(t, "add", map[string]any{"code": code}); add.Status != http.StatusOK {
		t.Fatalf("add %d %s %s", add.Status, add.Code, add.Message)
	}
	id := body(t, b.do(t, "pending", nil))["pending"].([]any)[0].(map[string]any)["id"]
	if ap := b.do(t, "approve", map[string]any{"id": id}); ap.Status != http.StatusOK {
		t.Fatalf("approve %d %s", ap.Status, ap.Body)
	}
}

func targetOf(t *testing.T, tn *testNode) edge.Target {
	t.Helper()
	host, port, _ := net.SplitHostPort(tn.ln.Status().Addr)
	p, _ := strconv.Atoi(port)
	return edge.Target{Addr: host, Port: p, Fingerprint: tn.Identity().Fingerprint}
}

func TestChatPathUpgradesForEdge(t *testing.T) {
	hit := make(chan string, 1)
	chat := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, ok := edge.AcceptUpgrade(w, r, "dmchat1")
		if !ok {
			return
		}
		hit <- edge.ClientFingerprint(r)
		_ = conn.Close()
	})
	a := newTestNode(t, "node-a")
	b := newTestNodeWith(t, "node-b", chat)
	pairNodes(t, a, b)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := edge.NewClient(a.Identity()).Upgrade(ctx, targetOf(t, b), chatPath, "dmchat1")
	if err != nil {
		t.Fatalf("Upgrade: %v", err)
	}
	_ = conn.Close()
	select {
	case fp := <-hit:
		if fp != a.Identity().Fingerprint {
			t.Fatalf("fp = %s", fp)
		}
	case <-ctx.Done():
		t.Fatal("채팅 핸들러가 불리지 않았다")
	}
}

func TestChatPathWithoutChatIs404(t *testing.T) {
	a := newTestNode(t, "node-a")
	b := newTestNode(t, "node-b")
	pairNodes(t, a, b)
	_, err := edge.NewClient(a.Identity()).Upgrade(context.Background(), targetOf(t, b), chatPath, "dmchat1")
	var re *edge.RemoteError
	if !errors.As(err, &re) || re.Status != http.StatusNotFound {
		t.Fatalf("err = %v, want 404", err)
	}
}

func TestChatPathRejectsNonEdge(t *testing.T) {
	b := newTestNodeWith(t, "node-b", http.NotFoundHandler())
	stranger := newTestNode(t, "stranger")
	_, err := edge.NewClient(stranger.Identity()).Upgrade(context.Background(), targetOf(t, b), chatPath, "dmchat1")
	if !errors.Is(err, edge.ErrRejected) {
		t.Fatalf("err = %v, want ErrRejected", err)
	}
}
