package edge

import (
	"bufio"
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

// PEER_CHAT_SRS FR-PCH-8, TC-PCH-14: 채팅 연결은 노드 포트 위의 HTTP Upgrade 다.

const testProto = "dmchat1"

func echoUpgrade(w http.ResponseWriter, r *http.Request) {
	conn, ok := AcceptUpgrade(w, r, testProto)
	if !ok {
		return
	}
	defer conn.Close()
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return
	}
	_, _ = conn.Write([]byte("echo " + line))
}

func TestUpgradeEchoes(t *testing.T) {
	f := newClientFixture(t, echoUpgrade)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := NewClient(f.caller).Upgrade(ctx, f.target, "/edge/v1/chat", testProto)
	if err != nil {
		t.Fatalf("Upgrade: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("hi\n")); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	got, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || got != "echo hi\n" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestUpgradeRejectsNonEdge(t *testing.T) {
	f := newClientFixture(t, echoUpgrade)
	stranger, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = NewClient(stranger).Upgrade(context.Background(), f.target, "/edge/v1/chat", testProto)
	if !errors.Is(err, ErrRejected) {
		t.Fatalf("err = %v, want ErrRejected", err)
	}
}

func TestUpgradeFingerprintMismatch(t *testing.T) {
	f := newClientFixture(t, echoUpgrade)
	tgt := f.target
	tgt.Fingerprint = "00"
	_, err := NewClient(f.caller).Upgrade(context.Background(), tgt, "/edge/v1/chat", testProto)
	if !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("err = %v, want ErrFingerprintMismatch", err)
	}
}

func TestUpgradeWithoutHeaderIs400(t *testing.T) {
	f := newClientFixture(t, echoUpgrade)
	err := NewClient(f.caller).Call(context.Background(), f.target, "/edge/v1/chat", map[string]any{}, nil)
	var re *RemoteError
	if !errors.As(err, &re) || re.Status != http.StatusBadRequest {
		t.Fatalf("err = %v, want 400", err)
	}
}

func TestUpgradeServerRefusalIsRemoteError(t *testing.T) {
	f := newClientFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	_, err := NewClient(f.caller).Upgrade(context.Background(), f.target, "/edge/v1/chat", testProto)
	var re *RemoteError
	if !errors.As(err, &re) || re.Status != http.StatusNotFound {
		t.Fatalf("err = %v, want 404", err)
	}
}
