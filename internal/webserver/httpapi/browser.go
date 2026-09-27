package httpapi

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"dongminal/internal/shared/browser"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/uuid"
	"dongminal/internal/shared/workspace"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpresp"
)

// 브라우저 탭의 웹 서버 면이다 (BROWSER_TAB_SRS §3.4·3.5).
//
// 매니저(`browser.Host`)는 데몬 또는 이 프로세스에 산다. 여기 있는 것은 **화면과
// 명령에 닿는 일**이다 — 뷰어 WS 의 팬아웃, 탭 배치 명령, 탭 목록과 페이지 목록의
// 정합, `dmctl browser` 의 HTTP 면. **종단은 전부 `/api/` 아래다** (NFR-BRT-S1) —
// 그 밖은 `gateExempt` 가 정적 자산으로 보고 게이트를 건너뛴다.

// 배치 명령의 action 이름. 서버의 허용 표와 화면의 처리기 표가 함께 든다.
const (
	actionOpenBrowserTab = "openBrowserTab"
)

// browserHub 는 브라우저 탭의 웹 서버 쪽 상태다.
type browserHub struct {
	s    *Server
	host browser.Host

	mu      sync.Mutex
	viewers map[string]map[*browserViewer]struct{} // 탭 → 붙은 뷰어
	// pending 은 받을 화면이 없어 놓지 못한 배치다 (FR-BRT-36). 화면이 붙으면 가져간다.
	pending []map[string]any
	// placed 는 워크스페이스에 한 번이라도 나타난 탭이다. 한 번 나타났다가 사라진
	// 탭만 닫는다 — 아직 배치되지 않은 탭을 닫으면 `claude login` 이 멈춘다.
	placed map[string]bool
	// last 는 도구 → 그 도구가 마지막으로 열거나 다룬 탭이다 (FR-BRT-75).
	last map[string]string
	// proxies 는 CDP 프록시로 붙은 외부 도구의 WS 다 (FR-BRT-22).
	proxies map[string]*cdpConn
	// recovered 는 첫 claim 에서 잃은 배치를 되찾았는가다 (FR-BRT-36).
	recovered bool
}

func newBrowserHub(s *Server, host browser.Host) *browserHub {
	h := &browserHub{s: s, host: host, viewers: map[string]map[*browserViewer]struct{}{},
		placed: map[string]bool{}, last: map[string]string{}}
	host.SetSink(h.onEvent)
	return h
}

// ── 매니저의 소식 ───────────────────────────────────────────────

func (h *browserHub) onEvent(e browser.Event) {
	switch e.Kind {
	case browser.EvFrame:
		for _, v := range h.viewersOf(e.Tab) {
			v.setFrame(e.Info, e.Data)
		}
	case browser.EvProxy:
		h.onProxyEvent(e)
	case browser.EvAct, browser.EvReport, browser.EvDialog, browser.EvChooser, browser.EvDownload, browser.EvAuth:
		// FR-BRT-79·80·81·85·86·87·88: 뷰어가 이 기기에서 다시 그린다.
		msg := viewerText(e.Kind, e.Info)
		for _, v := range h.viewersOf(e.Tab) {
			v.sendText(msg)
		}
	case browser.EvState:
		msg := viewerText("state", e.Info)
		for _, v := range h.viewersOf(e.Tab) {
			v.sendText(msg)
		}
	case browser.EvClosed:
		for _, v := range h.viewersOf(e.Tab) {
			v.sendText(viewerText("closed", nil))
		}
		// FR-BRT-37: 페이지가 닫혔으면 탭을 닫는다. 한 곳에서만 돈다 (single).
		h.broadcast("closeTab", map[string]any{"location": e.Tab, "force": true})
	case browser.EvCreated:
		var c browser.Created
		json.Unmarshal(e.Info, &c)
		args := map[string]any{"tab": e.Tab, "url": c.URL, "profile": c.Profile, "isolated": c.Isolated,
			"opener": c.Opener, "background": c.Background, "popup": c.Popup, "tool": c.Tool,
			"name": c.Name, "devtoolsOf": c.DevtoolsOf,
			// FR-BRT-33·34: 페이지가 연 탭은 Chrome 관례, 외부 도구의 페이지는 옮기지 않는다.
			"focus": c.Opener != "" && !c.Background}
		h.place(args)
	}
}

func (h *browserHub) viewersOf(tab string) []*browserViewer {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]*browserViewer, 0, len(h.viewers[tab]))
	for v := range h.viewers[tab] {
		out = append(out, v)
	}
	return out
}

// broadcast 는 한 화면에서만 도는 명령 하나를 보낸다. 받은 화면 수를 낸다.
func (h *browserHub) broadcast(action string, args map[string]any) int {
	if h.s.Commands == nil {
		return 0
	}
	exec := ""
	if h.s.Focus != nil {
		exec = h.s.Focus.Executor()
	}
	body := map[string]any{"action": action, "args": args}
	if exec != "" {
		body["execClientId"] = exec
	}
	b, _ := json.Marshal(body)
	return h.s.Commands.Broadcast(b)
}

// place 는 탭 배치를 화면에 보낸다. 받을 화면이 없으면 들고 있다 (FR-BRT-36).
func (h *browserHub) place(args map[string]any) {
	if h.broadcast(actionOpenBrowserTab, args) > 0 {
		return
	}
	h.mu.Lock()
	h.pending = append(h.pending, args)
	h.mu.Unlock()
}

// claimPending 은 들고 있던 배치를 한 번에 내어 준다 — 먼저 가져간 화면이 놓는다.
func (h *browserHub) claimPending() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.pending
	h.pending = nil
	if out == nil {
		out = []map[string]any{}
	}
	return out
}

func (h *browserHub) touch(tool, tab string) {
	if tool == "" || tab == "" {
		return
	}
	h.mu.Lock()
	h.last[tool] = tab
	h.mu.Unlock()
	h.host.Call(context.Background(), "touch", map[string]any{"tab": tab, "tool": tool})
}

// resolveTab 은 대상 탭이다 — 없으면 호출 도구가 마지막으로 다룬 탭 (FR-BRT-75).
func (h *browserHub) resolveTab(tab, tool string) (string, error) {
	if tab != "" {
		return tab, nil
	}
	h.mu.Lock()
	t := h.last[tool]
	h.mu.Unlock()
	if t == "" {
		return "", errors.New("대상 브라우저 탭이 없습니다 — --tab <uuid> 로 지정하거나 먼저 dmctl browser open 으로 여세요")
	}
	return t, nil
}

// ensureTab 은 지연 복원이다 (FR-BRT-39) — `dmctl`·화면이 가리킨 탭에 페이지가 없으면
// 워크스페이스에 적힌 url·프로필·고정 크기로 만든다. 데몬이 다시 뜨면 매니저는 그 탭을
// 모르므로 근거는 워크스페이스뿐이다.
// 워크스페이스에 없으면(막 연 탭의 저장이 아직이다) `fallback` 으로 만든다.
func (h *browserHub) ensureTab(ctx context.Context, tab string, fallback browser.OpenReq) error {
	req := fallback
	req.Tab = tab
	if h.s.Work != nil {
		for _, t := range workspace.BrowserTabsOf(h.s.Work.Raw()) {
			if t.ID != tab {
				continue
			}
			req.URL, req.Profile, req.Isolated = t.URL, t.Profile, t.Isolated
			if t.Viewport != nil {
				req.Viewport = &browser.Size{W: t.Viewport.W, H: t.Viewport.H}
			}
			break
		}
	}
	// DevTools 탭은 대상에 붙은 Chrome 안의 페이지라 다시 만들 수 없다 — 탭을 닫는다 (FR-BRT-84).
	if strings.HasPrefix(req.URL, "devtools://") {
		if raw, err := h.host.Call(ctx, "state", map[string]any{"tab": tab}); err == nil && len(raw) > 0 {
			return nil
		}
		h.broadcast("closeTab", map[string]any{"location": tab, "force": true})
		return errors.New("DevTools 탭은 다시 열 수 없습니다 — 대상 탭에서 다시 여세요")
	}
	_, err := h.host.Call(ctx, "ensure", req)
	return err
}

// reconcile 은 워크스페이스에서 사라진 탭의 페이지를 닫는다 (FR-BRT-31). 한 번도
// 나타나지 않은 탭(배치 대기)은 건드리지 않는다.
func (h *browserHub) reconcile() {
	if h.s.Work == nil {
		return
	}
	tabs := workspace.BrowserTabsOf(h.s.Work.Raw())
	if tabs == nil {
		return
	}
	in := make(map[string]bool, len(tabs))
	for _, t := range tabs {
		in[t.ID] = true
	}
	raw, err := h.host.Call(context.Background(), "tabs", map[string]any{})
	if err != nil {
		return
	}
	var list struct {
		Tabs []browser.TabInfo `json:"tabs"`
	}
	json.Unmarshal(raw, &list)
	var gone []string
	h.mu.Lock()
	for id := range in {
		h.placed[id] = true
	}
	for _, t := range list.Tabs {
		if !in[t.Tab] && h.placed[t.Tab] {
			gone = append(gone, t.Tab)
			delete(h.placed, t.Tab)
		}
	}
	h.mu.Unlock()
	for _, id := range gone {
		h.host.Call(context.Background(), "close", map[string]any{"tab": id})
	}
}

// ── HTTP 면 ─────────────────────────────────────────────────────

func (s *Server) browserReady(w http.ResponseWriter) bool {
	if s.browser == nil {
		httpErr(w, "browser tabs unavailable", http.StatusServiceUnavailable, apierr.CodeUnavailable)
		return false
	}
	return true
}

// browserFail 은 매니저의 거절을 옮긴다. 문구는 사용자에게 하려던 말이다 — 엔진
// 없음·scheme·프로필 이름 등. 상태는 하나(409)로 둔다: 받는 쪽(`dmctl`)이 할 일이
// 같다 — 문구를 보이고 1 로 끝난다.
func browserFail(w http.ResponseWriter, err error) {
	httpErr(w, err.Error(), http.StatusConflict, apierr.CodeConflict)
}

func (s *Server) apiBrowserCall(w http.ResponseWriter, r *http.Request, op string, params any) {
	res, err := s.browser.host.Call(r.Context(), op, params)
	if err != nil {
		browserFail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(res)
}

func (s *Server) apiBrowserProfiles(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	s.apiBrowserCall(w, r, "profiles", map[string]any{})
}

func (s *Server) apiBrowserProfileCreate(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if ok, answered := readBodyHTTP(w, r, &body); answered || !ok {
		if !answered {
			httpErr(w, "invalid json", http.StatusBadRequest, apierr.CodeInvalidJSON)
		}
		return
	}
	s.apiBrowserCall(w, r, "profileCreate", body)
}

func (s *Server) apiBrowserProfileDelete(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if ok, answered := readBodyHTTP(w, r, &body); answered || !ok {
		if !answered {
			httpErr(w, "invalid json", http.StatusBadRequest, apierr.CodeInvalidJSON)
		}
		return
	}
	s.apiBrowserCall(w, r, "profileDelete", body)
}

// browserOpenBody 는 `dmctl browser open`·쉘 훅·화면이 여는 요청이다.
type browserOpenBody struct {
	URL      string `json:"url"`
	Profile  string `json:"profile"`
	Isolated bool   `json:"isolated"`
	// Split 은 `right|down|none` 이다 — 비면 설정(`browserOpenPlacement`)을 따른다.
	Split string `json:"split"`
	Focus bool   `json:"focus"`
	// Tool 은 부른 도구다 — 호출 칸의 근거 (FR-BRT-32).
	Tool string `json:"tool"`
}

// apiBrowserOpen 은 페이지를 **즉시** 만들고 배치를 화면에 보낸다 (FR-BRT-36).
// 탭 uuid 는 서버가 먼저 정한다 — 페이지가 화면보다 먼저 서야 하기 때문이다.
func (s *Server) apiBrowserOpen(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	var body browserOpenBody
	if ok, answered := readBodyHTTP(w, r, &body); answered || !ok {
		if !answered {
			httpErr(w, "invalid json", http.StatusBadRequest, apierr.CodeInvalidJSON)
		}
		return
	}
	if err := browser.CheckURL(body.URL); err != nil {
		httpErr(w, err.Error(), http.StatusBadRequest, apierr.CodeBadRequest)
		return
	}
	switch body.Split {
	case "", "right", "down", "none":
	default:
		httpErr(w, "split must be right, down or none", http.StatusBadRequest, apierr.CodeBadRequest)
		return
	}
	if body.Profile == "" {
		body.Profile = browser.DefaultProfileSetting(s.cfg.DataDir)
	}
	tab := uuid.NewString()
	if _, err := s.browser.host.Call(r.Context(), "open", browser.OpenReq{Tab: tab, URL: body.URL,
		Profile: body.Profile, Isolated: body.Isolated}); err != nil {
		browserFail(w, err)
		return
	}
	s.browser.touch(body.Tool, tab)
	placement := body.Split
	if placement == "" {
		if browser.OpenPlacementSetting(s.cfg.DataDir) == "tab" {
			placement = "none"
		} else {
			placement = "right"
		}
	}
	s.browser.place(map[string]any{"tab": tab, "url": body.URL, "profile": body.Profile,
		"isolated": body.Isolated, "tool": body.Tool, "split": placement, "focus": body.Focus})
	httpresp.JSON(w, http.StatusOK, map[string]any{"ok": true, "tab": tab})
}

// browserTabBody 는 탭 하나를 가리키는 요청이다. Tab 이 비면 Tool 이 마지막으로 다룬 탭이다.
type browserTabBody struct {
	Tab    string `json:"tab"`
	Tool   string `json:"tool"`
	Action string `json:"action,omitempty"`
	URL    string `json:"url,omitempty"`
	Hard   bool   `json:"hard,omitempty"`
	W      int    `json:"w,omitempty"`
	H      int    `json:"h,omitempty"`
	Auto   bool   `json:"auto,omitempty"`
}

func (s *Server) browserTabReq(w http.ResponseWriter, r *http.Request) (browserTabBody, bool) {
	var body browserTabBody
	if !s.browserReady(w) {
		return body, false
	}
	if ok, answered := readBodyHTTP(w, r, &body); answered || !ok {
		if !answered {
			httpErr(w, "invalid json", http.StatusBadRequest, apierr.CodeInvalidJSON)
		}
		return body, false
	}
	tab, err := s.browser.resolveTab(body.Tab, body.Tool)
	if err != nil {
		httpErr(w, err.Error(), http.StatusNotFound, apierr.CodeNotFound)
		return body, false
	}
	body.Tab = tab
	s.browser.touch(body.Tool, tab)
	return body, true
}

func (s *Server) apiBrowserClose(w http.ResponseWriter, r *http.Request) {
	body, ok := s.browserTabReq(w, r)
	if !ok {
		return
	}
	s.apiBrowserCall(w, r, "close", map[string]any{"tab": body.Tab})
	// 화면의 탭도 닫는다 — 화면이 부른 닫기면 이미 없어 아무 일도 없다.
	s.browser.broadcast("closeTab", map[string]any{"location": body.Tab, "force": true})
}

func (s *Server) apiBrowserNav(w http.ResponseWriter, r *http.Request) {
	body, ok := s.browserTabReq(w, r)
	if !ok {
		return
	}
	s.browser.ensureTab(r.Context(), body.Tab, browser.OpenReq{})
	s.apiBrowserCall(w, r, "nav", map[string]any{"tab": body.Tab, "action": body.Action, "url": body.URL, "hard": body.Hard})
}

// apiBrowserViewport 는 고정 크기다 (FR-BRT-52). auto 면 고정을 푼다.
func (s *Server) apiBrowserViewport(w http.ResponseWriter, r *http.Request) {
	body, ok := s.browserTabReq(w, r)
	if !ok {
		return
	}
	if !body.Auto && (body.W < 100 || body.H < 100 || body.W > 8192 || body.H > 8192) {
		httpErr(w, "viewport must be 100..8192", http.StatusBadRequest, apierr.CodeBadRequest)
		return
	}
	fixed := !body.Auto
	s.browser.ensureTab(r.Context(), body.Tab, browser.OpenReq{})
	s.apiBrowserCall(w, r, "viewport", map[string]any{"tab": body.Tab, "w": body.W, "h": body.H, "dpr": 1, "fixed": fixed})
}

// apiBrowserFocus 는 그 탭으로 시선을 옮긴다 — 한 화면에서만 (single).
func (s *Server) apiBrowserFocus(w http.ResponseWriter, r *http.Request) {
	body, ok := s.browserTabReq(w, r)
	if !ok {
		return
	}
	n := s.browser.broadcast("focus", map[string]any{"location": body.Tab})
	httpresp.JSON(w, http.StatusOK, map[string]any{"ok": true, "tab": body.Tab, "delivered": n})
}

func (s *Server) apiBrowserTabs(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	raw, err := s.browser.host.Call(r.Context(), "tabs", map[string]any{})
	if err != nil {
		browserFail(w, err)
		return
	}
	var list struct {
		Tabs []browser.TabInfo `json:"tabs"`
	}
	json.Unmarshal(raw, &list)
	// 워크스페이스에만 있는(아직 페이지가 없는) 탭도 목록에 든다 — 지연 복원 (FR-BRT-39).
	seen := map[string]bool{}
	for _, t := range list.Tabs {
		seen[t.Tab] = true
	}
	if s.Work != nil {
		for _, t := range workspace.BrowserTabsOf(s.Work.Raw()) {
			if !seen[t.ID] {
				list.Tabs = append(list.Tabs, browser.TabInfo{Tab: t.ID, Profile: t.Profile, Isolated: t.Isolated, URL: t.URL, Title: t.Name})
			}
		}
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"tabs": list.Tabs})
}

func (s *Server) apiBrowserClaim(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	s.browser.recoverPlacements(r.Context())
	httpresp.JSON(w, http.StatusOK, map[string]any{"placements": s.browser.claimPending()})
}

// recoverPlacements 는 웹서버가 다시 떠 들고 있던 배치를 잃었을 때다 (FR-BRT-36). 배치는
// 웹서버의 메모리에 있고 페이지는 데몬에 있다 — 매니저에 살아 있는데 워크스페이스에 없는
// 탭은 놓이지 못한 것이다. 이 웹서버의 첫 claim 에서 한 번만 본다: 그 뒤의 배치는 평소 길로 오고,
// 막 열려 저장을 기다리는 탭을 두 번 놓지 않는다.
func (h *browserHub) recoverPlacements(ctx context.Context) {
	h.mu.Lock()
	done := h.recovered
	h.recovered = true
	h.mu.Unlock()
	if done || h.s.Work == nil {
		return
	}
	raw, err := h.host.Call(ctx, "tabs", map[string]any{})
	if err != nil {
		return
	}
	var list struct {
		Tabs []browser.TabInfo `json:"tabs"`
	}
	json.Unmarshal(raw, &list)
	in := map[string]bool{}
	for _, t := range workspace.BrowserTabsOf(h.s.Work.Raw()) {
		in[t.ID] = true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.pending {
		if id, _ := p["tab"].(string); id != "" {
			in[id] = true
		}
	}
	for _, t := range list.Tabs {
		if t.Live && !in[t.Tab] {
			h.pending = append(h.pending, map[string]any{"tab": t.Tab, "url": t.URL, "name": t.Title,
				"profile": t.Profile, "isolated": t.Isolated})
		}
	}
}

// ── 뷰어 WS (FR-BRT-50) ─────────────────────────────────────────

// viewerOps 는 뷰어가 부를 수 있는 조작이다. 나머지(프로필·열기·cdp)는 막는다.
var viewerOps = map[string]bool{"input": true, "nav": true, "viewport": true, "zoom": true,
	// 3단계 — 찾기·위젯 값·대화상자·파일 선택·인증의 답·DevTools (FR-BRT-81·84~89).
	"find": true, "widget": true, "dialog": true, "chooser": true, "auth": true, "devtools": true,
	// 4단계 — 소리의 신호 (FR-BRT-91). 이미지 복사 (FR-BRT-87).
	"audio": true, "copyImage": true}

// browserViewer 는 붙은 뷰어 하나다. 프레임은 **최신 하나만** 든다 — 느린 뷰어는
// 밀린 프레임을 받지 않는다 (FR-BRT-50).
type browserViewer struct {
	conn *websocket.Conn
	wake chan struct{}

	mu    sync.Mutex
	frame []byte
	texts [][]byte
	// peers 는 이 뷰어가 받는 소리다 — 연결이 끊기면 서버가 끝낸다 (FR-BRT-91).
	peers  map[string]bool
	closed bool
}

func (v *browserViewer) signal() {
	select {
	case v.wake <- struct{}{}:
	default:
	}
}

// setFrame 은 `[4바이트 메타 길이][메타 JSON][JPEG]` 한 덩어리로 든다.
func (v *browserViewer) setFrame(meta json.RawMessage, jpeg []byte) {
	b := make([]byte, 4+len(meta)+len(jpeg))
	binary.BigEndian.PutUint32(b, uint32(len(meta)))
	copy(b[4:], meta)
	copy(b[4+len(meta):], jpeg)
	v.mu.Lock()
	v.frame = b
	v.mu.Unlock()
	v.signal()
}

func (v *browserViewer) sendText(b []byte) {
	v.mu.Lock()
	if len(v.texts) < 256 {
		v.texts = append(v.texts, b)
	}
	v.mu.Unlock()
	v.signal()
}

func viewerText(t string, info json.RawMessage) []byte {
	b, _ := json.Marshal(map[string]any{"t": t, "info": info})
	return b
}

func (v *browserViewer) writeLoop(done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case <-v.wake:
		}
		v.mu.Lock()
		texts, frame := v.texts, v.frame
		v.texts, v.frame = nil, nil
		v.mu.Unlock()
		for _, t := range texts {
			v.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if v.conn.WriteMessage(websocket.TextMessage, t) != nil {
				return
			}
		}
		if frame != nil {
			v.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if v.conn.WriteMessage(websocket.BinaryMessage, frame) != nil {
				return
			}
		}
	}
}

// apiBrowserStream 은 뷰어 하나의 연결이다. 붙으면 페이지를 보장하고(지연 복원,
// FR-BRT-39), 첫 뷰어면 screencast 를 켜고, 마지막 뷰어가 떠나면 끈다 (FR-BRT-40).
func (s *Server) apiBrowserStream(w http.ResponseWriter, r *http.Request) {
	if !s.browserReady(w) {
		return
	}
	q := r.URL.Query()
	tab := q.Get("tab")
	if tab == "" {
		httpErr(w, "tab required", http.StatusBadRequest, apierr.CodeBadRequest)
		return
	}
	raw, err := toolhub.Upgrader.Upgrade(w, r, nil)
	if err != nil {
		dmlog.Infof(nil, "browser stream upgrade addr=%s: %v", r.RemoteAddr, err)
		return
	}
	defer raw.Close()
	raw.SetReadLimit(wsReadLimit)
	v := &browserViewer{conn: raw, wake: make(chan struct{}, 1)}
	done := make(chan struct{})
	defer close(done)
	go v.writeLoop(done)

	h := s.browser
	ctx := context.Background()
	fromQuery := browser.OpenReq{URL: q.Get("url"), Profile: q.Get("profile"), Isolated: q.Get("isolated") == "1"}
	if err := h.ensureTab(ctx, tab, fromQuery); err != nil {
		info, _ := json.Marshal(map[string]string{"message": err.Error()})
		v.sendText(viewerText("error", info))
		// 읽기를 이어 간다 — 뷰어가 다시 시도(nav reload)하거나 닫을 때까지 연결을 둔다.
	}
	h.mu.Lock()
	first := len(h.viewers[tab]) == 0
	if h.viewers[tab] == nil {
		h.viewers[tab] = map[*browserViewer]struct{}{}
	}
	h.viewers[tab][v] = struct{}{}
	h.mu.Unlock()
	if first {
		h.host.Call(ctx, "watch", map[string]any{"tab": tab, "on": true})
	} else if st, err := h.host.Call(ctx, "state", map[string]any{"tab": tab}); err == nil {
		v.sendText(viewerText("state", st))
	}
	// 답을 기다리는 것 — 뷰어가 없던 때 열린 파일 선택·대화상자·인증 (FR-BRT-81·85·86).
	if raw, err := h.host.Call(ctx, "pending", map[string]any{"tab": tab}); err == nil {
		var p struct {
			Items []struct {
				T    string          `json:"t"`
				Info json.RawMessage `json:"info"`
			} `json:"items"`
		}
		json.Unmarshal(raw, &p)
		for _, it := range p.Items {
			v.sendText(viewerText(it.T, it.Info))
		}
	}
	// 붙기 전에 시작·완료된 이 탭의 다운로드도 줄에 보인다 (FR-BRT-80).
	if raw, err := h.host.Call(ctx, "downloads", map[string]any{}); err == nil {
		var d struct {
			Downloads []json.RawMessage `json:"downloads"`
		}
		json.Unmarshal(raw, &d)
		for _, x := range d.Downloads {
			var head struct {
				Tab string `json:"tab"`
			}
			json.Unmarshal(x, &head)
			if head.Tab == tab {
				v.sendText(viewerText(browser.EvDownload, x))
			}
		}
	}
	defer func() {
		h.mu.Lock()
		delete(h.viewers[tab], v)
		last := len(h.viewers[tab]) == 0
		if last {
			delete(h.viewers, tab)
		}
		h.mu.Unlock()
		if last {
			h.host.Call(context.Background(), "watch", map[string]any{"tab": tab, "on": false})
		}
		v.mu.Lock()
		peers := v.peers
		v.peers, v.closed = nil, true
		v.mu.Unlock()
		for p := range peers {
			h.host.Call(context.Background(), "audio", map[string]any{"tab": tab, "action": "stop", "peer": p})
		}
	}()

	for {
		_, msg, err := raw.ReadMessage()
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(msg, &m) != nil {
			continue
		}
		op, _ := m["op"].(string)
		if !viewerOps[op] {
			continue
		}
		delete(m, "op")
		m["tab"] = tab
		if op == "audio" {
			// offer 는 ICE 수집까지 몇 초 걸린다 — 입력을 막지 않게 따로 돈다.
			go h.viewerAudio(v, m)
			continue
		}
		if op == "nav" {
			// 되살리기 — 브라우저가 끝나 페이지를 잃은 탭은 다시 연다 (FR-BRT-38).
			h.ensureTab(ctx, tab, fromQuery)
		}
		res, err := h.host.Call(ctx, op, m)
		if err != nil && op == "copyImage" {
			// 복사 실패는 화면을 가리지 않는다 — 뷰어가 주소 복사로 물러선다.
			info, _ := json.Marshal(map[string]string{"error": err.Error()})
			v.sendText(viewerText("image", info))
			continue
		}
		if err != nil && op != "input" {
			info, _ := json.Marshal(map[string]string{"message": err.Error()})
			v.sendText(viewerText("error", info))
			continue
		}
		if op == "find" {
			v.sendText(viewerText("find", res))
		}
		if op == "copyImage" {
			v.sendText(viewerText("image", res))
		}
	}
}

// viewerAudio 는 뷰어 하나의 소리 신호다 (FR-BRT-91). 거절은 화면을 가리지 않는다 —
// `{t:audio, info:{error}}` 로만 알린다.
func (h *browserHub) viewerAudio(v *browserViewer, m map[string]any) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	action, _ := m["action"].(string)
	peer, _ := m["peer"].(string)
	res, err := h.host.Call(ctx, "audio", m)
	if err != nil {
		if action == "offer" {
			info, _ := json.Marshal(map[string]string{"error": err.Error()})
			v.sendText(viewerText("audio", info))
		}
		return
	}
	switch action {
	case "offer":
		var r struct {
			Peer string `json:"peer"`
		}
		json.Unmarshal(res, &r)
		v.mu.Lock()
		gone := v.closed
		if !gone {
			if v.peers == nil {
				v.peers = map[string]bool{}
			}
			v.peers[r.Peer] = true
		}
		v.mu.Unlock()
		if gone {
			// 답을 기다리는 사이 뷰어가 떠났다 — 받을 이가 없다.
			h.host.Call(ctx, "audio", map[string]any{"tab": m["tab"], "action": "stop", "peer": r.Peer})
			return
		}
		v.sendText(viewerText("audio", res))
	case "stop":
		v.mu.Lock()
		delete(v.peers, peer)
		v.mu.Unlock()
	}
}
