package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"dongminal/internal/shared/browser"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpresp"
)

// 2단계 — `dmctl browser` 의 관찰·조작·대기와 CDP 프록시 (BROWSER_TAB_SRS FR-BRT-22·23·75~79).

// actOps 는 `/api/browser/act` 가 받는 조작이다. 그 밖(프로필·열기·프록시)은 여기로 오지 않는다.
var actOps = map[string]bool{
	// 3단계: 대화상자의 답·DevTools (FR-BRT-84·85).
	"dialog": true, "devtools": true,
	"snapshot": true, "screenshot": true, "click": true, "fill": true, "type": true, "press": true,
	"select": true, "hover": true, "scroll": true, "upload": true, "wait": true, "eval": true,
	"console": true, "network": true, "state": true,
}

// actMaxTimeout 은 조작 하나의 상한이다 — `wait --timeout` 이 이보다 길면 자른다.
const actMaxTimeout = 10 * time.Minute

// apiBrowserAct 는 탭 하나에 대한 2단계 조작이다. 본문은 `{tab?, tool?, op, timeoutMs?, …}`.
func (s *Server) apiBrowserAct(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	var body map[string]any
	if ok, answered := readBodyHTTP(w, r, &body); answered || !ok {
		if !answered {
			httpErr(w, "invalid json", http.StatusBadRequest, apierr.CodeInvalidJSON)
		}
		return
	}
	op, _ := body["op"].(string)
	if !actOps[op] {
		httpErr(w, "unknown op: "+op, http.StatusBadRequest, apierr.CodeBadRequest)
		return
	}
	tab, _ := body["tab"].(string)
	tool, _ := body["tool"].(string)
	tab, err := s.browser.resolveTab(tab, tool)
	if err != nil {
		httpErr(w, err.Error(), http.StatusNotFound, apierr.CodeNotFound)
		return
	}
	s.browser.touch(tool, tab)
	timeout := browser.DefaultActTimeout
	if ms, ok := body["timeoutMs"].(float64); ok && ms > 0 {
		timeout = time.Duration(ms) * time.Millisecond
	}
	if timeout > actMaxTimeout {
		timeout = actMaxTimeout
	}
	delete(body, "op")
	delete(body, "tool")
	delete(body, "timeoutMs")
	body["tab"] = tab
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	// 페이지가 없는(지연 복원) 탭이면 먼저 만든다 — `dmctl` 이 가리키면 생긴다 (FR-BRT-39).
	s.browser.ensureTab(ctx, tab, browser.OpenReq{})
	res, err := s.browser.host.Call(ctx, op, body)
	if err != nil {
		browserFail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(res)
}

// apiBrowserCDPURL 은 CDP 프록시 주소다 (`dmctl browser cdp-url`).
func (s *Server) apiBrowserCDPURL(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	q := r.URL.Query()
	profile := q.Get("profile")
	if profile == "" {
		profile = browser.DefaultProfileSetting(s.cfg.DataDir)
	}
	httpresp.JSON(w, http.StatusOK, map[string]string{
		"ws":   cdpWSURL(r.Host, profile, q.Get("tool")),
		"http": "http://" + r.Host + "/api/browser/" + url.PathEscape(profile) + "/cdp",
	})
}

func cdpWSURL(host, profile, tool string) string {
	u := "ws://" + host + "/api/browser/" + url.PathEscape(profile) + "/cdp/ws"
	if tool != "" {
		u += "?tool=" + url.QueryEscape(tool)
	}
	return u
}

// apiBrowserProfileRoute 는 `/api/browser/<프로필>/cdp/…` 다 (FR-BRT-22).
//
//	GET /api/browser/<p>/cdp/json/version   → webSocketDebuggerUrl (Playwright·puppeteer 의 http 형태)
//	GET /api/browser/<p>/cdp/json[/list]    → [] (페이지 목록은 CDP 로 받는다)
//	WS  /api/browser/<p>/cdp/ws             → 브라우저 수준 CDP
func (s *Server) apiBrowserProfileRoute(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/browser/")
	profile, tail, ok := strings.Cut(rest, "/cdp")
	if !ok || profile == "" || strings.Contains(profile, "/") {
		httpErr(w, "not found", http.StatusNotFound, apierr.CodeNotFound)
		return
	}
	tail = strings.TrimSuffix(tail, "/")
	switch tail {
	case "/ws":
		s.apiBrowserCDPWS(w, r, profile)
	case "/json/version":
		res, err := s.browser.host.Call(r.Context(), "version", map[string]string{"profile": profile})
		if err != nil {
			browserFail(w, err)
			return
		}
		var v map[string]any
		json.Unmarshal(res, &v)
		out := map[string]any{"Browser": v["product"], "Protocol-Version": v["protocolVersion"],
			"User-Agent": v["userAgent"], "V8-Version": v["jsVersion"],
			"webSocketDebuggerUrl": cdpWSURL(r.Host, profile, r.URL.Query().Get("tool"))}
		httpresp.JSON(w, http.StatusOK, out)
	case "/json", "/json/list":
		httpresp.JSON(w, http.StatusOK, []any{})
	default:
		httpErr(w, "not found", http.StatusNotFound, apierr.CodeNotFound)
	}
}

// cdpConn 은 CDP 프록시 WS 하나다. 메시지는 떨어뜨리지 않는다 — CDP 는 하나라도 빠지면
// 도구가 멈춘다. 대신 쓰기가 막히면 연결을 끊는다.
type cdpConn struct {
	conn *websocket.Conn
	out  chan []byte
	done chan struct{}
	once sync.Once
}

func (c *cdpConn) close() { c.once.Do(func() { close(c.done); c.conn.Close() }) }

func (c *cdpConn) send(b []byte) {
	select {
	case c.out <- b:
	case <-c.done:
	default:
		dmlog.Warnf(nil, "[browser] CDP 프록시 연결의 쓰기가 밀려 끊는다")
		c.close()
	}
}

func (s *Server) apiBrowserCDPWS(w http.ResponseWriter, r *http.Request, profile string) {
	// FR-BRT-23: 브라우저에서 온 연결에는 언제나 Origin 이 있고 CDP 도구는 싣지 않는다.
	if r.Header.Get("Origin") != "" {
		httpErr(w, "forbidden", http.StatusForbidden, apierr.CodeForbidden)
		return
	}
	h := s.browser
	res, err := h.host.Call(r.Context(), "proxyOpen", map[string]string{"profile": profile, "tool": r.URL.Query().Get("tool")})
	if err != nil {
		browserFail(w, err)
		return
	}
	var open struct {
		Client string `json:"client"`
	}
	json.Unmarshal(res, &open)
	raw, err := toolhub.Upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.host.Call(context.Background(), "proxyClose", map[string]string{"client": open.Client})
		return
	}
	raw.SetReadLimit(64 << 20)
	c := &cdpConn{conn: raw, out: make(chan []byte, 4096), done: make(chan struct{})}
	h.mu.Lock()
	if h.proxies == nil {
		h.proxies = map[string]*cdpConn{}
	}
	h.proxies[open.Client] = c
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.proxies, open.Client)
		h.mu.Unlock()
		c.close()
		h.host.Call(context.Background(), "proxyClose", map[string]string{"client": open.Client})
	}()
	go func() {
		for {
			select {
			case b := <-c.out:
				raw.SetWriteDeadline(time.Now().Add(30 * time.Second))
				if raw.WriteMessage(websocket.TextMessage, b) != nil {
					c.close()
					return
				}
			case <-c.done:
				return
			}
		}
	}()
	for {
		_, msg, err := raw.ReadMessage()
		if err != nil {
			return
		}
		if _, err := h.host.Call(context.Background(), "proxySend", map[string]any{"client": open.Client, "msg": json.RawMessage(msg)}); err != nil {
			return
		}
	}
}

// onProxyEvent 는 매니저가 외부 도구에게 보내는 CDP 메시지다.
func (h *browserHub) onProxyEvent(e browser.Event) {
	var info struct {
		Client string `json:"client"`
		Closed bool   `json:"closed"`
	}
	json.Unmarshal(e.Info, &info)
	h.mu.Lock()
	c := h.proxies[info.Client]
	h.mu.Unlock()
	if c == nil {
		return
	}
	if info.Closed {
		c.close()
		return
	}
	c.send(e.Data)
}

// apiBrowserDownloads 는 다운로드 목록이다 (FR-BRT-80, `dmctl browser downloads`).
func (s *Server) apiBrowserDownloads(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	s.apiBrowserCall(w, r, "downloads", map[string]any{})
}
