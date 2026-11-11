package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/apierr"
)

// UX_BATCH12 TC-LIV-1 (FR-LIV-1·2): 설정 세 종단의 GET 은 ETag 를 싣고, PUT 은 If-Match 가
// 낡았으면 409 stale_rev 로 거절하고 아무것도 바꾸지 않는다. If-Match 가 없으면 지금처럼 저장한다.

func settingsReq(h http.Handler, method, path, body, ifMatch string) *httptest.ResponseRecorder {
	req := apiTestRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:5000"
	if ifMatch != "" {
		req.Header.Set("If-Match", ifMatch)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func wantStale(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	var out struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	// httpErr 방언은 코드를 헤더로, peer 방언은 본문으로 싣는다.
	if out.Code == "" {
		out.Code = rec.Header().Get(apierr.CodeHeader)
	}
	if rec.Code != http.StatusConflict || out.Code != apierr.CodeStaleRev {
		t.Fatalf("낡은 If-Match: status=%d body=%s, want 409 %s", rec.Code, rec.Body.String(), apierr.CodeStaleRev)
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatal("409 가 지금 지문을 싣지 않았다")
	}
}

func countAction(f *fakeCommandBroker, action string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, p := range f.published {
		var m struct {
			Action string `json:"action"`
		}
		if json.Unmarshal(p, &m) == nil && m.Action == action {
			n++
		}
	}
	return n
}

func TestSettingsETag_Access(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	h := srv.Handler()
	e1 := settingsReq(h, http.MethodGet, "/api/access", "", "").Header().Get("ETag")
	if e1 == "" {
		t.Fatal("GET /api/access 가 ETag 를 싣지 않았다")
	}
	one := `{"enabled":false,"entries":[{"id":"a","value":"10.0.0.1","label":"nas","enabled":true}]}`
	rec := settingsReq(h, http.MethodPut, "/api/access", one, e1)
	if rec.Code != http.StatusOK {
		t.Fatalf("맞는 If-Match: %d %s", rec.Code, rec.Body.String())
	}
	e2 := rec.Header().Get("ETag")
	if e2 == "" || e2 == e1 {
		t.Fatalf("저장 뒤 지문이 바뀌어 응답에 실려야 한다: %q → %q", e1, e2)
	}
	two := `{"enabled":false,"entries":[]}`
	wantStale(t, settingsReq(h, http.MethodPut, "/api/access", two, e1))
	if len(srv.Access.config().Entries) != 1 {
		t.Fatal("거절된 PUT 이 값을 바꿨다")
	}
	if rec := settingsReq(h, http.MethodPut, "/api/access", two, ""); rec.Code != http.StatusOK {
		t.Fatalf("If-Match 없는 PUT: %d", rec.Code)
	}
}

func TestSettingsETag_SandboxAndBroadcast(t *testing.T) {
	reaper := &fakeReaper{}
	broker := &fakeCommandBroker{}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Sandbox: reaper, Commands: broker})
	h := srv.Handler()
	e1 := settingsReq(h, http.MethodGet, "/api/sandbox/config", "", "").Header().Get("ETag")
	if e1 == "" {
		t.Fatal("GET /api/sandbox/config 가 ETag 를 싣지 않았다")
	}
	body := `{"dev":{"image":"node:22"}}`
	wantStale(t, settingsReq(h, http.MethodPut, "/api/sandbox/config", body, "stale"))
	if len(reaper.saved) != 0 || countAction(broker, "sandbox_changed") != 0 {
		t.Fatal("거절된 PUT 이 저장했거나 방송했다")
	}
	if rec := settingsReq(h, http.MethodPut, "/api/sandbox/config", body, e1); rec.Code != http.StatusNoContent {
		t.Fatalf("맞는 If-Match: %d %s", rec.Code, rec.Body.String())
	}
	// TC-LIV-2 (FR-LIV-3): 저장이 성공하면 sandbox_changed 가 한 번 나간다.
	if n := countAction(broker, "sandbox_changed"); n != 1 {
		t.Fatalf("sandbox_changed %d 번, want 1", n)
	}
	if rec := settingsReq(h, http.MethodPut, "/api/sandbox/config", body, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("If-Match 없는 PUT: %d", rec.Code)
	}
}

func TestSettingsETag_PeersNode(t *testing.T) {
	n := newPeerNode(t, "node-a", true)
	h := n.srv.Handler()
	e1 := settingsReq(h, http.MethodGet, "/api/peers", "", "").Header().Get("ETag")
	if e1 == "" {
		t.Fatal("GET /api/peers 가 ETag 를 싣지 않았다")
	}
	cfg := n.srv.peers.Config()
	cfg.Name = "renamed"
	raw, _ := json.Marshal(cfg)
	rec := settingsReq(h, http.MethodPut, "/api/peers/node", string(raw), e1)
	if rec.Code != http.StatusOK {
		t.Fatalf("맞는 If-Match: %d %s", rec.Code, rec.Body.String())
	}
	if e2 := rec.Header().Get("ETag"); e2 == "" || e2 == e1 {
		t.Fatalf("저장 뒤 지문: %q → %q", e1, e2)
	}
	cfg.Name = "again"
	raw, _ = json.Marshal(cfg)
	wantStale(t, settingsReq(h, http.MethodPut, "/api/peers/node", string(raw), e1))
	if n.srv.peers.Config().Name != "renamed" {
		t.Fatal("거절된 PUT 이 값을 바꿨다")
	}
	if rec := settingsReq(h, http.MethodPut, "/api/peers/node", string(raw), ""); rec.Code != http.StatusOK {
		t.Fatalf("If-Match 없는 PUT: %d", rec.Code)
	}
}
