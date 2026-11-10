package peer

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync/atomic"
	"testing"
)

// clientFixture 는 서버 노드 하나와 그것을 부르는 클라이언트 노드 하나다.
type clientFixture struct {
	server Identity
	caller Identity
	target Target
	hits   atomic.Int64
}

func newClientFixture(t *testing.T, h http.HandlerFunc) *clientFixture {
	t.Helper()
	f := &clientFixture{}
	var err error
	if f.server, err = LoadOrCreateIdentity(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if f.caller, err = LoadOrCreateIdentity(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	callerFP := f.caller.Fingerprint
	ln := NewListener(f.server, PeersOnly(func(fp string) bool { return fp == callerFP }),
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			f.hits.Add(1)
			h(w, r)
		}))
	t.Cleanup(ln.Close)
	ln.Apply(enabledAt(freePort(t)))
	host, port, _ := net.SplitHostPort(ln.Status().Addr)
	p, _ := strconv.Atoi(port)
	f.target = Target{Addr: host, Port: p, Fingerprint: f.server.Fingerprint}
	return f
}

func echo(w http.ResponseWriter, r *http.Request) {
	var in map[string]any
	_ = json.NewDecoder(r.Body).Decode(&in)
	in["path"] = r.URL.Path
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(in)
}

// FR-PNW-40·71: POST JSON 을 보내고 JSON 을 받는다.
func TestClientCall(t *testing.T) {
	f := newClientFixture(t, echo)
	var out map[string]any
	err := NewClient(f.caller).Call(context.Background(), f.target, "/peer/v1/x", map[string]any{"a": "b"}, &out)
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if out["a"] != "b" || out["path"] != "/peer/v1/x" {
		t.Fatalf("응답 %v", out)
	}
}

// FR-PNW-22: 서버 지문이 다르면 아무것도 보내지 않고 실패한다.
func TestClientFingerprintMismatch(t *testing.T) {
	f := newClientFixture(t, echo)
	wrong := f.target
	wrong.Fingerprint = fpOf("ee")
	err := NewClient(f.caller).Call(context.Background(), wrong, "/peer/v1/x", map[string]any{}, nil)
	if !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("Call = %v, 기대 ErrFingerprintMismatch", err)
	}
	if f.hits.Load() != 0 {
		t.Fatal("지문이 다른데 요청이 닿았다")
	}
}

// FR-PNW-74 · D-7: 닿지 않으면 ErrUnreachable.
func TestClientUnreachable(t *testing.T) {
	caller, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tgt := Target{Addr: "127.0.0.1", Port: freePort(t), Fingerprint: fpOf("aa")}
	if err := NewClient(caller).Call(context.Background(), tgt, "/peer/v1/x", nil, nil); !errors.Is(err, ErrUnreachable) {
		t.Fatalf("Call = %v, 기대 ErrUnreachable", err)
	}
}

// FR-PNW-42: 상대의 `{code,message}` 를 RemoteError 로 옮긴다.
func TestClientRemoteError(t *testing.T) {
	f := newClientFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"peer_token_invalid","message":"bad token"}`))
	})
	err := NewClient(f.caller).Call(context.Background(), f.target, "/peer/v1/pair", map[string]any{}, nil)
	var re *RemoteError
	if !errors.As(err, &re) || re.Status != http.StatusForbidden || re.Code != "peer_token_invalid" || re.Message != "bad token" {
		t.Fatalf("Call = %#v", err)
	}
}

// 상대가 이 노드를 짝으로 모르면(TLS 거절) 닿지 않은 것과 갈라 알린다.
func TestClientRejectedByPeer(t *testing.T) {
	f := newClientFixture(t, echo)
	stranger, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	err = NewClient(stranger).Call(context.Background(), f.target, "/peer/v1/x", map[string]any{}, nil)
	if !errors.Is(err, ErrRejected) {
		t.Fatalf("Call = %v, 기대 ErrRejected", err)
	}
}
