// Package browser 는 브라우저 매니저다 — 프로필 브라우저(서버 기기의 headless
// Chrome)들과 dongminal 탭 ↔ Chrome 페이지 대응을 소유한다 (BROWSER_TAB_SRS §3.1~3.5).
//
// **데몬 모드에서는 데몬이, 직접 모드에서는 웹 서버가 이것을 실행한다** (FR-BRT-8) —
// `toolhub` 와 같은 이중 실행이라 `shared/` 에 산다. 두 자리가 같은 표면을 쓰도록
// 조작은 전부 `Do(op, params)` 하나로 들어오고 소식은 `Event` 하나로 나간다. 그래서
// 데몬 IPC 는 메서드 하나·이벤트 하나로 이 패키지 전체를 나른다.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

// Host 는 웹 서버가 보는 매니저의 표면이다. 직접 모드는 Manager 가, 데몬 모드는 IPC
// 클라이언트가 이것을 구현한다 — 두 자리가 같은 표면을 쓴다 (FR-BRT-8).
type Host interface {
	// Call 은 조작 하나를 부르고 결과의 JSON 을 낸다.
	Call(ctx context.Context, op string, params any) (json.RawMessage, error)
	// SetSink 는 소식을 받을 곳을 건다.
	SetSink(func(Event))
}

// Event 는 매니저가 내는 소식 하나다.
//
//	frame   Data = JPEG, Info = 프레임 메타데이터
//	state   Info = TabState
//	closed  페이지가 닫혔다 — 탭을 닫는다 (FR-BRT-37)
//	created Info = Created — 페이지가 연 페이지·외부 도구의 페이지 (FR-BRT-33·44)
type Event struct {
	Kind string          `json:"kind"`
	Tab  string          `json:"tab,omitempty"`
	Data []byte          `json:"data,omitempty"`
	Info json.RawMessage `json:"info,omitempty"`
}

// 이벤트 종류.
const (
	EvFrame   = "frame"
	EvState   = "state"
	EvClosed  = "closed"
	EvCreated = "created"
	// EvAct 는 에이전트 조작의 자리다 — 뷰어가 커서와 강조를 잠깐 그린다 (FR-BRT-79).
	EvAct = "act"
)

// TabState 는 탭 하나의 보이는 상태다.
type TabState struct {
	URL        string  `json:"url"`
	Title      string  `json:"title"`
	Loading    bool    `json:"loading"`
	CanBack    bool    `json:"canBack"`
	CanForward bool    `json:"canForward"`
	Crashed    bool    `json:"crashed,omitempty"`
	Zoom       float64 `json:"zoom,omitempty"`
	// Viewport 는 고정 크기다 — null 이면 창 주인의 크기를 따른다 (FR-BRT-52). 화면이 탭 레코드에
	// 적고, 풀면 지운다 — 그래서 null 도 싣는다.
	Viewport *Size `json:"viewport"`
}

// Size 는 고정 뷰포트의 CSS 크기다.
type Size struct {
	W int `json:"w"`
	H int `json:"h"`
}

// Created 는 매니저가 스스로 만든 탭이다 — 배치는 화면이 한다.
type Created struct {
	Opener     string `json:"opener,omitempty"`
	URL        string `json:"url"`
	Profile    string `json:"profile"`
	Isolated   bool   `json:"isolated,omitempty"`
	Background bool   `json:"background,omitempty"`
	Popup      bool   `json:"popup,omitempty"`
	Tool       string `json:"tool,omitempty"`
	// DevtoolsOf 는 DevTools 탭이면 대상 탭이다 (FR-BRT-84). Name 은 탭 이름이다.
	DevtoolsOf string `json:"devtoolsOf,omitempty"`
	Name       string `json:"name,omitempty"`
}

// 오류. 화면과 `dmctl` 이 사용자에게 그대로 보인다.
var (
	ErrNoTab       = errors.New("그 브라우저 탭이 없습니다")
	ErrBadProfile  = errors.New("프로필 이름은 영소문자·숫자로 시작하고 영소문자·숫자·_·- 만 씁니다 (32자 이하)")
	ErrNoProfile   = errors.New("그 프로필이 없습니다")
	ErrDefaultKeep = errors.New("default 프로필은 지울 수 없습니다")
	ErrRoot        = errors.New("root 에서는 브라우저 탭을 쓸 수 없습니다 — Chrome 이 샌드박스 없이 뜨지 않습니다")
)

// MinChromeMajor 는 받는 Chrome 의 최소 주 버전이다 (FR-BRT-3, `base-select`).
const MinChromeMajor = 135

// DefaultProfile 은 언제나 있는 프로필이다 (FR-BRT-11).
const DefaultProfile = "default"

var profileNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// Config 는 매니저의 배선이다.
type Config struct {
	// Home 은 DONGMINAL_HOME 이다. 프로필은 `<Home>/browser/profiles/<이름>/` 다.
	Home   string
	Engine platform.Chrome
	// Audio 는 소리 설정이다 — 프로필 브라우저를 띄울 때 읽는다 (FR-BRT-90·91). nil 이면 끔.
	Audio func() string
	// Euid 는 실행 사용자다. 0 이면 root 로 보고 거절한다 (FR-BRT-4). nil 이면 os.Geteuid.
	Euid func() int
	// VersionTimeout 은 기동 뒤 Browser.getVersion 을 기다리는 상한이다 (FR-BRT-6). 0 이면 15초 —
	// Windows 러너의 첫 기동이 5초를 넘었다(CI 실측).
	VersionTimeout time.Duration
	// ClaimWait 는 주인 모를 페이지를 외부의 것으로 판정하기까지 기다리는 시간이다.
	ClaimWait time.Duration
	// Proc 은 남은 Chrome 을 거둘 때 쓴다 (FR-BRT-7). nil 이면 거두지 않는다.
	Proc procKiller
	// DownloadDir 는 다운로드 폴더다 (FR-BRT-80). nil·빈 값이면 서버 사용자의 ~/Downloads.
	DownloadDir func() string
}

// Manager 는 프로필 브라우저와 탭 대응을 소유한다.
type Manager struct {
	cfg Config
	dls downloads

	mu       sync.Mutex
	sink     func(Event)
	browsers map[string]*profileBrowser // 프로필 → 도는 브라우저
	tabs     map[string]*page           // 탭 uuid → 페이지
	ghosts   map[string]ghost           // 브라우저가 끝나 페이지를 잃은 탭 (FR-BRT-38)
	proxies  map[string]*proxyClient    // CDP 프록시로 붙은 외부 도구 (FR-BRT-22)
	// closing 은 마지막 탭이 닫혀 끝나는 중인 브라우저다 — Close 가 이것도 기다린다.
	closing map[*profileBrowser]struct{}
	closed  bool
}

// ghost 는 다시 만들 수 있는 탭의 기억이다.
type ghost struct {
	url, profile string
	isolated     bool
}

// New 는 매니저를 만든다. 브라우저는 필요해질 때 뜬다 (FR-BRT-7).
func New(cfg Config) *Manager {
	if cfg.VersionTimeout == 0 {
		cfg.VersionTimeout = 15 * time.Second
	}
	if cfg.ClaimWait == 0 {
		cfg.ClaimWait = 1500 * time.Millisecond
	}
	if cfg.Euid == nil {
		cfg.Euid = os.Geteuid
	}
	return &Manager{cfg: cfg, browsers: map[string]*profileBrowser{}, tabs: map[string]*page{}, ghosts: map[string]ghost{}}
}

// SetSink 는 이벤트를 받을 곳을 건다. 이벤트는 매니저의 고루틴에서 불리므로 막지 않는다.
func (m *Manager) SetSink(f func(Event)) {
	m.mu.Lock()
	m.sink = f
	m.mu.Unlock()
}

func (m *Manager) emit(e Event) {
	m.mu.Lock()
	f := m.sink
	m.mu.Unlock()
	if f != nil {
		f(e)
	}
}

func (m *Manager) emitInfo(kind, tab string, info any) {
	b, _ := json.Marshal(info)
	m.emit(Event{Kind: kind, Tab: tab, Info: b})
}

// Close 는 모든 프로필 브라우저를 끝낸다 (데몬 종료).
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	bs := make([]*profileBrowser, 0, len(m.browsers)+len(m.closing))
	for _, b := range m.browsers {
		bs = append(bs, b)
	}
	for b := range m.closing {
		bs = append(bs, b)
	}
	m.mu.Unlock()
	for _, b := range bs {
		b.kill()
	}
	// 끝날 때까지 (상한 두고) 기다린다 — 프로필 폴더에 쓰던 것이 남지 않게.
	for _, b := range bs {
		b.waitExit(5 * time.Second)
	}
}

// ── 프로필 (묶음 P) ──────────────────────────────────────────────

func (m *Manager) profilesDir() string {
	return filepath.Join(m.cfg.Home, dmenv.BrowserDir, "profiles")
}

// Profile 은 프로필 하나의 목록 행이다.
type Profile struct {
	Name    string `json:"name"`
	Running bool   `json:"running"`
	Tabs    int    `json:"tabs"`
}

// Profiles 는 폴더 목록이 곧 프로필 목록이다 (FR-BRT-10). default 는 없으면 만든다.
func (m *Manager) Profiles() ([]Profile, error) {
	if err := m.ensureProfileDir(DefaultProfile); err != nil {
		return nil, err
	}
	ents, err := os.ReadDir(m.profilesDir())
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Profile
	for _, e := range ents {
		if !e.IsDir() || !profileNameRe.MatchString(e.Name()) {
			continue
		}
		p := Profile{Name: e.Name()}
		_, p.Running = m.browsers[p.Name]
		for _, pg := range m.tabs {
			if pg.profile == p.Name {
				p.Tabs++
			}
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (m *Manager) ensureProfileDir(name string) error {
	// NFR-BRT-S3: 홈과 같은 권한이다 — 쿠키·로그인이 산다.
	if err := os.MkdirAll(filepath.Join(m.cfg.Home, dmenv.BrowserDir), 0o700); err != nil {
		return err
	}
	return os.MkdirAll(filepath.Join(m.profilesDir(), name), 0o700)
}

// CreateProfile 은 프로필 폴더를 만든다.
func (m *Manager) CreateProfile(name string) error {
	if !profileNameRe.MatchString(name) {
		return ErrBadProfile
	}
	return m.ensureProfileDir(name)
}

// DeleteProfile 은 그 프로필의 탭을 닫고, 브라우저를 끝내고, 폴더를 지운다 (FR-BRT-13).
func (m *Manager) DeleteProfile(name string) error {
	if name == DefaultProfile {
		return ErrDefaultKeep
	}
	if !profileNameRe.MatchString(name) {
		return ErrBadProfile
	}
	dir := filepath.Join(m.profilesDir(), name)
	if _, err := os.Stat(dir); err != nil {
		return ErrNoProfile
	}
	m.mu.Lock()
	var gone []string
	for id, pg := range m.tabs {
		if pg.profile == name {
			gone = append(gone, id)
			delete(m.tabs, id)
		}
	}
	for id, g := range m.ghosts {
		if g.profile == name {
			gone = append(gone, id)
			delete(m.ghosts, id)
		}
	}
	b := m.browsers[name]
	delete(m.browsers, name)
	m.mu.Unlock()
	for _, id := range gone {
		m.emit(Event{Kind: EvClosed, Tab: id})
	}
	if b != nil {
		b.kill()
		b.waitExit(5 * time.Second)
	}
	return removeAllSettled(dir, 5*time.Second)
}

// removeAllSettled 는 폴더를 지우되, 끝나 가는 자식 프로세스가 아직 파일을 쥐고 있으면
// 잠시 다시 해 본다 — Windows 는 Job 의 나머지 자식이 핸들을 조금 늦게 놓는다(CI 실측).
func removeAllSettled(dir string, within time.Duration) error {
	end := time.Now().Add(within)
	for {
		err := os.RemoveAll(dir)
		if err == nil || time.Now().After(end) {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// ── 탭 목록 ─────────────────────────────────────────────────────

// TabInfo 는 탭 하나의 목록 행이다.
type TabInfo struct {
	Tab      string `json:"tab"`
	Profile  string `json:"profile"`
	Isolated bool   `json:"isolated,omitempty"`
	URL      string `json:"url"`
	Title    string `json:"title"`
	Live     bool   `json:"live"`
}

// Tabs 는 매니저가 아는 탭 전부다 — 페이지가 있는 것과, 다시 만들 수 있는 것.
func (m *Manager) Tabs() []TabInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]TabInfo, 0, len(m.tabs)+len(m.ghosts))
	for id, pg := range m.tabs {
		pg.mu.Lock()
		out = append(out, TabInfo{Tab: id, Profile: pg.profile, Isolated: pg.isolated, URL: pg.st.URL, Title: pg.st.Title, Live: true})
		pg.mu.Unlock()
	}
	for id, g := range m.ghosts {
		out = append(out, TabInfo{Tab: id, Profile: g.profile, Isolated: g.isolated, URL: g.url})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Tab < out[j].Tab })
	return out
}

func (m *Manager) page(tab string) (*page, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	pg := m.tabs[tab]
	if pg == nil {
		return nil, ErrNoTab
	}
	return pg, nil
}

// ── 열기·닫기 (묶음 T) ──────────────────────────────────────────

// OpenReq 는 페이지 하나를 여는 요청이다.
type OpenReq struct {
	Tab      string `json:"tab"`
	URL      string `json:"url"`
	Profile  string `json:"profile"`
	Isolated bool   `json:"isolated"`
	// Viewport 는 복원할 고정 크기다 (FR-BRT-52) — 페이지를 **만들 때만** 적용한다.
	Viewport *Size `json:"viewport,omitempty"`
}

// Open 은 페이지를 **즉시** 만든다 (FR-BRT-36) — 배치는 화면이 한다. 이미 그 탭이
// 있으면 그대로 둔다(Ensure 와 같은 뜻이 된다).
func (m *Manager) Open(ctx context.Context, r OpenReq) error {
	if r.Tab == "" {
		return errors.New("탭 id 가 없습니다")
	}
	if r.URL == "" {
		r.URL = "about:blank"
	}
	if err := CheckURL(r.URL); err != nil {
		return err
	}
	if r.Profile == "" {
		r.Profile = DefaultProfile
	}
	if !profileNameRe.MatchString(r.Profile) {
		return ErrBadProfile
	}
	m.mu.Lock()
	if _, ok := m.tabs[r.Tab]; ok {
		m.mu.Unlock()
		return nil
	}
	delete(m.ghosts, r.Tab)
	m.mu.Unlock()
	if r.Profile != DefaultProfile {
		if _, err := os.Stat(filepath.Join(m.profilesDir(), r.Profile)); err != nil {
			return ErrNoProfile
		}
	}
	b, err := m.browserFor(ctx, r.Profile)
	if err != nil {
		return err
	}
	return b.openPage(ctx, r)
}

// Ensure 는 지연 복원이다 (FR-BRT-39). 페이지가 없으면 저장된 url 로 만든다.
func (m *Manager) Ensure(ctx context.Context, r OpenReq) error {
	m.mu.Lock()
	_, live := m.tabs[r.Tab]
	g, isGhost := m.ghosts[r.Tab]
	m.mu.Unlock()
	if live {
		return nil
	}
	// 매니저가 기억하는 주소가 가장 새것이다 — 워크스페이스의 url 은 저장이 늦을 수 있다.
	if isGhost {
		r.URL, r.Profile, r.Isolated = g.url, g.profile, g.isolated
	}
	return m.Open(ctx, r)
}

// CloseTab 은 탭의 페이지를 닫는다 (FR-BRT-37).
func (m *Manager) CloseTab(ctx context.Context, tab string) error {
	m.mu.Lock()
	pg := m.tabs[tab]
	delete(m.tabs, tab)
	delete(m.ghosts, tab)
	m.mu.Unlock()
	if pg == nil {
		return nil
	}
	pg.b.forget(pg)
	pg.b.closeDevToolsOf(pg)
	_, err := pg.b.cl.Call(ctx, "", "Target.closeTarget", map[string]any{"targetId": pg.target})
	pg.b.afterPageGone(pg)
	return err
}

// browserFor 는 그 프로필의 브라우저를 낸다 — 없으면 띄운다 (FR-BRT-7).
func (m *Manager) browserFor(ctx context.Context, profile string) (*profileBrowser, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errors.New("브라우저 매니저가 끝났습니다")
	}
	b := m.browsers[profile]
	if b == nil {
		b = newProfileBrowser(m, profile)
		m.browsers[profile] = b
		go b.start()
	}
	m.mu.Unlock()
	select {
	case <-b.ready:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if b.startErr != nil {
		m.mu.Lock()
		if m.browsers[profile] == b {
			delete(m.browsers, profile)
		}
		m.mu.Unlock()
		return nil, b.startErr
	}
	return b, nil
}

// browserGone 은 프로필 브라우저가 끝났을 때 불린다. 남은 탭은 유령이 되어 다음에
// 보일 때 다시 만들어진다 (FR-BRT-38).
func (m *Manager) browserGone(b *profileBrowser, planned bool) {
	m.mu.Lock()
	delete(m.closing, b)
	if m.browsers[b.profile] == b {
		delete(m.browsers, b.profile)
	}
	var lost []*page
	for id, pg := range m.tabs {
		if pg.b == b {
			pg.markGone()
			lost = append(lost, pg)
			delete(m.tabs, id)
			pg.mu.Lock()
			m.ghosts[id] = ghost{url: pg.st.URL, profile: pg.profile, isolated: pg.isolated}
			pg.mu.Unlock()
		}
	}
	m.mu.Unlock()
	m.proxiesGone(b)
	if !planned {
		dmlog.Infof(nil, "[browser] 프로필 %s 의 브라우저가 끝났다 (탭 %d개는 다음에 보일 때 다시 연다)", b.profile, len(lost))
	}
	for _, pg := range lost {
		pg.mu.Lock()
		st := pg.st
		pg.mu.Unlock()
		st.Crashed = true
		st.Loading = false
		m.emitInfo(EvState, pg.tab, st)
	}
}

// ── Do — IPC 와 직접 모드가 함께 쓰는 한 표면 ──────────────────────

// Call 은 Host 의 구현이다 — Do 의 결과를 JSON 으로 낸다.
func (m *Manager) Call(ctx context.Context, op string, params any) (json.RawMessage, error) {
	raw, ok := params.(json.RawMessage)
	if !ok {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, err
		}
		raw = b
	}
	res, err := m.Do(ctx, op, raw)
	if err != nil {
		return nil, err
	}
	if r, ok := res.(json.RawMessage); ok {
		return r, nil
	}
	return json.Marshal(res)
}

// Do 는 조작 하나를 이름으로 부른다. 데몬 IPC 는 이것을 그대로 나른다.
func (m *Manager) Do(ctx context.Context, op string, params json.RawMessage) (any, error) {
	switch op {
	case "profiles":
		ps, err := m.Profiles()
		return map[string]any{"profiles": ps}, err
	case "profileCreate", "profileDelete":
		var p struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		if op == "profileCreate" {
			return okResult, m.CreateProfile(p.Name)
		}
		return okResult, m.DeleteProfile(p.Name)
	case "tabs":
		return map[string]any{"tabs": m.Tabs()}, nil
	case "downloads":
		return map[string]any{"downloads": m.Downloads()}, nil
	case "open", "ensure":
		var r OpenReq
		if err := json.Unmarshal(params, &r); err != nil {
			return nil, err
		}
		if op == "open" {
			return okResult, m.Open(ctx, r)
		}
		return okResult, m.Ensure(ctx, r)
	case "close":
		var p tabParam
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		return okResult, m.CloseTab(ctx, p.Tab)
	case "proxyOpen", "proxySend", "proxyClose", "version":
		var p struct {
			Profile string          `json:"profile"`
			Tool    string          `json:"tool"`
			Client  string          `json:"client"`
			Msg     json.RawMessage `json:"msg"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
		switch op {
		case "proxyOpen":
			id, err := m.proxyOpen(ctx, p.Profile, p.Tool)
			return map[string]string{"client": id}, err
		case "proxySend":
			pc, err := m.proxyOf(p.Client)
			if err != nil {
				return nil, err
			}
			return okResult, pc.p.Send(p.Msg)
		case "proxyClose":
			m.proxyClose(p.Client)
			return okResult, nil
		default:
			return m.version(ctx, p.Profile)
		}
	}
	var tp tabParam
	if err := json.Unmarshal(params, &tp); err != nil {
		return nil, err
	}
	pg, err := m.page(tp.Tab)
	if err != nil {
		return nil, err
	}
	return pg.do(ctx, op, params)
}

type tabParam struct {
	Tab string `json:"tab"`
}

var okResult = map[string]bool{"ok": true}

// launchArgs 는 프로필 브라우저의 기동 인자다 (FR-BRT-4). 디버깅 포트를 열지 않는다
// (FR-BRT-5) — `--remote-debugging-port` 는 어떤 경로로도 붙지 않는다.
func launchArgs(profileDir, audio string) []string {
	args := []string{
		"--headless=new",
		"--remote-debugging-pipe",
		"--user-data-dir=" + profileDir,
		"--no-first-run",
		"--no-default-browser-check",
		// 기동 때 스스로 새 탭을 열지 않는다 — 탭 목록과 페이지 목록이 같아야 하고
		// (FR-BRT-31), 그 새 탭을 뒤늦게 닫으면 렌더러를 나눠 쓰던 첫 페이지의 이동이
		// 깨진다(실측).
		"--no-startup-window",
		// FR-BRT-93: headless·pipe 만으로 `navigator.webdriver` 가 true 가 된다.
		"--disable-blink-features=AutomationControlled",
	}
	if audio != AudioServer {
		args = append(args, "--mute-audio")
	}
	if audio == AudioViewer {
		// FR-BRT-91: allowlist 가 있어야 사용자의 확장 호출 없이 탭 소리를 받는다.
		args = append(args, "--enable-unsafe-extension-debugging", "--allowlisted-extension-id="+audioExtID)
	}
	return args
}

// parseMajor 는 `Browser.getVersion` 의 product(`HeadlessChrome/153.0.…`)에서 주 버전을 읽는다.
func parseMajor(product string) int {
	for i := 0; i < len(product); i++ {
		if product[i] == '/' {
			n := 0
			for j := i + 1; j < len(product) && product[j] >= '0' && product[j] <= '9'; j++ {
				n = n*10 + int(product[j]-'0')
			}
			return n
		}
	}
	return 0
}

// engineError 는 사용자에게 보일 기동 실패 문구다 (FR-BRT-2·3·6).
func engineError(what string, hint string) error {
	if hint == "" {
		return errors.New(what)
	}
	return fmt.Errorf("%s — %s", what, hint)
}

var _ Host = (*Manager)(nil)
