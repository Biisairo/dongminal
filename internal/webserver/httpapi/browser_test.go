package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dongminal/internal/shared/browser"
	"dongminal/internal/webserver/hub"
)

// fakeHost 는 브라우저 매니저의 대역이다 — 부른 조작을 기록하고 소식을 흘려 넣는다.
type fakeHost struct {
	mu    sync.Mutex
	calls []string
	args  []map[string]any
	sink  func(browser.Event)
	fail  error
	// tabs 는 "tabs" 의 답이다 — 비면 빈 목록.
	tabs string
}

func (f *fakeHost) Call(ctx context.Context, op string, params any) (json.RawMessage, error) {
	b, _ := json.Marshal(params)
	var m map[string]any
	json.Unmarshal(b, &m)
	f.mu.Lock()
	f.calls = append(f.calls, op)
	f.args = append(f.args, m)
	err := f.fail
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	switch op {
	case "tabs":
		if f.tabs != "" {
			return json.RawMessage(f.tabs), nil
		}
		return json.RawMessage(`{"tabs":[]}`), nil
	case "profiles":
		return json.RawMessage(`{"profiles":[{"name":"default"}]}`), nil
	case "proxyOpen":
		return json.RawMessage(`{"client":"C1"}`), nil
	case "version":
		return json.RawMessage(`{"product":"HeadlessChrome/153","protocolVersion":"1.3"}`), nil
	case "pending":
		return json.RawMessage(`{"items":[{"t":"chooser","info":{"id":3,"multiple":false}}]}`), nil
	case "audio":
		if m["action"] == "offer" {
			return json.RawMessage(`{"peer":"p1","sdp":"v=0"}`), nil
		}
	}
	return json.RawMessage(`{"ok":true}`), nil
}

func (f *fakeHost) SetSink(s func(browser.Event)) { f.sink = s }

func (f *fakeHost) opCount(op string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == op {
			n++
		}
	}
	return n
}

func (f *fakeHost) lastArgs(op string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i] == op {
			return f.args[i]
		}
	}
	return nil
}

func browserSrv(t *testing.T) (*httptest.Server, *fakeHost, *Server) {
	t.Helper()
	fh := &fakeHost{}
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Browser: fh})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, fh, srv
}

func bPost(t *testing.T, ts *httptest.Server, path, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", ts.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

// TC-BRT-S1: 새 종단 전부가 게이트 예외에 걸리지 않는다 (NFR-BRT-S1).
func TestBrowserRoutesAreGated(t *testing.T) {
	for _, p := range []string{"/api/browser/profiles", "/api/browser/tabs", "/api/browser/stream", "/api/browser/open",
		"/api/browser/close", "/api/browser/nav", "/api/browser/viewport", "/api/browser/focus",
		"/api/browser/placements/claim", "/api/browser/profiles/delete", "/api/browser/act", "/api/browser/cdpurl",
		"/api/browser/downloads", "/api/browser/default/cdp/json/version", "/api/browser/default/cdp/json",
		"/api/browser/default/cdp/ws"} {
		for _, m := range []string{"GET", "POST"} {
			r := httptest.NewRequest(m, p, nil)
			if gateExempt(r) {
				t.Errorf("%s %s 가 게이트를 건너뛴다", m, p)
			}
		}
	}
}

// TC-BRT-34: 뷰어가 없으면 페이지는 즉시 만들고, 배치는 들고 있다가 화면이 가져간다.
func TestBrowserOpenWithoutViewerIsPending(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	code, res := bPost(t, ts, "/api/browser/open", `{"url":"https://example.com","tool":"T1"}`)
	if code != 200 || res["tab"] == "" {
		t.Fatalf("open: %d %v", code, res)
	}
	if fh.opCount("open") != 1 {
		t.Fatal("페이지를 즉시 만들지 않았다")
	}
	_, claim := bPost(t, ts, "/api/browser/placements/claim", `{}`)
	ps, _ := claim["placements"].([]any)
	if len(ps) != 1 || ps[0].(map[string]any)["tab"] != res["tab"] || ps[0].(map[string]any)["tool"] != "T1" {
		t.Fatalf("배치가 들려 있지 않다: %v", claim)
	}
	_, again := bPost(t, ts, "/api/browser/placements/claim", `{}`)
	if ps, _ := again["placements"].([]any); len(ps) != 0 {
		t.Fatalf("배치를 두 번 내줬다: %v", again)
	}
}

// 배치를 받을 화면이 있으면 그 화면에 곧바로 간다 — 들고 있지 않는다.
func TestBrowserOpenBroadcastsPlacement(t *testing.T) {
	ts, _, srv := browserSrv(t)
	sub := srv.Commands.(*hub.CommandHub).Add()
	defer srv.Commands.(*hub.CommandHub).Remove(sub)
	_, res := bPost(t, ts, "/api/browser/open", `{"url":"https://example.com","split":"none"}`)
	select {
	case msg := <-sub.Messages():
		var m struct {
			Action string         `json:"action"`
			Args   map[string]any `json:"args"`
		}
		json.Unmarshal(msg, &m)
		if m.Action != "openBrowserTab" || m.Args["tab"] != res["tab"] || m.Args["split"] != "none" {
			t.Fatalf("배치 명령: %s", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("배치 명령이 오지 않았다")
	}
	_, claim := bPost(t, ts, "/api/browser/placements/claim", `{}`)
	if ps, _ := claim["placements"].([]any); len(ps) != 0 {
		t.Fatalf("받은 화면이 있는데 들고 있다: %v", claim)
	}
}

// FR-BRT-65: 열 수 없는 scheme 은 매니저까지 가지 않는다.
func TestBrowserOpenRejectsScheme(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	code, _ := bPost(t, ts, "/api/browser/open", `{"url":"javascript:alert(1)"}`)
	if code != 400 || fh.opCount("open") != 0 {
		t.Fatalf("code=%d open=%d", code, fh.opCount("open"))
	}
}

// FR-BRT-75: --tab 이 없으면 호출 도구가 마지막으로 다룬 탭이다.
func TestBrowserDefaultTargetIsLastTouched(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	_, res := bPost(t, ts, "/api/browser/open", `{"url":"https://example.com","tool":"T1"}`)
	code, _ := bPost(t, ts, "/api/browser/nav", `{"tool":"T1","action":"reload"}`)
	if code != 200 {
		t.Fatalf("nav: %d", code)
	}
	if got := fh.lastArgs("nav")["tab"]; got != res["tab"] {
		t.Fatalf("대상=%v want %v", got, res["tab"])
	}
	if code, _ := bPost(t, ts, "/api/browser/nav", `{"tool":"OTHER","action":"reload"}`); code != 404 {
		t.Fatalf("다룬 탭이 없는 도구: %d", code)
	}
}

// 엔진 없음 등 매니저의 거절은 문구 그대로 409 다 (FR-BRT-2).
func TestBrowserEngineErrorSurfaces(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	fh.fail = errString("Google Chrome 을 찾지 못했습니다 — 설치하세요")
	req, _ := http.NewRequest("POST", ts.URL+"/api/browser/open", strings.NewReader(`{"url":"https://example.com"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b := make([]byte, 512)
	n, _ := resp.Body.Read(b)
	if resp.StatusCode != 409 || !strings.Contains(string(b[:n]), "Chrome") {
		t.Fatalf("code=%d body=%q", resp.StatusCode, b[:n])
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func dialBrowser(t *testing.T, ts *httptest.Server, q string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(strings.Replace(ts.URL, "http", "ws", 1)+"/api/browser/stream?"+q, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// TC-BRT-37 (서버 절반): 첫 뷰어가 붙으면 screencast 를 켜고, 마지막이 떠나면 끈다.
// 한 페이지의 프레임은 붙은 뷰어 전부에 간다 (FR-BRT-50).
func TestBrowserStreamWatchAndFanout(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	a := dialBrowser(t, ts, "tab=T&url=https://example.com")
	b := dialBrowser(t, ts, "tab=T")
	bWait(t, func() bool { return fh.opCount("watch") >= 1 && fh.opCount("ensure") >= 2 })
	if fh.opCount("watch") != 1 {
		t.Fatalf("screencast 를 두 번 켰다: %d", fh.opCount("watch"))
	}
	fh.sink(browser.Event{Kind: browser.EvFrame, Tab: "T", Data: []byte{0xFF, 0xD8, 1}, Info: json.RawMessage(`{"deviceWidth":800}`)})
	for _, c := range []*websocket.Conn{a, b} {
		c.SetReadDeadline(time.Now().Add(3 * time.Second))
		for {
			typ, msg, err := c.ReadMessage()
			if err != nil {
				t.Fatalf("프레임을 받지 못했다: %v", err)
			}
			if typ == websocket.BinaryMessage {
				n := int(msg[0])<<24 | int(msg[1])<<16 | int(msg[2])<<8 | int(msg[3])
				if string(msg[4:4+n]) != `{"deviceWidth":800}` || msg[4+n] != 0xFF {
					t.Fatalf("프레임 모양: %v", msg)
				}
				break
			}
		}
	}
	a.Close()
	b.Close()
	bWait(t, func() bool {
		a := fh.lastArgs("watch")
		return a != nil && a["on"] == false
	})
}

// 뷰어는 입력·이동·뷰포트·확대만 부른다 — 열기·cdp·프로필은 막는다.
func TestBrowserStreamLimitsOps(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	c := dialBrowser(t, ts, "tab=T")
	for _, m := range []string{`{"op":"cdp","method":"Runtime.evaluate"}`, `{"op":"profileDelete","name":"x"}`,
		`{"op":"input","t":"mouse","type":"mouseMoved","x":1,"y":2}`} {
		c.WriteMessage(websocket.TextMessage, []byte(m))
	}
	bWait(t, func() bool { return fh.opCount("input") == 1 })
	if fh.opCount("cdp") != 0 || fh.opCount("profileDelete") != 0 {
		t.Fatal("뷰어가 막힌 조작을 불렀다")
	}
	if fh.lastArgs("input")["tab"] != "T" {
		t.Fatal("입력에 탭이 실리지 않았다")
	}
}

// FR-BRT-91: offer 는 그 뷰어에게만 가고, 뷰어가 끊기면 그 peer 를 끝낸다.
func TestBrowserStreamAudioSignal(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	c := dialBrowser(t, ts, "tab=T")
	other := dialBrowser(t, ts, "tab=T")
	c.WriteMessage(websocket.TextMessage, []byte(`{"op":"audio","action":"offer"}`))
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, msg, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("offer 를 받지 못했다: %v", err)
		}
		if strings.Contains(string(msg), `"t":"audio"`) {
			if !strings.Contains(string(msg), `"peer":"p1"`) {
				t.Fatalf("offer: %s", msg)
			}
			break
		}
	}
	other.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	for {
		_, msg, err := other.ReadMessage()
		if err != nil {
			break
		}
		if strings.Contains(string(msg), `"t":"audio"`) {
			t.Fatal("다른 뷰어가 offer 를 받았다")
		}
	}
	c.Close()
	bWait(t, func() bool {
		a := fh.lastArgs("audio")
		return a != nil && a["action"] == "stop" && a["peer"] == "p1" && a["tab"] == "T"
	})
}

// 페이지가 스스로 닫히면 탭을 닫게 한다 (FR-BRT-37).
func TestBrowserPageClosedClosesTab(t *testing.T) {
	_, fh, srv := browserSrv(t)
	sub := srv.Commands.(*hub.CommandHub).Add()
	defer srv.Commands.(*hub.CommandHub).Remove(sub)
	fh.sink(browser.Event{Kind: browser.EvClosed, Tab: "T"})
	select {
	case msg := <-sub.Messages():
		if !strings.Contains(string(msg), `"closeTab"`) || !strings.Contains(string(msg), `"location":"T"`) {
			t.Fatalf("닫기 명령: %s", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("닫기 명령이 오지 않았다")
	}
}

func bWait(t *testing.T, cond func() bool) {
	t.Helper()
	end := time.Now().Add(3 * time.Second)
	for time.Now().Before(end) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("조건이 서지 않았다")
}

// TC-BRT-23: CDP 프록시 WS 는 Origin 이 있으면 거부한다. Origin 없는 도구는 붙는다.
// `devtools://devtools` 도 거부된다 — 0단계 FR-ROP-3(비 http(s) Origin 거절)이 먼저다.
func TestBrowserCDPOrigin(t *testing.T) {
	ts, _, _ := browserSrv(t)
	wsURL := strings.Replace(ts.URL, "http", "ws", 1) + "/api/browser/default/cdp/ws"
	for _, o := range []string{ts.URL, "http://localhost:58146", "devtools://devtools"} {
		h := http.Header{}
		h.Set("Origin", o)
		c, resp, _ := websocket.DefaultDialer.Dial(wsURL, h)
		if c != nil {
			c.Close()
		}
		if resp == nil || resp.StatusCode != 403 {
			t.Errorf("Origin %q → %v, want 403", o, resp)
		}
	}
	c, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil || resp.StatusCode != 101 {
		t.Fatalf("Origin 없는 도구: %v %v", resp, err)
	}
	c.Close()
}

// FR-BRT-22: 프록시는 메시지를 양쪽으로 나르고, json/version 은 WS 주소를 알린다.
func TestBrowserCDPRelay(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	resp, err := http.Get(ts.URL + "/api/browser/default/cdp/json/version/")
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	json.NewDecoder(resp.Body).Decode(&v)
	resp.Body.Close()
	if !strings.HasSuffix(v["webSocketDebuggerUrl"].(string), "/api/browser/default/cdp/ws") || v["Browser"] != "HeadlessChrome/153" {
		t.Fatalf("json/version: %v", v)
	}
	c, _, err := websocket.DefaultDialer.Dial(v["webSocketDebuggerUrl"].(string), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.WriteMessage(websocket.TextMessage, []byte(`{"id":1,"method":"Browser.getVersion"}`))
	bWait(t, func() bool { return fh.opCount("proxySend") == 1 })
	if a := fh.lastArgs("proxySend"); a["client"] != "C1" {
		t.Fatalf("proxySend: %v", a)
	}
	fh.sink(browser.Event{Kind: browser.EvProxy, Info: json.RawMessage(`{"client":"C1"}`), Data: []byte(`{"id":1,"result":{}}`)})
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := c.ReadMessage()
	if err != nil || string(msg) != `{"id":1,"result":{}}` {
		t.Fatalf("relay: %q %v", msg, err)
	}
	c.Close()
	bWait(t, func() bool { return fh.opCount("proxyClose") == 1 })
}

// FR-BRT-75: act 는 허용된 조작만 받는다.
func TestBrowserActOps(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	if code, _ := bPost(t, ts, "/api/browser/act", `{"tab":"T","op":"proxyOpen"}`); code != 400 {
		t.Fatalf("막힌 조작: %d", code)
	}
	if code, _ := bPost(t, ts, "/api/browser/act", `{"tab":"T","op":"click","ref":"e1","timeoutMs":1234}`); code != 200 {
		t.Fatalf("click: %d", code)
	}
	a := fh.lastArgs("click")
	if a["ref"] != "e1" || a["tab"] != "T" || a["op"] != nil {
		t.Fatalf("click 인자: %v", a)
	}
}

// FR-BRT-39·52: 데몬이 다시 떠 매니저가 탭을 모를 때, `dmctl` 이 가리키면 워크스페이스의
// url·프로필·고정 크기로 페이지를 만든다.
func TestBrowserActRestoresFromWorkspace(t *testing.T) {
	fh := &fakeHost{}
	ws := &fakeWorkspaceStore{raw: []byte(`{"activeWindow":"s1","schemaVersion":2,"windows":[{"id":"s1","name":"x","focusedPane":"p1",` +
		`"layout":{"type":"pane","id":"p1","activeTab":"B","tabs":[{"id":"B","name":"site","type":"browser","url":"https://example.com/a",` +
		`"profile":"work","viewport":{"w":800,"h":600}}]}}]}`)}
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Browser: fh, Work: ws})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	// TC-BRT-36: 보이기 전에는 페이지가 없다 — 목록에는 이름으로 있고 live 가 아니다.
	resp, err := http.Get(ts.URL + "/api/browser/tabs")
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Tabs []browser.TabInfo `json:"tabs"`
	}
	json.NewDecoder(resp.Body).Decode(&list)
	resp.Body.Close()
	if len(list.Tabs) != 1 || list.Tabs[0].Tab != "B" || list.Tabs[0].Live || list.Tabs[0].Title != "site" || fh.opCount("ensure") != 0 {
		t.Fatalf("지연 복원 전 목록: %+v ensure=%d", list.Tabs, fh.opCount("ensure"))
	}
	for _, c := range []struct{ path, body string }{
		{"/api/browser/act", `{"tab":"B","op":"snapshot"}`},
		{"/api/browser/nav", `{"tab":"B","action":"reload"}`},
		{"/api/browser/viewport", `{"tab":"B","w":1024,"h":768}`},
	} {
		if code, _ := bPost(t, ts, c.path, c.body); code != 200 {
			t.Fatalf("%s → %d", c.path, code)
		}
		a := fh.lastArgs("ensure")
		vp, _ := a["viewport"].(map[string]any)
		if a["url"] != "https://example.com/a" || a["profile"] != "work" || vp["w"] != float64(800) {
			t.Fatalf("%s 의 복원: %v", c.path, a)
		}
	}
}

// TC-BRT-S2: file:// 페이지(Origin: null)·같은 기계 다른 포트의 페이지는 브라우저 API 와
// CDP 프록시에 닿지 못한다 — 0단계 게이트(FR-ROP)와 FR-BRT-23 의 합.
func TestBrowserForeignOriginsRejected(t *testing.T) {
	h := requestGate(newHostAllow(nil, nil), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	for _, origin := range []string{"null", "http://localhost:3000", "file://"} {
		for _, c := range []struct{ method, path string }{
			{"POST", "/api/browser/act"}, {"POST", "/api/browser/open"}, {"GET", "/api/browser/cdpurl"},
			{"GET", "/api/browser/default/cdp/json/version"}, {"GET", "/api/browser/default/cdp/ws"},
		} {
			req := httptest.NewRequest(c.method, c.path, strings.NewReader(`{}`))
			req.Host = "localhost:58146"
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Origin", origin)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Errorf("Origin %q %s %s → %d want 403", origin, c.method, c.path, rec.Code)
			}
		}
	}
}

// FR-BRT-81·85·86: 뷰어가 붙으면 답을 기다리는 것(대화상자·파일 선택·인증)을 먼저 받는다.
func TestBrowserStreamReplaysPending(t *testing.T) {
	ts, _, _ := browserSrv(t)
	c := dialBrowser(t, ts, "tab=T")
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, msg, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("기다리는 파일 선택을 받지 못했다: %v", err)
		}
		if strings.Contains(string(msg), `"t":"chooser"`) && strings.Contains(string(msg), `"id":3`) {
			return
		}
	}
}

// FR-BRT-36: 웹서버만 다시 떠 들고 있던 배치를 잃었어도, 매니저에 살아 있는데 워크스페이스에
// 없는 탭은 첫 claim 에서 배치로 돌려준다. 한 번뿐이다 — 그 뒤의 배치는 평소 길로 온다.
func TestBrowserClaimRecoversAfterWebRestart(t *testing.T) {
	fh := &fakeHost{tabs: `{"tabs":[{"tab":"A","profile":"default","url":"https://a.example/","title":"A","live":true},` +
		`{"tab":"B","profile":"work","url":"https://b.example/","title":"B","live":true,"isolated":true}]}`}
	ws := &fakeWorkspaceStore{raw: []byte(`{"activeWindow":"s1","schemaVersion":2,"windows":[{"id":"s1","name":"x","focusedPane":"p1",` +
		`"layout":{"type":"pane","id":"p1","activeTab":"A","tabs":[{"id":"A","name":"A","type":"browser","url":"https://a.example/"}]}}]}`)}
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Browser: fh, Work: ws})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	_, claim := bPost(t, ts, "/api/browser/placements/claim", `{}`)
	ps, _ := claim["placements"].([]any)
	if len(ps) != 1 {
		t.Fatalf("배치: %v", claim)
	}
	p := ps[0].(map[string]any)
	if p["tab"] != "B" || p["profile"] != "work" || p["isolated"] != true || p["url"] != "https://b.example/" {
		t.Fatalf("되찾은 배치: %v", p)
	}
	if _, again := bPost(t, ts, "/api/browser/placements/claim", `{}`); len(again["placements"].([]any)) != 0 {
		t.Fatalf("두 번째 claim: %v", again)
	}
}

// TC-BRT-38: 여러 화면이 붙어 있어도 배치는 한 화면(실행자)만 한다 — 명령에 실행자가 실린다.
func TestBrowserPlacementNamesOneExecutor(t *testing.T) {
	_, fh, srv := browserSrv(t)
	srv.Focus.Attach("c1")
	srv.Focus.Attach("c2")
	want := srv.Focus.Executor()
	if want == "" {
		t.Fatal("실행자가 없다")
	}
	ch := srv.Commands.(*hub.CommandHub)
	a, b := ch.Add(), ch.Add()
	defer ch.Remove(a)
	defer ch.Remove(b)
	fh.sink(browser.Event{Kind: browser.EvCreated, Tab: "N", Info: json.RawMessage(`{"url":"https://x.example/","profile":"default"}`)})
	for _, sub := range []*hub.CmdSub{a, b} {
		select {
		case msg := <-sub.Messages():
			if !strings.Contains(string(msg), `"openBrowserTab"`) || !strings.Contains(string(msg), `"execClientId":"`+want+`"`) {
				t.Fatalf("배치 명령: %s", msg)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("배치 명령이 오지 않았다")
		}
	}
}
