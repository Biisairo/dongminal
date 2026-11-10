package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/peer"
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

func (n *peerNode) call(t *testing.T, peerName, op string, args map[string]any) (int, map[string]any) {
	t.Helper()
	return n.api(t, http.MethodPost, "/api/peers/call", map[string]any{"peer": peerName, "op": op, "args": args})
}

// FR-PNW-50·71: node.info 를 짝에 보내고 결과를 그대로 받는다.
func TestPeerCallNodeInfo(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	pairNodes(t, a, b)
	code, out := a.call(t, "node-b", "node.info", nil)
	if code != http.StatusOK || out["name"] != "node-b" || out["proto"] != float64(1) {
		t.Fatalf("node.info: %d %v", code, out["_raw"])
	}
	cmds, _ := out["commands"].([]any)
	have := map[string]bool{}
	for _, c := range cmds {
		have[c.(string)] = true
	}
	for _, want := range []string{"node.info", "agents.list", "message.send"} {
		if !have[want] {
			t.Errorf("commands 에 %s 가 없다: %v", want, cmds)
		}
	}
	if _, ok := out["agents"].([]any); !ok {
		t.Errorf("agents 가 목록이 아니다: %v", out["_raw"])
	}
	if _, ok := out["allowedDirs"].([]any); !ok {
		t.Errorf("allowedDirs 가 목록이 아니다: %v", out["_raw"])
	}
	// FR-PNW-73: 응답을 받은 시각이 남는다.
	if p := a.peers(t)[0]; p["lastSeen"] == nil {
		t.Errorf("lastSeen 이 없다: %v", p)
	}
}

// 반대 방향도 된다 (D-5 한 번 등록하면 양방향).
func TestPeerCallBothWays(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	pairNodes(t, a, b)
	if code, out := b.call(t, "node-a", "node.info", nil); code != http.StatusOK || out["name"] != "node-a" {
		t.Fatalf("B→A node.info: %d %v", code, out["_raw"])
	}
}

func TestPeerCallRefusals(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	pairNodes(t, a, b)
	if code, out := a.call(t, "nope", "node.info", nil); code != http.StatusNotFound || errCode(out) != "peer_not_found" {
		t.Fatalf("없는 짝: %d %v", code, out["_raw"])
	}
	if code, out := a.call(t, "node-b", "shell.exec", nil); code != http.StatusBadRequest || errCode(out) != "peer_unknown_op" {
		t.Fatalf("모르는 명령: %d %v", code, out["_raw"])
	}
	// FR-PNW-31: B 가 해제하면 A 의 요청은 거절된다.
	if code, _ := b.api(t, http.MethodPost, "/api/peers/remove", map[string]any{"name": "node-a"}); code != http.StatusOK {
		t.Fatal("remove")
	}
	if code, out := a.call(t, "node-b", "node.info", nil); code != http.StatusBadGateway || errCode(out) != "peer_rejected" {
		t.Fatalf("해제 뒤: %d %v", code, out["_raw"])
	}
}

// FR-PNW-28: confirm 을 받지 못한 A 가 node.info 에 성공하면 B 를 짝으로 바꾼다.
func TestPeerCallRecoversPendingOut(t *testing.T) {
	ac := &fakeCommandBroker{}
	a := newPeerNodeWith(t, "node-a", false, Deps{Commands: ac})
	b := newPeerNode(t, "node-b", true)
	pairNodes(t, a, b)
	if ap := a.peers(t); ap[0]["state"] != peer.StatePendingOut {
		t.Fatalf("전제: pending-out 이어야 한다 %v", ap)
	}
	peersChanged(t, ac)
	if code, out := a.call(t, "node-b", "node.info", nil); code != http.StatusOK {
		t.Fatalf("node.info: %d %v", code, out["_raw"])
	}
	if ap := a.peers(t); ap[0]["state"] != peer.StatePaired {
		t.Fatalf("짝으로 바뀌지 않았다 %v", ap)
	}
	// C2: 바뀌었으면 화면에 알린다. 이미 짝이면 다시 알리지 않는다.
	if got := peersChanged(t, ac); len(got) != 1 {
		t.Fatalf("회복 뒤 방송 %v", got)
	}
	if code, out := a.call(t, "node-b", "node.info", nil); code != http.StatusOK {
		t.Fatalf("두 번째 node.info: %d %v", code, out["_raw"])
	}
	if got := peersChanged(t, ac); len(got) != 0 {
		t.Fatalf("이미 짝인데 방송했다 %v", got)
	}
}

// FR-PNW-43: 짝마다 분당 60회를 넘으면 429.
func TestPeerCallRateLimited(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	pairNodes(t, a, b)
	var last int
	var out map[string]any
	for i := 0; i <= peer.PerPeerPerMinute; i++ {
		last, out = a.call(t, "node-b", "node.info", nil)
	}
	if last != http.StatusTooManyRequests || errCode(out) != "peer_rate_limited" {
		t.Fatalf("61번째: %d %v", last, out["_raw"])
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
