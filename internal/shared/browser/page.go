package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"sync"
	"time"

	"dongminal/internal/shared/cdp"
	"dongminal/internal/shared/uuid"
)

// isolatedWorld 는 주입 스크립트가 도는 격리 world 의 이름이다 (NFR-BRT-S2).
const isolatedWorld = "dongminal"

// baseSelectScript 는 네이티브 `<select>` 목록이 screencast 에 그려지게 한다
// (FR-BRT-60, P4). **규칙 둘**이다 — 한 선택자 목록으로 묶으면 규칙 전체가 무효다.
// `<style>` 을 붙이지 않고 `adoptedStyleSheets` 를 쓴다 — 문서 시작에는 `head` 가 없다.
const baseSelectScript = `(() => {
  try {
    const s = new CSSStyleSheet();
    s.insertRule('select { appearance: base-select }');
    s.insertRule('::picker(select) { appearance: base-select }', 1);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
  } catch (e) {}
})();`

func newTabID() string { return uuid.NewString() }

// page 는 탭 하나에 대응하는 Chrome 페이지다 (FR-BRT-31).
type page struct {
	b        *profileBrowser
	tab      string
	target   string
	session  string
	profile  string
	context  string
	isolated bool
	popup    bool
	tool     string
	attached chan struct{}
	// gone 은 페이지가 사라지면 닫힌다. inq 는 입력의 줄이다 — 입력은 도착한 순서로
	// 한 고루틴이 보낸다 (누름·뗌이 뒤바뀌면 클릭이 아니다).
	gone     chan struct{}
	goneOnce sync.Once
	inOnce   sync.Once
	inq      chan json.RawMessage

	mu       sync.Mutex
	st       TabState
	watching bool
	// vp 는 창의 주인이 정한 뷰포트, fixed 는 고정 크기다 (FR-BRT-51·52).
	vp    viewport
	fixed *viewport
	zoom  float64
	// quality 는 screencast JPEG 품질이다 — 0 이면 QualityMax (FR-BRT-95).
	quality int
	// acts 는 2단계 상태(ref·기록)다 (act.go). fids 는 3단계(대화상자·파일 선택)다.
	acts *actState
	fids *fidelityState
	// worldCtx 는 최상위 프레임의 격리 world 실행 컨텍스트다 (agent.go).
	worldCtx int
	// devtoolsOf 는 DevTools 탭이면 대상 탭 id 다 (FR-BRT-84).
	devtoolsOf string
	// 마지막 누름 — Ctrl/⌘/가운데 클릭으로 연 탭은 뒤에 연다 (FR-BRT-33).
	lastMods   int
	lastButton string
	lastPress  time.Time
}

type viewport struct {
	W   int     `json:"w"`
	H   int     `json:"h"`
	DPR float64 `json:"dpr"`
}

func (pg *page) cl() *cdp.Client { return pg.b.cl }

func (pg *page) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return pg.b.cl.Call(ctx, pg.session, method, params)
}

func (pg *page) emitState() {
	pg.mu.Lock()
	st := pg.st
	st.Zoom = pg.zoom
	pg.mu.Unlock()
	pg.b.m.emitInfo(EvState, pg.tab, st)
}

func (pg *page) backgroundOpen() bool {
	pg.mu.Lock()
	defer pg.mu.Unlock()
	if time.Since(pg.lastPress) > 2*time.Second {
		return false
	}
	return pg.lastMods&(ModCtrl|ModMeta) != 0 || pg.lastButton == "middle"
}

// onInfo 는 `Target.targetInfoChanged` — 제목과 주소가 바뀐다.
func (pg *page) onInfo(ti targetInfo) {
	pg.mu.Lock()
	if pg.devtoolsOf != "" {
		ti.Title = pg.st.Title // FR-BRT-84: "DevTools · <대상 제목>" 을 지킨다
	}
	changed := pg.st.Title != ti.Title || pg.st.URL != ti.URL
	pg.st.Title = ti.Title
	if ti.URL != "" {
		pg.st.URL = ti.URL
	}
	pg.mu.Unlock()
	if changed {
		pg.emitState()
	}
}

// onEvent 는 페이지 세션의 이벤트다.
func (pg *page) onEvent(msg *cdp.Message) {
	switch msg.Method {
	case "Page.frameNavigated":
		var p struct {
			Frame struct {
				ID       string `json:"id"`
				ParentID string `json:"parentId"`
				URL      string `json:"url"`
				Fragment string `json:"urlFragment"`
			} `json:"frame"`
		}
		json.Unmarshal(msg.Params, &p)
		if p.Frame.ParentID != "" {
			return
		}
		pg.mu.Lock()
		pg.st.URL = p.Frame.URL + p.Frame.Fragment
		pg.st.Crashed = false
		pg.mu.Unlock()
		pg.onDocumentReplaced()
		pg.refreshHistory()
	case "Page.navigatedWithinDocument":
		var p struct {
			FrameID string `json:"frameId"`
			URL     string `json:"url"`
		}
		json.Unmarshal(msg.Params, &p)
		if p.FrameID != pg.target {
			return
		}
		pg.mu.Lock()
		pg.st.URL = p.URL
		pg.mu.Unlock()
		pg.refreshHistory()
	case "Page.domContentEventFired", "Page.loadEventFired":
		// 제목은 문서가 선 뒤에 바뀐다 — targetInfoChanged 만으로는 오지 않는 때가 있다.
		pg.refreshHistory()
	case "Page.frameStartedLoading", "Page.frameStoppedLoading":
		var p struct {
			FrameID string `json:"frameId"`
		}
		json.Unmarshal(msg.Params, &p)
		if p.FrameID != pg.target {
			return
		}
		pg.mu.Lock()
		pg.st.Loading = msg.Method == "Page.frameStartedLoading"
		pg.mu.Unlock()
		pg.emitState()
	case "Page.windowOpen":
		var p struct {
			URL            string   `json:"url"`
			WindowFeatures []string `json:"windowFeatures"`
		}
		json.Unmarshal(msg.Params, &p)
		pg.b.mu.Lock()
		pg.b.opens[p.URL] = windowOpen{features: p.WindowFeatures, at: time.Now()}
		pg.b.mu.Unlock()
	case "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared":
		pg.onContext(msg.Method, msg.Params)
	case "Runtime.bindingCalled":
		var p struct {
			Name    string `json:"name"`
			Payload string `json:"payload"`
		}
		json.Unmarshal(msg.Params, &p)
		if p.Name == reportBinding && json.Valid([]byte(p.Payload)) {
			pg.b.m.emit(Event{Kind: EvReport, Tab: pg.tab, Info: json.RawMessage(p.Payload)})
		}
	case "Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened", "Fetch.authRequired":
		pg.onFidelityEvent(msg.Method, msg.Params)
	case "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Network.requestWillBeSent",
		"Network.responseReceived", "Network.loadingFailed":
		pg.onLogEvent(msg.Method, msg.Params)
	case "Inspector.targetCrashed":
		pg.markCrashed()
	}
}

// markCrashed 는 렌더러가 죽은 페이지다 — 뷰어가 "페이지가 멈췄습니다" 를 띄운다 (FR-BRT-38).
// 페이지 세션의 Inspector.targetCrashed 와 브라우저 수준의 Target.targetCrashed 가 둘 다 여기로
// 온다 — Linux headless 는 뒤의 것만 왔다(CI 실측). 두 번 와도 한 번만 알린다.
func (pg *page) markCrashed() {
	pg.mu.Lock()
	was := pg.st.Crashed
	pg.st.Crashed = true
	pg.st.Loading = false
	pg.mu.Unlock()
	if !was {
		pg.emitState()
	}
}

func (pg *page) refreshHistory() {
	res, err := pg.call(context.Background(), "Page.getNavigationHistory", nil)
	if err == nil {
		var h struct {
			CurrentIndex int `json:"currentIndex"`
			Entries      []struct {
				URL   string `json:"url"`
				Title string `json:"title"`
			} `json:"entries"`
		}
		json.Unmarshal(res, &h)
		pg.mu.Lock()
		pg.st.CanBack = h.CurrentIndex > 0
		pg.st.CanForward = h.CurrentIndex < len(h.Entries)-1
		if h.CurrentIndex >= 0 && h.CurrentIndex < len(h.Entries) {
			// DevTools 탭의 이름은 "DevTools · <대상 제목>" 으로 둔다 (FR-BRT-84).
			if e := h.Entries[h.CurrentIndex]; e.Title != "" && pg.devtoolsOf == "" {
				pg.st.Title = e.Title
			}
		}
		pg.mu.Unlock()
	}
	pg.emitState()
}

// onFrame 은 screencast 프레임 하나를 내보내고 곧바로 ack 한다 (FR-BRT-50). 느린
// 뷰어의 밀린 프레임은 받는 쪽이 버린다 — 여기서는 Chrome 의 속도만 맞춘다.
func (b *profileBrowser) onFrame(msg *cdp.Message) {
	var p struct {
		Data      string          `json:"data"`
		Metadata  json.RawMessage `json:"metadata"`
		SessionID int             `json:"sessionId"`
	}
	json.Unmarshal(msg.Params, &p)
	b.cl.Fire(msg.SessionID, "Page.screencastFrameAck", map[string]any{"sessionId": p.SessionID})
	b.mu.Lock()
	pg := b.sessions[msg.SessionID]
	b.mu.Unlock()
	if pg == nil {
		return
	}
	data, err := base64.StdEncoding.DecodeString(p.Data)
	if err != nil {
		return
	}
	b.m.emit(Event{Kind: EvFrame, Tab: pg.tab, Data: data, Info: p.Metadata})
}

// do 는 탭 하나에 대한 조작이다.
func (pg *page) do(ctx context.Context, op string, params json.RawMessage) (any, error) {
	switch op {
	case "state":
		pg.mu.Lock()
		st := pg.st
		st.Zoom = pg.zoom
		pg.mu.Unlock()
		return st, nil
	case "nav":
		var p struct {
			Action string `json:"action"`
			URL    string `json:"url"`
			Hard   bool   `json:"hard"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return okResult, pg.nav(ctx, p.Action, p.URL, p.Hard)
	case "watch":
		var p struct {
			On bool `json:"on"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return okResult, pg.watch(ctx, p.On)
	case "viewport":
		var p struct {
			viewport
			Fixed *bool `json:"fixed"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return okResult, pg.setViewport(ctx, p.viewport, p.Fixed)
	case "quality":
		var p struct {
			Q int `json:"q"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return okResult, pg.setQuality(ctx, p.Q)
	case "zoom":
		var p struct {
			Zoom float64 `json:"zoom"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return okResult, pg.setZoom(ctx, p.Zoom)
	case "input":
		return okResult, pg.enqueueInput(params)
	case "touch":
		var p struct {
			Tool string `json:"tool"`
		}
		json.Unmarshal(params, &p)
		pg.mu.Lock()
		pg.tool = p.Tool
		pg.mu.Unlock()
		return okResult, nil
	case "cdp":
		var p struct {
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if len(p.Params) == 0 {
			return pg.call(ctx, p.Method, nil)
		}
		return pg.call(ctx, p.Method, p.Params)
	}
	if res, ok, err := pg.doFidelity(ctx, op, params); ok {
		return res, err
	}
	switch op {
	case "state", "console", "network", "screenshot":
	default:
		// 대화상자가 떠 있으면 페이지의 스크립트가 멈춰 있다 — 조작은 그것부터 답하라고 알린다.
		if err := pg.dialogOpen(); err != nil {
			if _, isAct := actOps[op]; isAct {
				return nil, err
			}
		}
	}
	if res, ok, err := pg.doAct(ctx, op, params); ok {
		return res, err
	}
	return nil, errors.New("모르는 조작입니다: " + op)
}

// nav 는 도구 막대와 `dmctl browser goto/back/forward/reload` 다 (FR-BRT-58).
func (pg *page) nav(ctx context.Context, action, url string, hard bool) error {
	// 이동은 **답을 기다리지 않는다** — 커밋까지 답하지 않으므로(인증 대기 동안은 끝없이)
	// 기다리면 뷰어의 다음 입력(인증의 답 포함)이 그 뒤에 선다. 도착은 `wait --load` 로 본다.
	switch action {
	case "goto":
		if err := CheckURL(url); err != nil {
			return err
		}
		pg.b.cl.Fire(pg.session, "Page.navigate", map[string]any{"url": url})
		return nil
	case "reload":
		pg.b.cl.Fire(pg.session, "Page.reload", map[string]any{"ignoreCache": hard})
		return nil
	case "stop":
		_, err := pg.call(ctx, "Page.stopLoading", nil)
		return err
	case "back", "forward":
		res, err := pg.call(ctx, "Page.getNavigationHistory", nil)
		if err != nil {
			return err
		}
		var h struct {
			CurrentIndex int `json:"currentIndex"`
			Entries      []struct {
				ID int `json:"id"`
			} `json:"entries"`
		}
		json.Unmarshal(res, &h)
		i := h.CurrentIndex - 1
		if action == "forward" {
			i = h.CurrentIndex + 1
		}
		if i < 0 || i >= len(h.Entries) {
			return nil
		}
		pg.b.cl.Fire(pg.session, "Page.navigateToHistoryEntry", map[string]any{"entryId": h.Entries[i].ID})
		return nil
	}
	return errors.New("모르는 이동입니다: " + action)
}

// watch 는 뷰어가 이 탭을 보는가다 (FR-BRT-40). 보면 한 장을 먼저 보내고 screencast
// 를 켠다. 안 보면 screencast 만 멈춘다 — 페이지는 계속 돈다.
func (pg *page) watch(ctx context.Context, on bool) error {
	pg.mu.Lock()
	was := pg.watching
	pg.watching = on
	pg.mu.Unlock()
	if !on {
		if was {
			pg.call(ctx, "Page.stopScreencast", nil)
		}
		return nil
	}
	if res, err := pg.call(ctx, "Page.captureScreenshot", map[string]any{"format": "jpeg", "quality": 70}); err == nil {
		var s struct {
			Data string `json:"data"`
		}
		json.Unmarshal(res, &s)
		if data, err := base64.StdEncoding.DecodeString(s.Data); err == nil {
			meta, _ := json.Marshal(pg.frameMeta())
			pg.b.m.emit(Event{Kind: EvFrame, Tab: pg.tab, Data: data, Info: meta})
		}
	}
	pg.emitState()
	return pg.startScreencast(ctx)
}

func (pg *page) frameMeta() map[string]any {
	w, h, _ := pg.effective()
	return map[string]any{"deviceWidth": w, "deviceHeight": h, "pageScaleFactor": 1, "offsetTop": 0}
}

func (pg *page) startScreencast(ctx context.Context) error {
	w, h, dpr := pg.effective()
	pg.mu.Lock()
	q := pg.quality
	pg.mu.Unlock()
	if q == 0 {
		q = QualityMax
	}
	params := map[string]any{"format": "jpeg", "quality": q, "everyNthFrame": 1}
	if w > 0 && h > 0 {
		params["maxWidth"] = int(math.Round(float64(w) * dpr))
		params["maxHeight"] = int(math.Round(float64(h) * dpr))
	}
	_, err := pg.call(ctx, "Page.startScreencast", params)
	return err
}

// setQuality 는 screencast 품질을 바꾼다. 보고 있으면 새 품질로 다시 켠다 (FR-BRT-95).
func (pg *page) setQuality(ctx context.Context, q int) error {
	q = clampQuality(q)
	pg.mu.Lock()
	same, watching := pg.quality == q, pg.watching
	pg.quality = q
	pg.mu.Unlock()
	if same || !watching {
		return nil
	}
	pg.call(ctx, "Page.stopScreencast", nil)
	return pg.startScreencast(ctx)
}

// effective 는 지금 적용할 CSS 폭·높이·DPR 이다. 확대는 CSS 뷰포트를 `1/z` 로
// 줄이고 DPR 을 `z` 배로 올린다 (FR-BRT-57).
func (pg *page) effective() (int, int, float64) {
	pg.mu.Lock()
	defer pg.mu.Unlock()
	v := pg.vp
	if pg.fixed != nil {
		v = *pg.fixed
	}
	if v.DPR <= 0 {
		v.DPR = 1
	}
	z := pg.zoom
	if z <= 0 {
		z = 1
	}
	return int(math.Round(float64(v.W) / z)), int(math.Round(float64(v.H) / z)), v.DPR * z
}

func (pg *page) applyMetrics(ctx context.Context) error {
	w, h, dpr := pg.effective()
	if w <= 0 || h <= 0 {
		return nil
	}
	_, err := pg.call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width": w, "height": h, "deviceScaleFactor": dpr, "mobile": false})
	if err != nil {
		return err
	}
	pg.mu.Lock()
	watching := pg.watching
	pg.mu.Unlock()
	if watching {
		// 크기가 바뀌면 screencast 의 상한도 바꾼다 — 그대로 두면 옛 크기로 줄여 보낸다.
		pg.call(ctx, "Page.stopScreencast", nil)
		return pg.startScreencast(ctx)
	}
	return nil
}

// setViewport 는 창 주인의 크기(FR-BRT-51) 또는 고정 크기(FR-BRT-52)다.
// fixed 가 참이면 고정, 거짓이면 고정을 푼다(auto), 없으면 주인의 크기다.
func (pg *page) setViewport(ctx context.Context, v viewport, fixed *bool) error {
	pg.mu.Lock()
	switch {
	case fixed != nil && *fixed:
		if v.DPR <= 0 {
			v.DPR = 1
		}
		pg.fixed = &v
		pg.st.Viewport = &Size{W: v.W, H: v.H}
	case fixed != nil:
		pg.fixed = nil
		pg.st.Viewport = nil
	default:
		if v.W <= 0 || v.H <= 0 {
			pg.mu.Unlock()
			return errors.New("뷰포트 크기가 없습니다")
		}
		same := pg.vp == v
		pg.vp = v
		if same || pg.fixed != nil {
			pg.mu.Unlock()
			return nil
		}
	}
	pg.mu.Unlock()
	if fixed != nil {
		pg.emitState()
	}
	return pg.applyMetrics(ctx)
}

// setZoom 은 탭의 확대다 (FR-BRT-57). 0.25~5 로 자른다.
func (pg *page) setZoom(ctx context.Context, z float64) error {
	if z <= 0 {
		z = 1
	}
	z = math.Max(0.25, math.Min(5, z))
	pg.mu.Lock()
	pg.zoom = z
	pg.mu.Unlock()
	if err := pg.applyMetrics(ctx); err != nil {
		return err
	}
	pg.emitState()
	return nil
}

// enqueueInput 은 입력을 줄에 세우고 곧바로 돌아온다. 데몬은 입력을 읽기 루프 안에서
// 부르므로 순서가 지켜지고, 느린 렌더러가 다른 탭의 조작을 막지 않는다.
func (pg *page) enqueueInput(params json.RawMessage) error {
	pg.inOnce.Do(func() {
		pg.inq = make(chan json.RawMessage, 512)
		go pg.inputLoop()
	})
	select {
	case pg.inq <- params:
		return nil
	default:
		return errors.New("입력이 밀렸습니다 — 페이지가 답하지 않습니다")
	}
}

func (pg *page) inputLoop() {
	for {
		select {
		case p := <-pg.inq:
			// 답하지 않는 입력 하나가 줄 전체를 영원히 막지 않는다 — 렌더러가 이동 중이면
			// Chrome 은 입력의 답을 미룬다.
			ctx, cancel := context.WithTimeout(context.Background(), inputTimeout)
			pg.input(ctx, p)
			cancel()
		case <-pg.gone:
			return
		}
	}
}

// inputTimeout 은 입력 하나의 상한이다.
const inputTimeout = 5 * time.Second

func (pg *page) markGone() { pg.goneOnce.Do(func() { close(pg.gone) }) }

// input 은 뷰어의 입력 하나다 (FR-BRT-53~55).
func (pg *page) input(ctx context.Context, params json.RawMessage) error {
	var head struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(params, &head); err != nil {
		return err
	}
	switch head.T {
	case "mouse":
		var p struct {
			Type       string  `json:"type"`
			X          float64 `json:"x"`
			Y          float64 `json:"y"`
			Button     string  `json:"button"`
			Buttons    int     `json:"buttons"`
			ClickCount int     `json:"clickCount"`
			Mods       int     `json:"mods"`
		}
		json.Unmarshal(params, &p)
		if p.Type == "mousePressed" {
			pg.mu.Lock()
			pg.lastMods, pg.lastButton, pg.lastPress = p.Mods, p.Button, time.Now()
			pg.mu.Unlock()
		}
		if p.Button == "" {
			p.Button = "none"
		}
		_, err := pg.call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": p.Type, "x": p.X, "y": p.Y, "button": p.Button, "buttons": p.Buttons,
			"clickCount": p.ClickCount, "modifiers": p.Mods})
		return err
	case "wheel":
		var p struct {
			X    float64 `json:"x"`
			Y    float64 `json:"y"`
			DX   float64 `json:"dx"`
			DY   float64 `json:"dy"`
			Mods int     `json:"mods"`
		}
		json.Unmarshal(params, &p)
		_, err := pg.call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseWheel", "x": p.X, "y": p.Y, "deltaX": p.DX, "deltaY": p.DY, "modifiers": p.Mods})
		return err
	case "key":
		var k KeyInput
		json.Unmarshal(params, &k)
		_, err := pg.call(ctx, "Input.dispatchKeyEvent", translateKey(k, pg.serverMac()))
		return err
	case "ime":
		var p struct {
			Text string `json:"text"`
		}
		json.Unmarshal(params, &p)
		n := len([]rune(p.Text))
		_, err := pg.call(ctx, "Input.imeSetComposition", map[string]any{
			"text": p.Text, "selectionStart": n, "selectionEnd": n})
		return err
	case "insert":
		var p struct {
			Text string `json:"text"`
		}
		json.Unmarshal(params, &p)
		_, err := pg.call(ctx, "Input.insertText", map[string]any{"text": p.Text})
		return err
	}
	return errors.New("모르는 입력입니다: " + head.T)
}

func (pg *page) serverMac() bool {
	e := pg.b.m.cfg.Engine
	return e != nil && e.ModIsMeta()
}
