package browser

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/cdp"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

// profileBrowser 는 프로필 하나를 쓰는 Chrome 프로세스 하나다 (FR-BRT-16).
type profileBrowser struct {
	m       *Manager
	profile string

	ready    chan struct{}
	startErr error

	proc *platform.PipedProcess
	mux  *cdp.Mux
	cl   *cdp.Client

	// events 는 읽기 고루틴에서 매니저 작업자로 넘기는 줄이다. 읽기 고루틴 안에서
	// Chrome 에 묻고 답을 기다리면 그 답을 읽을 고루틴이 없다.
	events chan *cdp.Message
	exited chan struct{}

	mu       sync.Mutex
	pages    map[string]*page // targetId → 페이지
	sessions map[string]*page // sessionId → 페이지
	// own 은 매니저가 만들고 있는 target 이다 — 그 페이지는 외부의 것이 아니다.
	own map[string]*page
	// audioExt 는 소리 확장이 실렸는가, audioSess 는 그 offscreen 문서의 세션이다 (FR-BRT-91).
	audioExt  bool
	audioSess string
	// unclaimed 는 주인을 아직 모르는 page target 이다 (targetId → sessionId).
	unclaimed map[string]string
	// contexts 는 임시 컨텍스트 → 그 안의 페이지 수다 (FR-BRT-15).
	contexts map[string]int
	// opens 는 페이지가 연 `window.open` 의 기능 문자열이다 — 팝업 판정 (FR-BRT-42).
	opens map[string]windowOpen
	// dl 은 다운로드 기록이다 (FR-BRT-80). devtools 는 DevTools target → 대상 페이지다.
	// dlDir 은 받는 중인 다운로드의 대기 폴더다 (FR-BRT-80).
	dlDir    string
	devtools map[string]*page
	// foreign 은 외부 도구가 만든 target → 그 연결의 도구 id 다 (FR-BRT-44).
	foreign map[string]string
	// frames 는 교차 출처 iframe 의 세션이다 (세션 → 프레임).
	frames map[string]*frameSession
	// defaultCtx 는 기본 컨텍스트의 id 다. 그 밖의 컨텍스트는 임시다.
	defaultCtx string
	planned    bool
}

type windowOpen struct {
	features []string
	at       time.Time
}

func newProfileBrowser(m *Manager, profile string) *profileBrowser {
	return &profileBrowser{m: m, profile: profile, ready: make(chan struct{}), exited: make(chan struct{}),
		events: make(chan *cdp.Message, 4096), pages: map[string]*page{}, sessions: map[string]*page{},
		own: map[string]*page{}, unclaimed: map[string]string{}, contexts: map[string]int{}, opens: map[string]windowOpen{},
		frames: map[string]*frameSession{}, foreign: map[string]string{}, devtools: map[string]*page{}}
}

// start 는 Chrome 을 띄우고 CDP 를 세운다. 끝나면 ready 를 닫는다.
func (b *profileBrowser) start() {
	defer close(b.ready)
	eng := b.m.cfg.Engine
	if eng == nil {
		b.startErr = errors.New(platform.ErrChromeNotFound.Error())
		close(b.exited)
		return
	}
	path, err := eng.Find()
	if err != nil {
		b.startErr = engineError(platform.ErrChromeNotFound.Error(), eng.InstallHint())
		close(b.exited)
		return
	}
	if b.m.cfg.Euid() == 0 {
		b.startErr = ErrRoot
		close(b.exited)
		return
	}
	if err := b.m.ensureProfileDir(b.profile); err != nil {
		b.startErr = err
		close(b.exited)
		return
	}
	audio := AudioOff
	if b.m.cfg.Audio != nil {
		audio = b.m.cfg.Audio()
	}
	dir := filepath.Join(b.m.profilesDir(), b.profile)
	if b.m.cfg.Proc != nil {
		reapStaleSingleton(dir, b.m.cfg.Proc)
	}
	proc, err := eng.StartPiped(platform.PipedSpec{Path: path, Args: launchArgs(dir, audio)})
	if err != nil {
		b.startErr = engineError("Chrome 을 띄우지 못했습니다: "+err.Error(), "")
		close(b.exited)
		return
	}
	b.proc = proc
	b.mux = cdp.NewMux(proc.ToChild)
	b.cl = cdp.NewClient(b.mux, b.onMessage)
	go b.mux.Run(proc.FromChild)
	go b.work()
	go func() {
		proc.Wait()
		proc.FromChild.Close()
		close(b.exited)
	}()
	go func() {
		<-b.exited
		b.mu.Lock()
		planned := b.planned
		b.mu.Unlock()
		b.m.browserGone(b, planned)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), b.m.cfg.VersionTimeout)
	defer cancel()
	res, err := b.cl.Call(ctx, "", "Browser.getVersion", nil)
	if err != nil {
		b.kill()
		// FR-BRT-6: 원인을 단정하지 않는다 — 정책 차단이 흔한 후보다.
		b.startErr = engineError("Chrome 이 원격 제어에 답하지 않습니다",
			"회사 관리 정책(RemoteDebuggingAllowed·HeadlessMode)이 막고 있을 수 있습니다")
		return
	}
	var v struct {
		Product string `json:"product"`
	}
	json.Unmarshal(res, &v)
	if major := parseMajor(v.Product); major < MinChromeMajor {
		b.kill()
		b.startErr = engineError("Chrome 업데이트가 필요합니다 (135 이상)", eng.InstallHint())
		return
	}
	bg := context.Background()
	if _, err := b.cl.Call(bg, "", "Target.setDiscoverTargets", map[string]any{"discover": true}); err != nil {
		b.kill()
		b.startErr = engineError("Chrome 을 준비하지 못했습니다: "+err.Error(), "")
		return
	}
	if res, err := b.cl.Call(bg, "", "Target.getBrowserContexts", nil); err == nil {
		var bc struct {
			DefaultBrowserContextID string `json:"defaultBrowserContextId"`
		}
		json.Unmarshal(res, &bc)
		b.mu.Lock()
		b.defaultCtx = bc.DefaultBrowserContextID
		b.mu.Unlock()
	}
	// 새 페이지는 멈춘 채로 붙는다 — 스크립트를 심은 뒤 풀어야 첫 문서에도 닿는다.
	if _, err := b.cl.Call(bg, "", "Target.setAutoAttach", map[string]any{
		"autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true}); err != nil {
		b.kill()
		b.startErr = engineError("Chrome 을 준비하지 못했습니다: "+err.Error(), "")
		return
	}
	// FR-BRT-80: 다운로드는 서버에만. 받는 동안은 프로필 안의 대기 폴더에 guid 로 두고,
	// 끝나면 그때의 다운로드 폴더 설정으로 제안된 이름을 달아 옮긴다.
	b.dlDir = filepath.Join(dir, downloadStaging)
	os.MkdirAll(b.dlDir, 0o700)
	b.cl.Call(bg, "", "Browser.setDownloadBehavior", map[string]any{"behavior": "allowAndName",
		"downloadPath": b.dlDir, "eventsEnabled": true})
	if audio == AudioViewer {
		b.loadAudioExt(bg)
	}
	dmlog.Infof(nil, "[browser] 프로필 %s 브라우저 기동 pid=%d %s", b.profile, proc.Pid, v.Product)
}

func (b *profileBrowser) kill() {
	b.mu.Lock()
	b.planned = true
	b.mu.Unlock()
	if b.proc != nil {
		b.proc.Kill()
	}
}

func (b *profileBrowser) waitExit(d time.Duration) {
	select {
	case <-b.exited:
	case <-time.After(d):
	}
}

// onMessage 는 읽기 고루틴에서 불린다. 프레임은 여기서 바로 내보낸다 — 줄에 세우면
// 느린 작업 뒤에 밀린다. 나머지는 작업자에게 넘긴다.
func (b *profileBrowser) onMessage(msg *cdp.Message) {
	if cdp.IsClosed(msg) {
		return
	}
	if msg.Method == "Page.screencastFrame" {
		b.onFrame(msg)
		return
	}
	if msg.Method == "Fetch.requestPaused" {
		// 줄에 세우지 않는다 — 페이지의 모든 요청이 이것을 기다린다.
		var p struct {
			RequestID string `json:"requestId"`
		}
		json.Unmarshal(msg.Params, &p)
		b.cl.Fire(msg.SessionID, "Fetch.continueRequest", map[string]any{"requestId": p.RequestID})
		return
	}
	select {
	case b.events <- msg:
	default:
		dmlog.Infof(nil, "[browser] 이벤트 줄이 가득 차 %s 를 버린다", msg.Method)
	}
}

func (b *profileBrowser) work() {
	for {
		select {
		case msg := <-b.events:
			b.handle(msg)
		case <-b.exited:
			return
		}
	}
}

type targetInfo struct {
	TargetID         string `json:"targetId"`
	Type             string `json:"type"`
	ParentID         string `json:"parentId"`
	Title            string `json:"title"`
	URL              string `json:"url"`
	OpenerID         string `json:"openerId"`
	BrowserContextID string `json:"browserContextId"`
}

func (b *profileBrowser) handle(msg *cdp.Message) {
	switch msg.Method {
	case "Target.attachedToTarget":
		var p struct {
			SessionID          string     `json:"sessionId"`
			TargetInfo         targetInfo `json:"targetInfo"`
			WaitingForDebugger bool       `json:"waitingForDebugger"`
		}
		json.Unmarshal(msg.Params, &p)
		if msg.SessionID != "" {
			b.onChildAttached(msg.SessionID, p.SessionID, p.TargetInfo, p.WaitingForDebugger)
			return
		}
		b.onAttached(p.SessionID, p.TargetInfo, p.WaitingForDebugger)
	case "Target.targetInfoChanged":
		var p struct {
			TargetInfo targetInfo `json:"targetInfo"`
		}
		json.Unmarshal(msg.Params, &p)
		if pg := b.byTarget(p.TargetInfo.TargetID); pg != nil {
			pg.onInfo(p.TargetInfo)
		}
	case "Browser.downloadWillBegin", "Browser.downloadProgress":
		b.onDownload(msg.Method, msg.Params)
	case "Target.detachedFromTarget":
		var p struct {
			SessionID string `json:"sessionId"`
		}
		json.Unmarshal(msg.Params, &p)
		b.mu.Lock()
		delete(b.frames, p.SessionID)
		b.mu.Unlock()
	case "Target.targetDestroyed":
		var p struct {
			TargetID string `json:"targetId"`
		}
		json.Unmarshal(msg.Params, &p)
		b.onDestroyed(p.TargetID)
	default:
		if msg.SessionID == "" {
			return
		}
		b.mu.Lock()
		pg := b.sessions[msg.SessionID]
		b.mu.Unlock()
		if pg != nil {
			pg.onEvent(msg)
		}
	}
}

// recentModClicker 는 그 컨텍스트에서 방금 수정키·가운데 버튼으로 누른 페이지다.
func (b *profileBrowser) recentModClicker(ctxID string) *page {
	b.mu.Lock()
	pages := make([]*page, 0, len(b.pages))
	for _, pg := range b.pages {
		// 기본 컨텍스트의 페이지는 context 를 비워 둔다.
		if pg.context == ctxID || (pg.context == "" && ctxID == b.defaultCtx) {
			pages = append(pages, pg)
		}
	}
	b.mu.Unlock()
	for _, pg := range pages {
		if pg.backgroundOpen() {
			return pg
		}
	}
	return nil
}

func (b *profileBrowser) byTarget(id string) *page {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.pages[id]
}

// onAttached 는 새로 붙은 target 하나를 다룬다. page 가 아니면 풀어 주기만 한다.
func (b *profileBrowser) onAttached(session string, ti targetInfo, waiting bool) {
	// DevTools 페이지는 Chrome 153 에서 type "other" 로 온다(실측) — 페이지로 다룬다.
	if ti.Type == "other" && strings.HasPrefix(ti.URL, "devtools://") {
		ti.Type = "page"
	}
	if ti.Type != "page" {
		if waiting {
			b.cl.Fire(session, "Runtime.runIfWaitingForDebugger", nil)
		}
		return
	}
	setupSession(b.cl, session, waiting)
	// 주인 판정과 "모름" 기록을 한 잠금 안에서 한다 — 사이에 openPage 가 끼면 둘 다
	// 상대가 적어 두기를 기다리며 페이지를 놓친다.
	b.mu.Lock()
	pg := b.own[ti.TargetID]
	if pg == nil && ti.OpenerID == "" {
		b.unclaimed[ti.TargetID] = session
	}
	b.mu.Unlock()
	if pg != nil {
		b.mu.Lock()
		if !pg.isolated && b.defaultCtx == "" {
			b.defaultCtx = ti.BrowserContextID
		}
		b.mu.Unlock()
		b.bind(pg, session)
		return
	}
	// 수정키·가운데 클릭으로 연 탭에는 Chrome 이 opener 를 싣지 않는다(실측) — 같은 컨텍스트에서
	// 방금 그렇게 누른 페이지가 연 것으로 본다 (FR-BRT-33).
	if ti.OpenerID == "" {
		if o := b.recentModClicker(ti.BrowserContextID); o != nil {
			ti.OpenerID = o.target
		}
	}
	if ti.OpenerID != "" {
		b.adoptOpened(session, ti)
		return
	}
	// 주인을 모른다 — 매니저의 createTarget 응답이 아직 안 왔거나, 외부 도구의 것이다.
	time.AfterFunc(b.m.cfg.ClaimWait, func() { b.adoptForeign(ti) })
}

// setupSession 은 페이지 세션 하나를 준비하고 풀어 준다 — 격리 world 의
// `base-select`(FR-BRT-60)와 충돌 감지.
//
// `Emulation.setFocusEmulationEnabled` 는 쓰지 않는다 — Chrome 153 에서 교차 프로세스
// 이동 때 렌더러가 죽는다(실측, `Inspector.targetCrashed`).
//
// **답을 기다리지 않고 순서대로 흘려보낸다.** 멈춘 채 붙은 페이지는 `Page.enable`
// 에도 답하지 않으므로, 기다리면 풀어 줄 차례가 오지 않는다. 한 세션의 요청은
// Chrome 이 받은 순서대로 처리하므로 스크립트는 풀리기 전에 심긴다.
func setupSession(cl *cdp.Client, session string, waiting bool) {
	cl.Fire(session, "Page.enable", nil)
	// 3단계 보고자의 통로는 스크립트보다 먼저 선다 — 격리 world 에서만 보인다 (NFR-BRT-S2).
	cl.Fire(session, "Runtime.addBinding", map[string]any{"name": reportBinding, "executionContextName": isolatedWorld})
	cl.Fire(session, "Page.addScriptToEvaluateOnNewDocument", map[string]any{
		"source": baseSelectScript, "worldName": isolatedWorld, "runImmediately": true})
	cl.Fire(session, "Page.addScriptToEvaluateOnNewDocument", map[string]any{
		"source": agentScript, "worldName": isolatedWorld, "runImmediately": true})
	// FR-BRT-81: 파일 선택은 서버 파일 선택 창으로 받는다.
	cl.Fire(session, "Page.setInterceptFileChooserDialog", map[string]any{"enabled": true})
	// FR-BRT-86: HTTP 인증을 받는다. 인증만 받는 구성은 없다 — 빈 patterns 는 인증도 오지
	// 않는다(실측). 모든 요청이 멈추고 읽기 고루틴이 곧바로 풀어 준다(요청당 약 0.3ms, 실측).
	cl.Fire(session, "Fetch.enable", map[string]any{"handleAuthRequests": true,
		"patterns": []map[string]any{{"urlPattern": "*"}}})
	cl.Fire(session, "Inspector.enable", nil)
	// 2단계 기록(console·network)과 교차 출처 iframe 의 세션 (FR-BRT-75·76).
	cl.Fire(session, "Runtime.enable", nil)
	cl.Fire(session, "Network.enable", nil)
	cl.Fire(session, "Target.setAutoAttach", map[string]any{"autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true})
	if waiting {
		cl.Fire(session, "Runtime.runIfWaitingForDebugger", nil)
	}
}

func (b *profileBrowser) bind(pg *page, session string) {
	b.mu.Lock()
	pg.session = session
	b.sessions[session] = pg
	b.mu.Unlock()
	select {
	case <-pg.attached:
	default:
		close(pg.attached)
	}
}

// adoptOpened 는 페이지가 연 페이지를 탭으로 만든다 (FR-BRT-33).
func (b *profileBrowser) adoptOpened(session string, ti targetInfo) {
	opener := b.byTarget(ti.OpenerID)
	pg := b.newPage(newTabID(), ti.TargetID, ti.BrowserContextID)
	c := Created{URL: ti.URL, Profile: b.profile}
	if opener != nil {
		c.Opener = opener.tab
		pg.isolated = opener.isolated
		c.Isolated = opener.isolated
		c.Background = opener.backgroundOpen()
		c.Tool = opener.tool
		pg.tool = opener.tool
	}
	b.mu.Lock()
	if wo, ok := b.opens[ti.URL]; ok && time.Since(wo.at) < 5*time.Second {
		c.Popup = hasSizeFeature(wo.features)
		delete(b.opens, ti.URL)
	}
	b.mu.Unlock()
	pg.popup = c.Popup
	pg.st.URL = ti.URL
	b.register(pg)
	b.bind(pg, session)
	b.m.emitInfo(EvCreated, pg.tab, c)
}

// adoptForeign 은 주인을 끝내 찾지 못한 페이지를 외부 도구의 것으로 탭으로 만든다
// (FR-BRT-44). 그 사이 매니저가 제 것으로 가져갔으면 아무것도 하지 않는다.
func (b *profileBrowser) adoptForeign(ti targetInfo) {
	b.mu.Lock()
	session, ok := b.unclaimed[ti.TargetID]
	delete(b.unclaimed, ti.TargetID)
	_, known := b.pages[ti.TargetID]
	b.mu.Unlock()
	if !ok || known {
		return
	}
	b.mu.Lock()
	tool := b.foreign[ti.TargetID]
	delete(b.foreign, ti.TargetID)
	b.mu.Unlock()
	if ti.BrowserContextID == "" || ti.URL == "" {
		// 도구가 알려 온 경우다 — 붙을 때 받은 정보를 다시 묻는다.
		if res, err := b.cl.Call(context.Background(), "", "Target.getTargetInfo", map[string]any{"targetId": ti.TargetID}); err == nil {
			var r struct {
				TargetInfo targetInfo `json:"targetInfo"`
			}
			json.Unmarshal(res, &r)
			ti = r.TargetInfo
		}
	}
	b.mu.Lock()
	of := b.devtools[ti.TargetID]
	delete(b.devtools, ti.TargetID)
	b.mu.Unlock()
	if of == nil && strings.HasPrefix(ti.URL, "devtools://") {
		// DevTools 페이지는 FR-BRT-84 의 길로만 탭이 된다 (FR-BRT-31).
		return
	}
	pg := b.newPage(newTabID(), ti.TargetID, ti.BrowserContextID)
	pg.st.URL = ti.URL
	pg.isolated = b.isTempContext(ti.BrowserContextID)
	pg.tool = tool
	if of != nil {
		pg.devtoolsOf = of.tab
		of.mu.Lock()
		title := of.st.Title
		of.mu.Unlock()
		pg.st.Title = "DevTools · " + title
		b.register(pg)
		b.bind(pg, session)
		b.m.emitInfo(EvCreated, pg.tab, Created{URL: ti.URL, Profile: b.profile, Opener: of.tab, DevtoolsOf: of.tab,
			Name: pg.st.Title, Tool: of.tool})
		return
	}
	b.register(pg)
	b.bind(pg, session)
	b.m.emitInfo(EvCreated, pg.tab, Created{URL: ti.URL, Profile: b.profile, Isolated: pg.isolated, Background: true, Tool: tool})
}

func (b *profileBrowser) isTempContext(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.defaultCtx != "" && id != b.defaultCtx
}

func hasSizeFeature(fs []string) bool {
	for _, f := range fs {
		if len(f) > 6 && (f[:6] == "width=" || f[:7] == "height=") {
			return true
		}
	}
	return false
}

func (b *profileBrowser) newPage(tab, target, context string) *page {
	return &page{b: b, tab: tab, target: target, profile: b.profile, context: context, zoom: 1,
		attached: make(chan struct{}), gone: make(chan struct{})}
}

// register 는 페이지를 매니저와 브라우저 양쪽에 적는다.
func (b *profileBrowser) register(pg *page) {
	b.mu.Lock()
	b.pages[pg.target] = pg
	if pg.context != "" {
		if _, ok := b.contexts[pg.context]; ok {
			b.contexts[pg.context]++
		}
	}
	b.mu.Unlock()
	b.m.mu.Lock()
	b.m.tabs[pg.tab] = pg
	b.m.mu.Unlock()
}

// openPage 는 매니저가 탭 하나의 페이지를 만든다. 빈 페이지로 만들고, 세션을 준비한
// 뒤 이동한다 — 그래야 격리 world 의 스크립트가 첫 문서에도 닿는다.
func (b *profileBrowser) openPage(ctx context.Context, r OpenReq) error {
	params := map[string]any{"url": "about:blank"}
	contextID := ""
	if r.Isolated {
		res, err := b.cl.Call(ctx, "", "Target.createBrowserContext", map[string]any{"disposeOnDetach": false})
		if err != nil {
			return err
		}
		var c struct {
			BrowserContextID string `json:"browserContextId"`
		}
		json.Unmarshal(res, &c)
		contextID = c.BrowserContextID
		b.mu.Lock()
		b.contexts[contextID] = 0
		b.mu.Unlock()
		params["browserContextId"] = contextID
	}
	res, err := b.cl.Call(ctx, "", "Target.createTarget", params)
	if err != nil {
		return err
	}
	var t struct {
		TargetID string `json:"targetId"`
	}
	json.Unmarshal(res, &t)
	pg := b.newPage(r.Tab, t.TargetID, contextID)
	pg.isolated = r.Isolated
	pg.st.URL = r.URL
	if r.Viewport != nil && r.Viewport.W > 0 && r.Viewport.H > 0 {
		pg.fixed = &viewport{W: r.Viewport.W, H: r.Viewport.H, DPR: 1}
		pg.st.Viewport = r.Viewport
	}
	b.mu.Lock()
	b.own[t.TargetID] = pg
	session, early := b.unclaimed[t.TargetID]
	delete(b.unclaimed, t.TargetID)
	b.mu.Unlock()
	b.register(pg)
	if early {
		b.bind(pg, session)
	}
	select {
	case <-pg.attached:
	case <-time.After(10 * time.Second):
		return errors.New("새 페이지에 붙지 못했습니다")
	case <-ctx.Done():
		return ctx.Err()
	}
	b.mu.Lock()
	delete(b.own, t.TargetID)
	needCtx := !r.Isolated && b.defaultCtx == ""
	b.mu.Unlock()
	// 기본 컨텍스트의 id 를 적어 둔다 — 그 밖의 컨텍스트가 임시다 (외부 도구의 새 컨텍스트).
	if needCtx {
		if res, err := b.cl.Call(ctx, "", "Target.getTargetInfo", map[string]any{"targetId": t.TargetID}); err == nil {
			var ti struct {
				TargetInfo targetInfo `json:"targetInfo"`
			}
			json.Unmarshal(res, &ti)
			b.mu.Lock()
			if b.defaultCtx == "" {
				b.defaultCtx = ti.TargetInfo.BrowserContextID
			}
			b.mu.Unlock()
		}
	}
	// 준비 요청들의 답을 한 번 기다린다 — 풀린 직후 곧바로 교차 프로세스 이동을
	// 걸면 새 렌더러에서 Page 이벤트(frameNavigated·load)가 오지 않는다(실측).
	if _, err := b.cl.Call(ctx, pg.session, "Page.getFrameTree", nil); err != nil {
		return err
	}
	if r.Viewport != nil {
		pg.applyMetrics(ctx)
	}
	if r.URL != "about:blank" {
		_, err = b.cl.Call(ctx, pg.session, "Page.navigate", map[string]any{"url": r.URL})
	}
	return err
}

// onDestroyed 는 페이지가 사라진 것을 다룬다. 탭이 닫은 것이 아니면 탭을 닫게 한다.
func (b *profileBrowser) onDestroyed(target string) {
	pg := b.byTarget(target)
	if pg == nil {
		return
	}
	b.closeDevToolsOf(pg)
	b.forget(pg)
	b.m.mu.Lock()
	cur := b.m.tabs[pg.tab]
	if cur == pg {
		delete(b.m.tabs, pg.tab)
	}
	b.m.mu.Unlock()
	if cur == pg {
		b.m.emit(Event{Kind: EvClosed, Tab: pg.tab})
	}
	b.afterPageGone(pg)
}

// forget 은 브라우저 쪽 기록에서 페이지를 뺀다.
func (b *profileBrowser) forget(pg *page) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.pages[pg.target] != pg {
		return
	}
	pg.markGone()
	delete(b.pages, pg.target)
	delete(b.sessions, pg.session)
	if pg.context != "" {
		if n, ok := b.contexts[pg.context]; ok {
			b.contexts[pg.context] = n - 1
		}
	}
}

// afterPageGone 은 임시 컨텍스트와 브라우저 자체의 수명을 정리한다 (FR-BRT-7·15).
func (b *profileBrowser) afterPageGone(pg *page) {
	bg := context.Background()
	b.mu.Lock()
	disposeCtx := ""
	if pg.context != "" {
		if n, ok := b.contexts[pg.context]; ok && n <= 0 {
			delete(b.contexts, pg.context)
			disposeCtx = pg.context
		}
	}
	empty := len(b.pages) == 0 && len(b.own) == 0
	b.mu.Unlock()
	if disposeCtx != "" {
		b.cl.Call(bg, "", "Target.disposeBrowserContext", map[string]any{"browserContextId": disposeCtx})
	}
	if empty {
		b.m.mu.Lock()
		if b.m.browsers[b.profile] == b {
			delete(b.m.browsers, b.profile)
		}
		if b.m.closing == nil {
			b.m.closing = map[*profileBrowser]struct{}{}
		}
		b.m.closing[b] = struct{}{}
		b.m.mu.Unlock()
		b.mu.Lock()
		b.planned = true
		b.mu.Unlock()
		ctx, cancel := context.WithTimeout(bg, 2*time.Second)
		b.cl.Call(ctx, "", "Browser.close", nil)
		cancel()
		go func() {
			b.waitExit(5 * time.Second)
			b.kill()
		}()
	}
}

// procKiller 는 거둘 프로세스를 보고 끝내는 능력이다 (`platform.Process` 의 일부).
type procKiller interface {
	Alive(pid int) bool
	Kill(pid int) error
}

// reapStaleSingleton 은 그 프로필 폴더를 잠근 채 남은 Chrome 을 끝낸다 (FR-BRT-7).
//
// 정상 종료에서는 pipe 가 닫히면 Chrome 도 끝난다(실측). 데몬이 강제로 끝나면 남는
// 일이 있었고(실측), 남은 Chrome 은 `SingletonLock` 으로 프로필을 쥐어 새 기동을 막는다.
// 프로필 폴더는 dongminal 전용이므로(§2.3) 그 잠금의 주인은 우리가 띄운 것이다.
// Windows 는 잠금이 링크가 아니고 Job Object 가 이미 거두므로 여기서 할 일이 없다.
func reapStaleSingleton(dir string, p procKiller) {
	target, err := os.Readlink(filepath.Join(dir, "SingletonLock"))
	if err != nil {
		return
	}
	i := strings.LastIndexByte(target, '-')
	if i < 0 {
		return
	}
	pid, err := strconv.Atoi(target[i+1:])
	if err != nil || pid <= 0 || !p.Alive(pid) {
		return
	}
	dmlog.Infof(nil, "[browser] 프로필을 잠근 채 남은 Chrome 을 거둔다 pid=%d", pid)
	p.Kill(pid)
	for n := 0; n < 50 && p.Alive(pid); n++ {
		time.Sleep(50 * time.Millisecond)
	}
}

// frameSession 은 교차 출처 iframe 하나의 세션이다. 부모는 페이지이거나 다른 iframe 이다.
type frameSession struct {
	session       string
	target        string
	url           string
	parentSession string
	page          *page
}

// onChildAttached 는 페이지(또는 iframe) 세션 아래 자동 부착된 target 이다 — 교차 출처
// iframe 이면 적어 두고, 무엇이든 풀어 준다.
func (b *profileBrowser) onChildAttached(parent, session string, ti targetInfo, waiting bool) {
	if ti.Type == "iframe" {
		b.mu.Lock()
		pg := b.sessions[parent]
		if pg == nil {
			if f := b.frames[parent]; f != nil {
				pg = f.page
			}
		}
		if pg != nil {
			b.frames[session] = &frameSession{session: session, target: ti.TargetID, url: ti.URL, parentSession: parent, page: pg}
		}
		b.mu.Unlock()
		b.cl.Fire(session, "Target.setAutoAttach", map[string]any{"autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true})
	}
	if waiting {
		b.cl.Fire(session, "Runtime.runIfWaitingForDebugger", nil)
	}
}

// framesOf 는 그 페이지의 교차 출처 iframe 세션들이다.
func (b *profileBrowser) framesOf(pg *page) []*frameSession {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []*frameSession
	for _, f := range b.frames {
		if f.page == pg {
			out = append(out, f)
		}
	}
	return out
}

// frameOwner 는 iframe 세션의 <iframe> 요소(부모 세션의 backendNodeId)다.
func (pg *page) frameOwner(ctx context.Context, f *frameSession) (int, error) {
	res, err := pg.b.cl.Call(ctx, f.parentSession, "DOM.getFrameOwner", map[string]any{"frameId": f.target})
	if err != nil {
		return 0, err
	}
	var r struct {
		BackendNodeID int `json:"backendNodeId"`
	}
	json.Unmarshal(res, &r)
	return r.BackendNodeID, nil
}
