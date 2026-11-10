package httpapi

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/peer"
)

// NFR-PNW-3: 한 프로세스 안의 서버 둘(홈·포트가 다르다)로 짝맞춤을 검증한다.

type peerNode struct {
	srv  *Server
	home string
}

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return p
}

// newPeerNode 는 노드 포트를 켤지 정해 서버 하나를 세운다.
func newPeerNode(t *testing.T, name string, enabled bool) *peerNode {
	t.Helper()
	home := t.TempDir()
	cfg := peer.Config{Enabled: enabled, Port: freeLoopbackPort(t), Bind: "127.0.0.1", Name: name}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(home, dmenv.PeersFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := srv.StartPeer(stop)
	t.Cleanup(func() { close(stop); <-done })
	return &peerNode{srv: srv, home: home}
}

// api 는 로컬 API 한 번이다. 상태와 본문을 돌려준다.
func (n *peerNode) api(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var rd *strings.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = strings.NewReader(string(raw))
	} else {
		rd = strings.NewReader("")
	}
	req := apiTestRequest(method, path, rd)
	req.RemoteAddr = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	n.srv.Handler().ServeHTTP(rec, req)
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	out["_raw"] = rec.Body.String()
	return rec.Code, out
}

func (n *peerNode) fingerprint(t *testing.T) string {
	t.Helper()
	_, view := n.api(t, http.MethodGet, "/api/peers", nil)
	node, _ := view["node"].(map[string]any)
	fp, _ := node["fingerprint"].(string)
	if len(fp) != 64 {
		t.Fatalf("지문 %q", fp)
	}
	return fp
}

func (n *peerNode) invite(t *testing.T) string {
	t.Helper()
	code, out := n.api(t, http.MethodPost, "/api/peers/invite", map[string]any{"addr": "127.0.0.1"})
	if code != http.StatusOK {
		t.Fatalf("invite: %d %v", code, out["_raw"])
	}
	c, _ := out["code"].(string)
	if !strings.HasPrefix(c, peer.InvitePrefix) || out["expires"] == nil {
		t.Fatalf("invite 응답 %v", out)
	}
	return c
}

func listOf(v map[string]any, key string) []map[string]any {
	raw, _ := v[key].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, x := range raw {
		m, _ := x.(map[string]any)
		out = append(out, m)
	}
	return out
}

func (n *peerNode) peers(t *testing.T) []map[string]any {
	t.Helper()
	_, v := n.api(t, http.MethodGet, "/api/peers", nil)
	return listOf(v, "peers")
}

func (n *peerNode) pending(t *testing.T) []map[string]any {
	t.Helper()
	code, v := n.api(t, http.MethodGet, "/api/peers/pending", nil)
	if code != http.StatusOK {
		t.Fatalf("pending: %d", code)
	}
	return listOf(v, "pending")
}

func errCode(v map[string]any) string { s, _ := v["code"].(string); return s }

// FR-PNW-20~27: invite → add → 승인 대기 → approve → confirm.
func TestPairFullFlow(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	invite := b.invite(t)

	code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": invite})
	if code != http.StatusOK || out["name"] != "node-b" || out["state"] != peer.StatePendingOut {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if w, _ := out["warning"].(string); w != "" {
		t.Fatalf("포트가 열려 있는데 경고 %q", w)
	}

	pend := b.pending(t)
	if len(pend) != 1 || pend[0]["name"] != "node-a" || pend[0]["fp"] != a.fingerprint(t) {
		t.Fatalf("승인 대기 %v", pend)
	}
	code, out = b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": pend[0]["id"]})
	if code != http.StatusOK || out["confirmed"] != true || out["fp"] != a.fingerprint(t) {
		t.Fatalf("approve: %d %v", code, out["_raw"])
	}

	bp := b.peers(t)
	if len(bp) != 1 || bp[0]["name"] != "node-a" || bp[0]["fp"] != a.fingerprint(t) || bp[0]["state"] != "" {
		t.Fatalf("B 의 짝 %v", bp)
	}
	ap := a.peers(t)
	if len(ap) != 1 || ap[0]["name"] != "node-b" || ap[0]["fp"] != b.fingerprint(t) || ap[0]["state"] != "" {
		t.Fatalf("A 의 짝 %v", ap)
	}
	if len(b.pending(t)) != 0 {
		t.Fatal("승인 뒤 승인 대기가 남았다")
	}
	// FR-PNW-95 · I-3: 조회에 토큰이 나오지 않는다.
	tok := strings.TrimPrefix(invite, peer.InvitePrefix)
	if _, raw := b.api(t, http.MethodGet, "/api/peers", nil); strings.Contains(raw["_raw"].(string), tok) {
		t.Fatal("조회 응답에 초대 코드가 보인다")
	}
}

// FR-PNW-22: 지문이 다르면 아무것도 보내지 않는다.
func TestPairFingerprintMismatch(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	ic, err := peer.DecodeInvite(b.invite(t))
	if err != nil {
		t.Fatal(err)
	}
	ic.Fingerprint = strings.Repeat("ee", 32)
	code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": peer.EncodeInvite(ic)})
	if code == http.StatusOK || errCode(out) != "peer_fingerprint_mismatch" {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if len(b.pending(t)) != 0 || len(a.peers(t)) != 0 {
		t.Fatal("지문이 다른데 무언가 저장됐다")
	}
}

// FR-PNW-24: 틀린 토큰은 거절된다.
func TestPairBadToken(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	ic, _ := peer.DecodeInvite(b.invite(t))
	ic.Token = strings.Repeat("00", 16)
	code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": peer.EncodeInvite(ic)})
	if code != http.StatusForbidden || errCode(out) != "peer_token_invalid" {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if len(b.pending(t)) != 0 || len(a.peers(t)) != 0 {
		t.Fatal("틀린 토큰인데 무언가 저장됐다")
	}
}

// 초대 코드 모양이 틀리면 400.
func TestPairInvalidCode(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": "nope"})
	if code != http.StatusBadRequest || errCode(out) != "peer_invite_invalid" {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
}

// FR-PNW-29: 거절하면 B 는 아무것도 저장하지 않는다.
func TestPairReject(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	if code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": b.invite(t)}); code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	id := b.pending(t)[0]["id"]
	if code, out := b.api(t, http.MethodPost, "/api/peers/reject", map[string]any{"id": id}); code != http.StatusOK {
		t.Fatalf("reject: %d %v", code, out["_raw"])
	}
	if len(b.pending(t)) != 0 || len(b.peers(t)) != 0 {
		t.Fatal("거절 뒤에 남았다")
	}
	if code, out := b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": id}); code != http.StatusNotFound || errCode(out) != "peer_pending_not_found" {
		t.Fatalf("거절한 것을 승인: %d %v", code, out["_raw"])
	}
}

// FR-PNW-30: 이름이 겹치면 승인할 때 다른 이름을 정한다.
func TestPairApproveNameTaken(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	if err := b.srv.peers.AddPeer(peer.Peer{Name: "node-a", Addr: "10.9.9.9", Port: 1, Fingerprint: strings.Repeat("dd", 32)}); err != nil {
		t.Fatal(err)
	}
	if code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": b.invite(t)}); code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	id := b.pending(t)[0]["id"]
	code, out := b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": id})
	if code != http.StatusConflict || errCode(out) != "peer_name_taken" {
		t.Fatalf("approve: %d %v", code, out["_raw"])
	}
	if len(b.pending(t)) != 1 {
		t.Fatal("이름 충돌로 승인 대기가 사라졌다")
	}
	if code, out := b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": id, "name": "laptop"}); code != http.StatusOK {
		t.Fatalf("approve --name: %d %v", code, out["_raw"])
	}
	found := false
	for _, p := range b.peers(t) {
		if p["name"] == "laptop" && p["fp"] == a.fingerprint(t) {
			found = true
		}
	}
	if !found {
		t.Fatalf("새 이름으로 저장되지 않았다: %v", b.peers(t))
	}
}

// I-5: --name 이 이미 있으면 B 에 닿기 전에 거절한다 — 토큰을 쓰지 않는다.
func TestPairAddNameTakenBeforeConnect(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	if err := a.srv.peers.AddPeer(peer.Peer{Name: "office", Addr: "h", Port: 1, Fingerprint: strings.Repeat("dd", 32)}); err != nil {
		t.Fatal(err)
	}
	code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": b.invite(t), "name": "office"})
	if code != http.StatusConflict || errCode(out) != "peer_name_taken" {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if len(b.pending(t)) != 0 || !b.srv.pairing.HasInvite() {
		t.Fatal("거절했는데 B 의 초대를 썼다")
	}
}

// FR-PNW-33 · I-9: A 의 포트가 꺼져 있으면 미리 알리고, confirm 은 닿지 않는다.
func TestPairWhenCallerPortClosed(t *testing.T) {
	a := newPeerNode(t, "node-a", false)
	b := newPeerNode(t, "node-b", true)
	code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": b.invite(t)})
	if code != http.StatusOK || out["warning"] != "port_closed" {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	id := b.pending(t)[0]["id"]
	code, out = b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": id})
	if code != http.StatusOK || out["confirmed"] != false || out["reason"] == "" {
		t.Fatalf("approve: %d %v", code, out["_raw"])
	}
	if len(b.peers(t)) != 1 {
		t.Fatal("confirm 실패로 B 의 짝이 사라졌다")
	}
	if ap := a.peers(t); len(ap) != 1 || ap[0]["state"] != peer.StatePendingOut {
		t.Fatalf("A 는 pending-out 이어야 한다: %v", ap)
	}
}

// I-6: 포트가 닫혀 있으면 초대를 만들지 않는다. 주소가 없어도 만들지 않는다.
func TestInviteRequirements(t *testing.T) {
	closed := newPeerNode(t, "node-c", false)
	if code, out := closed.api(t, http.MethodPost, "/api/peers/invite", map[string]any{"addr": "127.0.0.1"}); code != http.StatusConflict || errCode(out) != "peer_port_closed" {
		t.Fatalf("닫힌 포트: %d %v", code, out["_raw"])
	}
	open := newPeerNode(t, "node-o", true)
	if code, out := open.api(t, http.MethodPost, "/api/peers/invite", map[string]any{}); code != http.StatusBadRequest || errCode(out) != "peer_addr_required" {
		t.Fatalf("주소 없음: %d %v", code, out["_raw"])
	}
}

// FR-PNW-31·32: 해제와 주소 수정.
func TestPeerRemoveAndAddress(t *testing.T) {
	n := newPeerNode(t, "node-a", true)
	fp := strings.Repeat("dd", 32)
	if err := n.srv.peers.AddPeer(peer.Peer{Name: "b", Addr: "h", Port: 1, Fingerprint: fp}); err != nil {
		t.Fatal(err)
	}
	if code, out := n.api(t, http.MethodPut, "/api/peers/address", map[string]any{"name": "b", "addr": "10.0.0.5", "port": 60000}); code != http.StatusOK {
		t.Fatalf("address: %d %v", code, out["_raw"])
	}
	if p := n.peers(t)[0]; p["addr"] != "10.0.0.5" || p["port"] != float64(60000) {
		t.Fatalf("주소 %v", p)
	}
	if code, out := n.api(t, http.MethodPost, "/api/peers/remove", map[string]any{"name": "b"}); code != http.StatusOK {
		t.Fatalf("remove: %d %v", code, out["_raw"])
	}
	if n.srv.peers.IsPeer(fp) {
		t.Fatal("해제 뒤에도 짝이다")
	}
	if code, out := n.api(t, http.MethodPost, "/api/peers/remove", map[string]any{"name": "b"}); code != http.StatusNotFound || errCode(out) != "peer_not_found" {
		t.Fatalf("없는 짝 해제: %d %v", code, out["_raw"])
	}
}

// I-8 · FR-PNW-8: 노드 설정을 바꾸면 노드 포트에 바로 적용된다.
func TestPeerNodePut(t *testing.T) {
	n := newPeerNode(t, "node-a", false)
	port := freeLoopbackPort(t)
	body := map[string]any{"enabled": true, "port": port, "bind": "127.0.0.1", "name": "renamed", "advertise": "", "allowedDirs": []string{}}
	if code, out := n.api(t, http.MethodPut, "/api/peers/node", body); code != http.StatusOK {
		t.Fatalf("PUT: %d %v", code, out["_raw"])
	}
	_, v := n.api(t, http.MethodGet, "/api/peers", nil)
	node := v["node"].(map[string]any)
	if node["listening"] != true || node["name"] != "renamed" {
		t.Fatalf("적용되지 않았다: %v", node)
	}
	body["name"] = "bad name"
	if code, out := n.api(t, http.MethodPut, "/api/peers/node", body); code != http.StatusBadRequest || errCode(out) != "peer_config_invalid" {
		t.Fatalf("틀린 이름: %d %v", code, out["_raw"])
	}
}

// M-5: 쓰인(또는 만료된) 초대로 add 하면 상대는 TLS 단계에서 거절한다. 그때도 안내는
// peer_no_invite 다 — errors.md 가 그렇게 말한다.
func TestPairAddConsumedInvite(t *testing.T) {
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	c := newPeerNode(t, "node-c", true)
	invite := b.invite(t)
	if code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": invite}); code != http.StatusOK {
		t.Fatalf("첫 add: %d %v", code, out["_raw"])
	}
	code, out := c.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": invite})
	if code != http.StatusForbidden || errCode(out) != "peer_no_invite" {
		t.Fatalf("쓰인 초대: %d %v", code, out["_raw"])
	}
	if len(c.peers(t)) != 0 {
		t.Fatal("거절됐는데 저장했다")
	}
}

// L-6: confirm 을 받은 쪽이 저장에 실패하면 거절(403)이 아니라 save_failed 다.
func TestPairConfirmSaveFailure(t *testing.T) {
	if !testpath.PermChecked() {
		t.Skip("디렉터리 권한으로 쓰기 실패를 만드는 검사다")
	}
	a := newPeerNode(t, "node-a", true)
	b := newPeerNode(t, "node-b", true)
	if code, out := a.api(t, http.MethodPost, "/api/peers/add", map[string]any{"code": b.invite(t)}); code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	dir := a.srv.cfg.DataDir
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	pend := b.pending(t)
	code, out := b.api(t, http.MethodPost, "/api/peers/approve", map[string]any{"id": pend[0]["id"]})
	if code != http.StatusOK || out["confirmed"] != false {
		t.Fatalf("approve: %d %v", code, out["_raw"])
	}
	if r, _ := out["reason"].(string); !strings.Contains(r, "save_failed") {
		t.Fatalf("사유 %q", r)
	}
}

// L-1: 저장소 오류는 종류대로 가른다.
func TestPeerStoreFailCodes(t *testing.T) {
	cases := map[error]string{
		peer.ErrNameTaken:    "peer_name_taken",
		peer.ErrSaveFailed:   "save_failed",
		peer.ErrPeerNotFound: "peer_not_found",
	}
	for err, want := range cases {
		rec := httptest.NewRecorder()
		peerStoreFail(rec, err)
		if !strings.Contains(rec.Body.String(), `"`+want+`"`) {
			t.Errorf("%v → %d %s", err, rec.Code, rec.Body.String())
		}
	}
}
