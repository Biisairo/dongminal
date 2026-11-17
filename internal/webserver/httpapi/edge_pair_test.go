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
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/testpath"
)

// NFR-PNW-3: 한 프로세스 안의 서버 둘(홈·포트가 다르다)로 짝맞춤을 검증한다.

type edgeNode struct {
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

// newEdgeNode 는 노드 포트를 켤지 정해 서버 하나를 세운다.
func newEdgeNode(t *testing.T, name string, enabled bool) *edgeNode {
	t.Helper()
	home := t.TempDir()
	cfg := edge.Config{Enabled: enabled, Port: freeLoopbackPort(t), Bind: "127.0.0.1", Name: name}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(home, dmenv.EdgesFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := srv.StartEdge(stop)
	t.Cleanup(func() { close(stop); <-done })
	return &edgeNode{srv: srv, home: home}
}

// api 는 로컬 API 한 번이다. 상태와 본문을 돌려준다.
func (n *edgeNode) api(t *testing.T, method, path string, body any) (int, map[string]any) {
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

func (n *edgeNode) fingerprint(t *testing.T) string {
	t.Helper()
	_, view := n.api(t, http.MethodGet, "/api/edges", nil)
	node, _ := view["node"].(map[string]any)
	fp, _ := node["fingerprint"].(string)
	if len(fp) != 64 {
		t.Fatalf("지문 %q", fp)
	}
	return fp
}

func (n *edgeNode) invite(t *testing.T) string {
	t.Helper()
	code, out := n.api(t, http.MethodPost, "/api/edges/invite", map[string]any{"addr": "127.0.0.1"})
	if code != http.StatusOK {
		t.Fatalf("invite: %d %v", code, out["_raw"])
	}
	c, _ := out["code"].(string)
	if !strings.HasPrefix(c, edge.InvitePrefix) || out["expires"] == nil {
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

func (n *edgeNode) edges(t *testing.T) []map[string]any {
	t.Helper()
	_, v := n.api(t, http.MethodGet, "/api/edges", nil)
	return listOf(v, "edges")
}

func errCode(v map[string]any) string { s, _ := v["code"].(string); return s }

// EDGE_PAIRING_SRS TC-EPR-9: invite → add 한 번으로 양쪽이 간선이다. 승인 대기는 없다.
func TestPairFullFlow(t *testing.T) {
	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	invite := b.invite(t)

	code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": invite})
	if code != http.StatusOK || out["name"] != "node-b" || out["fp"] != b.fingerprint(t) {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	bp := b.edges(t)
	if len(bp) != 1 || bp[0]["name"] != "node-a" || bp[0]["fp"] != a.fingerprint(t) || bp[0]["addr"] == "" {
		t.Fatalf("B 의 간선 %v", bp)
	}
	ap := a.edges(t)
	if len(ap) != 1 || ap[0]["name"] != "node-b" || ap[0]["fp"] != b.fingerprint(t) {
		t.Fatalf("A 의 간선 %v", ap)
	}
	if _, has := ap[0]["state"]; has {
		t.Fatalf("간선 항목에 state 가 있다: %v", ap[0])
	}
	_, view := b.api(t, http.MethodGet, "/api/edges", nil)
	if _, has := view["pending"]; has {
		t.Fatal("조회에 pending 이 있다")
	}
	// FR-PNW-95 · I-3: 조회에 토큰이 나오지 않는다.
	tok := strings.TrimPrefix(invite, edge.InvitePrefix)
	if strings.Contains(view["_raw"].(string), tok) {
		t.Fatal("조회 응답에 초대 코드가 보인다")
	}
}

// FR-EPR-53: 승인 대기 경로는 없다.
func TestPendingPathsGone(t *testing.T) {
	n := newEdgeNode(t, "node-a", true)
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/edges/pending"},
		{http.MethodPost, "/api/edges/approve"},
		{http.MethodPost, "/api/edges/reject"},
	} {
		if code, _ := n.api(t, c.method, c.path, map[string]any{}); code != http.StatusNotFound {
			t.Errorf("%s %s = %d", c.method, c.path, code)
		}
	}
}

// FR-PNW-22: 지문이 다르면 아무것도 보내지 않는다.
func TestPairFingerprintMismatch(t *testing.T) {
	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	ic, err := edge.DecodeInvite(b.invite(t))
	if err != nil {
		t.Fatal(err)
	}
	ic.Fingerprint = strings.Repeat("ee", 32)
	code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": edge.EncodeInvite(ic)})
	if code == http.StatusOK || errCode(out) != "edge_fingerprint_mismatch" {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if len(b.edges(t)) != 0 || len(a.edges(t)) != 0 || !b.srv.edgeNode.Pairing().HasInvite() {
		t.Fatal("지문이 다른데 무언가 저장했거나 초대를 썼다")
	}
}

// FR-PNW-24: 틀린 토큰은 거절된다.
func TestPairBadToken(t *testing.T) {
	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	ic, _ := edge.DecodeInvite(b.invite(t))
	ic.Token = strings.Repeat("00", 16)
	code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": edge.EncodeInvite(ic)})
	if code != http.StatusForbidden || errCode(out) != "edge_token_invalid" {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if len(b.edges(t)) != 0 || len(a.edges(t)) != 0 {
		t.Fatal("틀린 토큰인데 무언가 저장됐다")
	}
}

// 초대 코드 모양이 틀리면 400.
func TestPairInvalidCode(t *testing.T) {
	a := newEdgeNode(t, "node-a", true)
	code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": "nope"})
	if code != http.StatusBadRequest || errCode(out) != "edge_invite_invalid" {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
}

// FR-EPR-2: A 의 노드 포트가 닫혀 있어도 맺어진다. B 는 A 의 주소를 모른다.
func TestPairWhenCallerPortClosed(t *testing.T) {
	a := newEdgeNode(t, "node-a", false)
	b := newEdgeNode(t, "node-b", true)
	code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": b.invite(t)})
	if code != http.StatusOK {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if _, has := out["warning"]; has {
		t.Fatalf("경고가 남았다: %v", out)
	}
	bp := b.edges(t)
	if len(bp) != 1 || bp[0]["addr"] != "" || bp[0]["port"] != float64(0) {
		t.Fatalf("B 의 간선 %v", bp)
	}
	if len(a.edges(t)) != 1 {
		t.Fatal("A 에 간선이 없다")
	}
}

// I-6: 포트가 닫혀 있으면 초대를 만들지 않는다. 주소가 없어도 만들지 않는다.
func TestInviteRequirements(t *testing.T) {
	closed := newEdgeNode(t, "node-c", false)
	if code, out := closed.api(t, http.MethodPost, "/api/edges/invite", map[string]any{"addr": "127.0.0.1"}); code != http.StatusConflict || errCode(out) != "edge_port_closed" {
		t.Fatalf("닫힌 포트: %d %v", code, out["_raw"])
	}
	open := newEdgeNode(t, "node-o", true)
	if code, out := open.api(t, http.MethodPost, "/api/edges/invite", map[string]any{}); code != http.StatusBadRequest || errCode(out) != "edge_addr_required" {
		t.Fatalf("주소 없음: %d %v", code, out["_raw"])
	}
}

// TC-EPR-6: 지문(앞자리)으로 지우고 주소를 고친다. 상대에 닿지 못해도 이쪽은 지운다.
func TestEdgeRemoveAndAddress(t *testing.T) {
	n := newEdgeNode(t, "node-a", true)
	fp := "12345678" + strings.Repeat("dd", 28)
	other := "12345678" + strings.Repeat("ee", 28)
	for _, f := range []string{fp, other} {
		if err := n.srv.edgeNode.Store().AddEdge(edge.Edge{Name: "b", Addr: "127.0.0.1", Port: freeLoopbackPort(t), Fingerprint: f}); err != nil {
			t.Fatal(err)
		}
	}
	if code, out := n.api(t, http.MethodPut, "/api/edges/address", map[string]any{"fp": "12345678", "addr": "10.0.0.5", "port": 60000}); code != http.StatusBadRequest || errCode(out) != "edge_ambiguous" {
		t.Fatalf("겹치는 앞자리: %d %v", code, out["_raw"])
	}
	if code, out := n.api(t, http.MethodPut, "/api/edges/address", map[string]any{"fp": fp[:12], "addr": "127.0.0.1", "port": 60000}); code != http.StatusOK || out["fp"] != fp {
		t.Fatalf("address: %d %v", code, out["_raw"])
	}
	e, _ := n.srv.edgeNode.Store().Resolve(fp)
	if e.Port != 60000 {
		t.Fatalf("주소 %+v", e)
	}
	code, out := n.api(t, http.MethodPost, "/api/edges/remove", map[string]any{"fp": fp[:12]})
	if code != http.StatusOK || out["fp"] != fp || out["name"] != "b" || out["notified"] != false {
		t.Fatalf("remove: %d %v", code, out["_raw"])
	}
	if n.srv.edgeNode.Store().IsEdge(fp) || !n.srv.edgeNode.Store().IsEdge(other) {
		t.Fatal("지운 간선이 남았거나 다른 간선이 지워졌다")
	}
	if code, out := n.api(t, http.MethodPost, "/api/edges/remove", map[string]any{"fp": fp}); code != http.StatusNotFound || errCode(out) != "edge_not_found" {
		t.Fatalf("없는 간선 지우기: %d %v", code, out["_raw"])
	}
}

// TC-EPR-4: 한쪽에서 지우면 상대 쪽에서도 지워진다.
func TestEdgeRemoveNotifiesPeer(t *testing.T) {
	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	pairNodes(t, a, b)
	code, out := a.api(t, http.MethodPost, "/api/edges/remove", map[string]any{"fp": b.fingerprint(t)})
	if code != http.StatusOK || out["notified"] != true {
		t.Fatalf("remove: %d %v", code, out["_raw"])
	}
	if len(a.edges(t)) != 0 || len(b.edges(t)) != 0 {
		t.Fatal("한쪽에 간선이 남았다")
	}
}

// I-8 · FR-PNW-8: 노드 설정을 바꾸면 노드 포트에 바로 적용된다.
func TestEdgeNodePut(t *testing.T) {
	n := newEdgeNode(t, "node-a", false)
	port := freeLoopbackPort(t)
	body := map[string]any{"enabled": true, "port": port, "bind": "127.0.0.1", "name": "renamed", "advertise": ""}
	if code, out := n.api(t, http.MethodPut, "/api/edges/node", body); code != http.StatusOK {
		t.Fatalf("PUT: %d %v", code, out["_raw"])
	}
	_, v := n.api(t, http.MethodGet, "/api/edges", nil)
	node := v["node"].(map[string]any)
	if node["listening"] != true || node["name"] != "renamed" {
		t.Fatalf("적용되지 않았다: %v", node)
	}
	body["name"] = "bad name"
	if code, out := n.api(t, http.MethodPut, "/api/edges/node", body); code != http.StatusBadRequest || errCode(out) != "edge_config_invalid" {
		t.Fatalf("틀린 이름: %d %v", code, out["_raw"])
	}
}

// FR-EPR-6: 쓰인 초대로 다른 노드가 add 하면 edge_no_invite 다.
func TestPairAddConsumedInvite(t *testing.T) {
	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	c := newEdgeNode(t, "node-c", true)
	invite := b.invite(t)
	if code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": invite}); code != http.StatusOK {
		t.Fatalf("첫 add: %d %v", code, out["_raw"])
	}
	code, out := c.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": invite})
	if code != http.StatusForbidden || errCode(out) != "edge_no_invite" {
		t.Fatalf("쓰인 초대: %d %v", code, out["_raw"])
	}
	if len(c.edges(t)) != 0 {
		t.Fatal("거절됐는데 저장했다")
	}
}

// D-EPR-5: B 가 저장에 실패하면 A 는 save_failed 를 받고 아무것도 저장하지 않는다. 같은 코드로
// 다시 시도하면 맺어진다 — 초대는 쓰였어도 같은 지문의 다시 시도를 받는다.
func TestPairSaveFailureThenRetry(t *testing.T) {
	if !testpath.PermChecked() {
		t.Skip("디렉터리 권한으로 쓰기 실패를 만드는 검사다")
	}
	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	invite := b.invite(t)
	dir := b.srv.cfg.DataDir
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": invite})
	if code == http.StatusOK || errCode(out) != "save_failed" || len(a.edges(t)) != 0 {
		t.Fatalf("add: %d %v", code, out["_raw"])
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": invite}); code != http.StatusOK {
		t.Fatalf("다시 시도: %d %v", code, out["_raw"])
	}
	if len(a.edges(t)) != 1 || len(b.edges(t)) != 1 {
		t.Fatal("다시 시도 뒤 양쪽이 간선이 아니다")
	}
}

// FR-EPR-7: 이미 간선인 노드와 새 초대로 다시 맺어도 간선 하나다.
func TestPairReAdd(t *testing.T) {
	a := newEdgeNode(t, "node-a", true)
	b := newEdgeNode(t, "node-b", true)
	pairNodes(t, a, b)
	if code, out := a.api(t, http.MethodPost, "/api/edges/add", map[string]any{"code": b.invite(t)}); code != http.StatusOK {
		t.Fatalf("다시 add: %d %v", code, out["_raw"])
	}
	if len(a.edges(t)) != 1 || len(b.edges(t)) != 1 {
		t.Fatalf("간선이 겹쳤다: %v / %v", a.edges(t), b.edges(t))
	}
}

// 리뷰 C-15: 쓸 수 없는 주소(zone 이 붙은 link-local 등)로 온 맺기 요청은 초대를 쓰기 전에
// 거절한다.
func TestPairRejectsUnusableAddrBeforeConsume(t *testing.T) {
	b := newEdgeNode(t, "node-b", true)
	ic, err := edge.DecodeInvite(b.invite(t))
	if err != nil {
		t.Fatal(err)
	}
	body := `{"token":"` + ic.Token + `","name":"a","addr":"","port":58147,"proto":1}`
	req := httptest.NewRequest(http.MethodPost, testEdgePairPath, strings.NewReader(body))
	req.RemoteAddr = "[fe80::1%en0]:40000"
	rec := httptest.NewRecorder()
	b.srv.edgeNode.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "edge_config_invalid") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if !b.srv.edgeNode.Pairing().HasInvite() || len(b.edges(t)) != 0 {
		t.Fatal("초대를 썼거나 간선을 남겼다")
	}
}

// S9: 맺기 요청도 출발지 주소마다 분당 상한을 지난다. 넘으면 429 이고 감사 로그를 쌓지 않는다.
func TestPairRateLimited(t *testing.T) {
	logs := captureLog(t)
	b := newEdgeNode(t, "node-b", true)
	b.invite(t)
	body := `{"token":"nope","name":"a","addr":"10.0.0.2","port":58147,"proto":1}`
	var rec *httptest.ResponseRecorder
	for i := 0; i <= edge.PerKeyPerMinute; i++ {
		req := httptest.NewRequest(http.MethodPost, testEdgePairPath, strings.NewReader(body))
		rec = httptest.NewRecorder()
		b.srv.edgeNode.Handler().ServeHTTP(rec, req)
	}
	if rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), "edge_rate_limited") {
		t.Fatalf("61번째: %d %s", rec.Code, rec.Body.String())
	}
	if n := strings.Count(logs.String(), "op=pair "); n != edge.PerKeyPerMinute {
		t.Fatalf("감사 줄 %d, 기대 %d (넘은 요청은 남기지 않는다)", n, edge.PerKeyPerMinute)
	}
	// 지문은 상대가 바꿀 수 있으므로 출발지 주소로 센다. 다른 주소는 막히지 않는다.
	req := httptest.NewRequest(http.MethodPost, testEdgePairPath, strings.NewReader(body))
	req.RemoteAddr = "10.0.0.9:40000"
	rec = httptest.NewRecorder()
	b.srv.edgeNode.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("다른 주소: %d %s", rec.Code, rec.Body.String())
	}
}

// FR-EPR-41: 간선이 아닌 상대는 pair 에만 닿는다. 초대가 쓰인 뒤에는 처리기가
// edge_no_invite 로 거절한다.
func TestPairPathForStrangers(t *testing.T) {
	b := newEdgeNode(t, "node-b", true)
	adm := b.srv.edgeNode.Admission()
	stranger := strings.Repeat("ee", 32)
	if !adm.TLS(stranger) || !adm.Request(stranger, testEdgePairPath) {
		t.Fatal("간선이 아닌 상대를 pair 에서 막았다")
	}
	if adm.Request(stranger, "/edge/v1/unpair") || adm.Request(stranger, "/edge/v1/chat") {
		t.Fatal("간선이 아닌 상대를 unpair·chat 에 들였다")
	}
	ic, err := edge.DecodeInvite(b.invite(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := b.srv.edgeNode.Pairing().Redeem(ic.Token, strings.Repeat("dd", 32)); err != nil {
		t.Fatal(err)
	}
	body := `{"token":"` + ic.Token + `","name":"s"}`
	req := httptest.NewRequest(http.MethodPost, testEdgePairPath, strings.NewReader(body))
	rec := httptest.NewRecorder()
	b.srv.edgeNode.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "edge_no_invite") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}
