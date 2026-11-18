package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/serverconf"
	"dongminal/internal/webserver/apierr"
)

// HOT_REBIND_SRS 묶음 R — 실행 중인 서버의 리바인드. 실제 리스너로 잰다.

func freeTCPPort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
	_ = ln.Close()
	return p
}

var noKeepAlive = &http.Client{
	Transport:     &http.Transport{DisableKeepAlives: true},
	Timeout:       3 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func pingOK(port string) bool {
	resp, err := noKeepAlive.Get("http://127.0.0.1:" + port + "/api/ping")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// startBindServer 는 임시 홈·빈 포트로 Run 을 돌린다. prep 은 Run 전에 서버를 고친다.
func startBindServer(t *testing.T, prep func(*Server)) (*Server, string, string) {
	t.Helper()
	home := t.TempDir()
	s, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	s.bindGrace = 300 * time.Millisecond
	if prep != nil {
		prep(s)
	}
	port := freeTCPPort(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, net.JoinHostPort("127.0.0.1", port)) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("Run: %v", err)
		}
	})
	deadline := time.Now().Add(3 * time.Second)
	for !pingOK(port) {
		if time.Now().After(deadline) {
			t.Fatal("서버가 뜨지 않았다")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return s, home, port
}

func postBind(t *testing.T, port, body string) (int, string, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:"+port+"/api/server/bind", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := noKeepAlive.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	m := map[string]any{}
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, resp.Header.Get(apierr.CodeHeader), m
}

func serverJSON(t *testing.T, home string) map[string]any {
	t.Helper()
	m := map[string]any{}
	data, err := os.ReadFile(filepath.Join(home, serverconf.FileName))
	if errors.Is(err, os.ErrNotExist) {
		return m
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// TC-HRB-7 (FR-HRB-20·23): 포트를 바꾸면 새 포트가 받고, 파일 둘이 바뀌고, 옛 포트는
// 유예 동안 GET / 를 307 로 보내고, 유예 뒤 닫힌다.
func TestRebindPort(t *testing.T) {
	_, home, p1 := startBindServer(t, nil)
	p2 := freeTCPPort(t)

	code, _, body := postBind(t, p1, `{"port":`+p2+`}`)
	if code != http.StatusOK || body["port"] != p2 || body["expose"] != false {
		t.Fatalf("응답 %d %v", code, body)
	}
	if !pingOK(p2) {
		t.Fatal("새 포트가 받지 않는다")
	}
	if m := serverJSON(t, home); m["port"] != p2 {
		t.Errorf("server.json = %v", m)
	}
	if h, p, ok := serverconf.ReadAddr(home); !ok || h != "127.0.0.1" || p != p2 {
		t.Errorf("주소 파일 = %s:%s %v", h, p, ok)
	}

	resp, err := noKeepAlive.Get("http://127.0.0.1:" + p1 + "/?x=1")
	if err != nil {
		t.Fatalf("유예 중 옛 포트가 닫혔다: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTemporaryRedirect || resp.Header.Get("Location") != "http://127.0.0.1:"+p2+"/?x=1" {
		t.Errorf("옛 포트 GET / = %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	if !pingOK(p1) {
		t.Error("유예 중 옛 포트의 API 가 서지 않는다")
	}

	deadline := time.Now().Add(3 * time.Second)
	for pingOK(p1) {
		if time.Now().After(deadline) {
			t.Fatal("유예 뒤에도 옛 포트가 열려 있다")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !pingOK(p2) {
		t.Error("옛 포트를 닫으며 새 포트도 닫혔다")
	}
}

// FR-HRB-22: 바뀌는 것이 없으면 200 과 지금 바인드.
func TestRebindNoChange(t *testing.T) {
	_, home, p1 := startBindServer(t, nil)
	code, _, body := postBind(t, p1, `{"port":`+p1+`,"expose":false}`)
	if code != http.StatusOK || body["port"] != p1 {
		t.Fatalf("응답 %d %v", code, body)
	}
	if m := serverJSON(t, home); len(m) != 0 {
		t.Errorf("바뀐 것이 없는데 server.json 을 썼다: %v", m)
	}
}

// TC-HRB-7 (FR-HRB-23): 쓰이는 포트·범위 밖은 각 코드로 거절되고 옛 바인드가 그대로다.
func TestRebindRejects(t *testing.T) {
	_, home, p1 := startBindServer(t, nil)
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	bp := strconv.Itoa(busy.Addr().(*net.TCPAddr).Port)

	for _, tc := range []struct {
		body   string
		status int
		code   string
	}{
		{`{"port":` + bp + `}`, http.StatusConflict, apierr.CodeBindPortInUse},
		{`{"port":80}`, http.StatusBadRequest, apierr.CodeBindPortInvalid},
		{`{"port":70000}`, http.StatusBadRequest, apierr.CodeBindPortInvalid},
	} {
		code, c, _ := postBind(t, p1, tc.body)
		if code != tc.status || c != tc.code {
			t.Errorf("%s → %d %q, want %d %q", tc.body, code, c, tc.status, tc.code)
		}
	}
	if !pingOK(p1) {
		t.Fatal("거절 뒤 옛 포트가 닫혔다")
	}
	if m := serverJSON(t, home); len(m) != 0 {
		t.Errorf("거절했는데 server.json 을 썼다: %v", m)
	}
	if _, p, ok := serverconf.ReadAddr(home); !ok || p != p1 {
		t.Errorf("주소 파일이 바뀌었다: %s %v", p, ok)
	}
}

// TC-HRB-7 (FR-HRB-27): 진행 중이면 409 bind_busy.
func TestRebindBusy(t *testing.T) {
	s, _, p1 := startBindServer(t, nil)
	s.bind.mu.Lock()
	s.bind.busy = true
	s.bind.mu.Unlock()
	code, c, _ := postBind(t, p1, `{"port":`+freeTCPPort(t)+`}`)
	if code != http.StatusConflict || c != apierr.CodeBindBusy {
		t.Errorf("응답 %d %q", code, c)
	}
	s.bind.mu.Lock()
	s.bind.busy = false
	s.bind.mu.Unlock()
}

// 유예 중인 옛 포트로 되돌릴 수 있다.
func TestRebindBackToGracePort(t *testing.T) {
	_, _, p1 := startBindServer(t, func(s *Server) { s.bindGrace = 5 * time.Second })
	p2 := freeTCPPort(t)
	if code, _, body := postBind(t, p1, `{"port":`+p2+`}`); code != http.StatusOK {
		t.Fatalf("p2 로: %d %v", code, body)
	}
	if code, _, body := postBind(t, p2, `{"port":`+p1+`}`); code != http.StatusOK || body["port"] != p1 {
		t.Fatalf("p1 로 되돌리기: %d %v", code, body)
	}
	resp, err := noKeepAlive.Get("http://127.0.0.1:" + p1 + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusTemporaryRedirect {
		t.Error("지금 포트가 옛 포트처럼 307 을 낸다")
	}
}

// exposeListen 은 0.0.0.0 을 127.0.0.1 로 바꿔 리슨한다 — 시험이 같은 망에 포트를 열지 않는다.
func exposeListen(fail bool, asked *[]string) func(string, string) (net.Listener, error) {
	return func(network, addr string) (net.Listener, error) {
		*asked = append(*asked, addr)
		h, p, _ := net.SplitHostPort(addr)
		if h == "0.0.0.0" {
			if fail {
				return nil, errors.New("주입한 실패")
			}
			addr = net.JoinHostPort("127.0.0.1", p)
		}
		return net.Listen(network, addr)
	}
}

// TC-HRB-8 (FR-HRB-24·29): expose 만 바꾸면 같은 포트로 다시 리슨하고, 경고를 싣는다.
func TestRebindExposeOnly(t *testing.T) {
	var asked []string
	_, home, p1 := startBindServer(t, func(s *Server) { s.bindListen = exposeListen(false, &asked) })
	code, _, body := postBind(t, p1, `{"expose":true}`)
	if code != http.StatusOK || body["expose"] != true || body["port"] != p1 || body["host"] != "0.0.0.0" {
		t.Fatalf("응답 %d %v", code, body)
	}
	if w, _ := body["warning"].(string); !strings.Contains(w, "허용 목록") {
		t.Errorf("경고가 없다: %v", body)
	}
	if asked[len(asked)-1] != "0.0.0.0:"+p1 {
		t.Errorf("리슨한 주소 = %v", asked)
	}
	if !pingOK(p1) {
		t.Fatal("다시 리슨하지 않았다")
	}
	if m := serverJSON(t, home); m["host"] != "0.0.0.0" {
		t.Errorf("server.json = %v", m)
	}
	if h, _, _ := serverconf.ReadAddr(home); h != "0.0.0.0" {
		t.Errorf("주소 파일 호스트 = %q", h)
	}
}

// TC-HRB-8: 새 호스트로 리슨하지 못하면 옛 호스트로 돌아가고 409 bind_rebind_failed.
func TestRebindExposeFailureRollsBack(t *testing.T) {
	var asked []string
	_, home, p1 := startBindServer(t, func(s *Server) { s.bindListen = exposeListen(true, &asked) })
	code, c, _ := postBind(t, p1, `{"expose":true}`)
	if code != http.StatusConflict || c != apierr.CodeBindRebindFailed {
		t.Fatalf("응답 %d %q", code, c)
	}
	if !pingOK(p1) {
		t.Fatal("옛 호스트로 돌아가지 않았다")
	}
	if m := serverJSON(t, home); len(m) != 0 {
		t.Errorf("실패했는데 server.json 을 썼다: %v", m)
	}
}

// TC-HRB-9 (FR-HRB-21): 루프백이 아닌 출발지는 403 bind_local_only.
func TestRebindLocalOnly(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/server/bind", strings.NewReader(`{"port":9999}`))
	r.RemoteAddr = "192.168.1.9:51000"
	w := httptest.NewRecorder()
	s.apiServerBind(w, r)
	if w.Code != http.StatusForbidden || w.Header().Get(apierr.CodeHeader) != apierr.CodeBindLocalOnly {
		t.Fatalf("응답 %d %q", w.Code, w.Header().Get(apierr.CodeHeader))
	}
	// Run 밖에서 만든 서버는 리스너를 갈아 끼울 수 없다.
	r = httptest.NewRequest(http.MethodPost, "/api/server/bind", strings.NewReader(`{"port":9999}`))
	r.RemoteAddr = "127.0.0.1:51000"
	w = httptest.NewRecorder()
	s.apiServerBind(w, r)
	if w.Code != http.StatusServiceUnavailable || w.Header().Get(apierr.CodeHeader) != apierr.CodeBindUnavailable {
		t.Fatalf("Run 밖 응답 %d %q", w.Code, w.Header().Get(apierr.CodeHeader))
	}
}

func carryPost(s *Server, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/server/carry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.apiServerCarryPost(w, r)
	return w
}

func carryGet(s *Server, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "/api/server/carry/"+token, nil)
	w := httptest.NewRecorder()
	s.apiServerCarryGet(w, r)
	return w
}

// TC-HRB-10 (FR-HRB-26): carry 토큰은 한 번만, 60초 안에만 쓰인다. 1 MiB 상한, 16개 상한.
func TestCarry(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1000, 0)
	s.carry.now = func() time.Time { return now }

	w := carryPost(s, []byte(`{"theme":"dark"}`))
	var tok struct{ Token string }
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &tok) != nil || len(tok.Token) < 32 {
		t.Fatalf("맡기기 %d %s", w.Code, w.Body.String())
	}
	if g := carryGet(s, tok.Token); g.Code != http.StatusOK || strings.TrimSpace(g.Body.String()) != `{"theme":"dark"}` {
		t.Fatalf("찾기 %d %s", g.Code, g.Body.String())
	}
	if g := carryGet(s, tok.Token); g.Code != http.StatusNotFound || g.Header().Get(apierr.CodeHeader) != apierr.CodeNotFound {
		t.Errorf("두 번째 찾기 %d", g.Code)
	}

	w = carryPost(s, []byte(`{}`))
	_ = json.Unmarshal(w.Body.Bytes(), &tok)
	now = now.Add(61 * time.Second)
	if g := carryGet(s, tok.Token); g.Code != http.StatusNotFound {
		t.Errorf("60초 뒤 찾기 %d", g.Code)
	}

	big := append([]byte(`{"x":"`), bytes.Repeat([]byte("a"), 1<<20)...)
	big = append(big, '"', '}')
	if w := carryPost(s, big); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("1 MiB 초과 %d", w.Code)
	}
	if w := carryPost(s, []byte(`not json`)); w.Code != http.StatusBadRequest {
		t.Errorf("JSON 아님 %d", w.Code)
	}
	for i := range 16 {
		if w := carryPost(s, []byte(`{}`)); w.Code != http.StatusOK {
			t.Fatalf("%d번째 맡기기 %d", i, w.Code)
		}
	}
	if w := carryPost(s, []byte(`{}`)); w.Code != http.StatusServiceUnavailable || w.Header().Get(apierr.CodeHeader) != apierr.CodeBusy {
		t.Errorf("17번째 %d %q", w.Code, w.Header().Get(apierr.CodeHeader))
	}
}

// fakeConn 은 출발지만 정할 수 있는 연결이다.
type fakeConn struct {
	net.Conn
	remote net.Addr
	closed bool
}

func (c *fakeConn) RemoteAddr() net.Addr { return c.remote }
func (c *fakeConn) Close() error         { c.closed = true; return nil }

// FR-HRB-32: expose 를 끄면 루프백이 아닌 출발지의 연결을 끊는다. 루프백 연결은 남긴다.
func TestConnSetRevokeRemote(t *testing.T) {
	set := newConnSet()
	lan := &fakeConn{remote: &net.TCPAddr{IP: net.ParseIP("192.168.1.9"), Port: 5000}}
	lo := &fakeConn{remote: &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 5001}}
	tl := set.track(lan)
	set.track(lo)
	set.revokeRemote()
	if !lan.closed || lo.closed {
		t.Fatalf("lan.closed=%v lo.closed=%v", lan.closed, lo.closed)
	}
	// 닫힌 연결은 집합에서 빠진다.
	_ = tl.Close()
	if n := set.size(); n != 1 {
		t.Errorf("남은 연결 = %d", n)
	}
}

// FR-HRB-32: 노출된 옛 리스너는 expose 를 끄며 포트를 옮길 때 유예 없이 닫힌다.
func TestRebindUnexposeMoveClosesOldAtOnce(t *testing.T) {
	var asked []string
	s, _, p1 := startBindServer(t, func(s *Server) {
		s.bindGrace = 5 * time.Second
		s.bindListen = exposeListen(false, &asked)
	})
	if code, _, body := postBind(t, p1, `{"expose":true}`); code != http.StatusOK {
		t.Fatalf("expose: %d %v", code, body)
	}
	p2 := freeTCPPort(t)
	if code, _, body := postBind(t, p1, `{"port":`+p2+`,"expose":false}`); code != http.StatusOK || body["expose"] != false {
		t.Fatalf("이동: %d %v", code, body)
	}
	if pingOK(p1) {
		t.Error("노출된 옛 리스너가 유예로 남았다")
	}
	s.bind.mu.Lock()
	n := len(s.bind.grace)
	s.bind.mu.Unlock()
	if n != 0 {
		t.Errorf("유예 목록 = %d", n)
	}
	if !pingOK(p2) {
		t.Error("새 포트가 받지 않는다")
	}
}

// FR-HRB-40: Settings 가 읽는 지금 바인드와 server.json 의 출처. 루프백인지(local)도 싣는다.
func TestServerBindGet(t *testing.T) {
	_, _, p1 := startBindServer(t, nil)
	get := func() map[string]any {
		resp, err := noKeepAlive.Get("http://127.0.0.1:" + p1 + "/api/server/bind")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		m := map[string]any{}
		if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&m) != nil {
			t.Fatalf("GET %d", resp.StatusCode)
		}
		return m
	}
	m := get()
	src, _ := m["source"].(map[string]any)
	if m["port"] != p1 || m["host"] != "127.0.0.1" || m["expose"] != false || m["local"] != true || src["port"] != "default" {
		t.Fatalf("GET = %v", m)
	}
	p2 := freeTCPPort(t)
	if code, _, body := postBind(t, p1, `{"port":`+p2+`}`); code != http.StatusOK {
		t.Fatalf("이동 %d %v", code, body)
	}
	m = get()
	src, _ = m["source"].(map[string]any)
	if m["port"] != p2 || src["port"] != "file" {
		t.Errorf("이동 뒤 GET = %v", m)
	}
}

// FR-HRB-32: 노출된 채 포트를 옮겨 옛 리스너가 유예 중일 때 expose 만 끄면, 그 옛 리스너도 바로 닫는다.
func TestRebindUnexposeClosesExposedGrace(t *testing.T) {
	var asked []string
	_, _, p1 := startBindServer(t, func(s *Server) {
		s.bindGrace = 5 * time.Second
		s.bindListen = exposeListen(false, &asked)
	})
	if code, _, body := postBind(t, p1, `{"expose":true}`); code != http.StatusOK {
		t.Fatalf("expose: %d %v", code, body)
	}
	p2 := freeTCPPort(t)
	if code, _, body := postBind(t, p1, `{"port":`+p2+`}`); code != http.StatusOK || body["expose"] != true {
		t.Fatalf("노출 유지 이동: %d %v", code, body)
	}
	if !pingOK(p1) {
		t.Fatal("노출이 그대로면 옛 리스너는 유예로 남아야 한다")
	}
	if code, _, body := postBind(t, p2, `{"expose":false}`); code != http.StatusOK || body["expose"] != false {
		t.Fatalf("expose 끄기: %d %v", code, body)
	}
	if pingOK(p1) {
		t.Error("expose 를 껐는데 노출된 유예 리스너가 남았다")
	}
	if !pingOK(p2) {
		t.Error("지금 포트가 받지 않는다")
	}
}
