package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/peer"
)

// pairNodes 는 a 와 b 를 짝으로 맺는다 (a 가 add, b 가 approve).
func pairNodes(t *testing.T, a, b *peerNode) {
	t.Helper()
	if code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": b.invite(t)}); code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	id := b.pending(t)[0]["id"]
	if code, out := b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": id}); code != http.StatusOK {
		t.Fatalf("approve: %d %v", code, out["_raw"])
	}
}

func newPeerNodeWith(t *testing.T, name string, enabled bool, deps Deps) *peerNode {
	t.Helper()
	home := t.TempDir()
	cfg := peer.Config{Enabled: enabled, Port: freeLoopbackPort(t), Bind: "127.0.0.1", Name: name}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(home, dmenv.PeersFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{DataDir: home}, deps)
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := srv.StartPeer(stop)
	t.Cleanup(func() { close(stop); <-done })
	return &peerNode{srv: srv, home: home}
}

// PEER_DAEMON_SRS FR-PDM-60·61 (TC-PDM-20): 짝이어도 옛 명령 경로는 404 다. 로컬 call 도 없다.
func TestPeerCommandsRemoved(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	pairNodes(t, a, b)
	tgt := peer.Target{Addr: "127.0.0.1", Port: b.srv.peers.Config().Port, Fingerprint: b.srv.peerID.Fingerprint}
	for _, op := range []string{"node.info", "agents.list", "message.send", "agent.spawn", "agent.status", "agent.close"} {
		err := a.srv.peerClient.Call(context.Background(), tgt, peerPathPrefix+op, map[string]any{}, nil)
		var re *peer.RemoteError
		if !errors.As(err, &re) || re.Status != http.StatusNotFound {
			t.Errorf("%s: %v, 기대 404", op, err)
		}
	}
	if code, _ := a.api(t, http.MethodPost, "/api/peers/call", map[string]any{"peer": "node-b", "op": "node.info"}); code != http.StatusNotFound {
		t.Errorf("/api/peers/call: %d, 기대 404", code)
	}
}

// FR-PDM-64 (TC-PDM-22): 남은 peer-spawns.json 은 노드 계층이 설 때 지운다.
func TestPeerSpawnsFileRemoved(t *testing.T) {
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
func TestPeerAllowedDirsAndLastSeenRemoved(t *testing.T) {
	home := t.TempDir()
	raw := `{"enabled":false,"port":58147,"bind":"127.0.0.1","name":"n","allowedDirs":["/tmp"]}`
	if err := os.WriteFile(filepath.Join(home, dmenv.PeersFile), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	n := &peerNode{srv: srv, home: home}
	_, view := n.api(t, http.MethodGet, "/api/peers", nil)
	if node, _ := view["node"].(map[string]any); node == nil || node["allowedDirs"] != nil {
		t.Fatalf("조회에 allowedDirs 가 있다: %v", view["_raw"])
	}
	put := map[string]any{"enabled": false, "port": 58147, "bind": "127.0.0.1", "name": "n2", "allowedDirs": []string{"/tmp"}}
	if code, out := n.api(t, http.MethodPut, "/api/peers/node", put); code != http.StatusOK {
		t.Fatalf("PUT: %d %v", code, out["_raw"])
	}
	saved, _ := os.ReadFile(filepath.Join(home, dmenv.PeersFile))
	if strings.Contains(string(saved), "allowedDirs") {
		t.Fatalf("파일에 allowedDirs 가 남았다: %s", saved)
	}

	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	pairNodes(t, a, b)
	for _, p := range append(a.peers(t), b.peers(t)...) {
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

// 상대의 오류는 거른 뒤에 옮긴다 — 상태는 4xx 만, 코드는 카탈로그에 있는 것만,
// 문구는 제어 문자를 지우고 자른다.
func TestPeerCallFailSanitizesRemote(t *testing.T) {
	cases := []struct {
		in         *peer.RemoteError
		wantStatus int
		wantCode   string
	}{
		{&peer.RemoteError{Status: 403, Code: "peer_token_invalid", Message: "x"}, 403, "peer_token_invalid"},
		{&peer.RemoteError{Status: 500, Code: "internal_error", Message: "x"}, http.StatusBadGateway, "internal_error"},
		{&peer.RemoteError{Status: 302, Code: "peer_token_invalid", Message: "x"}, http.StatusBadGateway, "peer_token_invalid"},
		{&peer.RemoteError{Status: 404, Code: "made_up\x1b[31m", Message: "x"}, 404, "peer_rejected"},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		peerCallFail(rec, c.in)
		var body map[string]string
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != c.wantStatus || body["code"] != c.wantCode || rec.Header().Get("X-Error-Code") != c.wantCode {
			t.Errorf("%+v → %d %v", c.in, rec.Code, body)
		}
	}
	rec := httptest.NewRecorder()
	peerCallFail(rec, &peer.RemoteError{Status: 400, Code: "bad_request", Message: "a\x1b[2J\r\nb" + strings.Repeat("z", 2000)})
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if strings.ContainsAny(body["message"], "\x1b\r\n") || len(body["message"]) > 600 {
		t.Fatalf("문구를 거르지 않았다: %q", body["message"])
	}
}
