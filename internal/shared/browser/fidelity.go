package browser

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 3단계 충실도 — 대화상자·파일 선택·다운로드·DevTools (BROWSER_TAB_SRS FR-BRT-80·81·84·85).

// 이벤트 종류.
const (
	// EvDialog 는 JS 대화상자다 (FR-BRT-85). Info 는 dialogInfo, 닫히면 {closed:true}.
	EvDialog = "dialog"
	// EvChooser 는 파일 선택이다 (FR-BRT-81). Info 는 {id, multiple}.
	EvChooser = "chooser"
	// EvDownload 는 다운로드 하나의 진행이다 (FR-BRT-80). Info 는 Download.
	EvDownload = "download"
	// EvAuth 는 HTTP 인증 요청이다 (FR-BRT-86). Info 는 {id, origin, scheme, realm}, 답하면 {id, closed}.
	EvAuth = "auth"
)

type dialogInfo struct {
	ID      int    `json:"id"`
	Type    string `json:"type"`
	Message string `json:"message"`
	Default string `json:"default,omitempty"`
	Closed  bool   `json:"closed,omitempty"`
}

type chooser struct {
	id       int
	backend  int
	multiple bool
}

// fidelityState 는 페이지 하나의 3단계 상태다. pg.mu 아래.
type fidelityState struct {
	dialog  *dialogInfo
	chooser *chooser
	seq     int
}

func (pg *page) fid() *fidelityState {
	if pg.fids == nil {
		pg.fids = &fidelityState{}
	}
	return pg.fids
}

// onFidelityEvent 는 페이지 세션의 3단계 이벤트다.
func (pg *page) onFidelityEvent(method string, params json.RawMessage) {
	switch method {
	case "Page.javascriptDialogOpening":
		var p struct {
			Message       string `json:"message"`
			Type          string `json:"type"`
			DefaultPrompt string `json:"defaultPrompt"`
		}
		json.Unmarshal(params, &p)
		pg.mu.Lock()
		f := pg.fid()
		f.seq++
		d := &dialogInfo{ID: f.seq, Type: p.Type, Message: p.Message, Default: p.DefaultPrompt}
		f.dialog = d
		pg.mu.Unlock()
		pg.b.m.emitInfo(EvDialog, pg.tab, d)
	case "Page.javascriptDialogClosed":
		pg.mu.Lock()
		f := pg.fid()
		d := f.dialog
		f.dialog = nil
		pg.mu.Unlock()
		if d != nil {
			pg.b.m.emitInfo(EvDialog, pg.tab, dialogInfo{ID: d.ID, Closed: true})
		}
	case "Fetch.authRequired":
		var p struct {
			RequestID     string `json:"requestId"`
			AuthChallenge struct {
				Origin string `json:"origin"`
				Scheme string `json:"scheme"`
				Realm  string `json:"realm"`
			} `json:"authChallenge"`
		}
		json.Unmarshal(params, &p)
		pg.b.m.emitInfo(EvAuth, pg.tab, map[string]any{"id": p.RequestID, "origin": p.AuthChallenge.Origin,
			"scheme": p.AuthChallenge.Scheme, "realm": p.AuthChallenge.Realm})
	case "Page.fileChooserOpened":
		var p struct {
			Mode          string `json:"mode"`
			BackendNodeID int    `json:"backendNodeId"`
		}
		json.Unmarshal(params, &p)
		pg.mu.Lock()
		f := pg.fid()
		f.seq++
		c := &chooser{id: f.seq, backend: p.BackendNodeID, multiple: p.Mode == "selectMultiple"}
		f.chooser = c
		pg.mu.Unlock()
		home, _ := os.UserHomeDir()
		pg.b.m.emitInfo(EvChooser, pg.tab, map[string]any{"id": c.id, "multiple": c.multiple, "home": home})
	}
}

// dialogOpen 은 열린 대화상자다 — 에이전트의 조작은 그것부터 답하라고 알린다 (FR-BRT-85).
func (pg *page) dialogOpen() error {
	pg.mu.Lock()
	defer pg.mu.Unlock()
	if pg.fids == nil || pg.fids.dialog == nil {
		return nil
	}
	d := pg.fids.dialog
	return errors.New("대화상자가 열려 있습니다 (" + d.Type + ": " + strconv.Quote(d.Message) + ") — dmctl browser dialog --accept|--dismiss")
}

// answerDialog 는 대화상자에 답한다. 한 대화상자에 답은 한 번이다 — 늦게 온 답은
// 그 대화상자가 이미 닫혔으므로 거절된다(첫 답을 따른다).
func (pg *page) answerDialog(ctx context.Context, id int, accept bool, text string) error {
	pg.mu.Lock()
	f := pg.fid()
	d := f.dialog
	if d == nil || (id != 0 && d.ID != id) {
		pg.mu.Unlock()
		return errors.New("열린 대화상자가 없습니다")
	}
	f.dialog = nil
	pg.mu.Unlock()
	params := map[string]any{"accept": accept}
	if text != "" {
		params["promptText"] = text
	}
	_, err := pg.call(ctx, "Page.handleJavaScriptDialog", params)
	return err
}

// answerChooser 는 서버 파일 선택 창의 답이다 (FR-BRT-81). 빈 목록은 취소다.
func (pg *page) answerChooser(ctx context.Context, id int, files []string) error {
	pg.mu.Lock()
	f := pg.fid()
	c := f.chooser
	if c == nil || c.id != id {
		pg.mu.Unlock()
		return errors.New("열린 파일 선택이 없습니다")
	}
	f.chooser = nil
	pg.mu.Unlock()
	if len(files) > 1 && !c.multiple {
		files = files[:1]
	}
	if files == nil {
		files = []string{}
	}
	_, err := pg.call(ctx, "DOM.setFileInputFiles", map[string]any{"files": files, "backendNodeId": c.backend})
	return err
}

// ── 다운로드 (FR-BRT-80) ─────────────────────────────────────────

// Download 는 다운로드 하나다. 파일은 **서버에만** 남는다 (D-BRT-16).
type Download struct {
	GUID     string `json:"guid"`
	Tab      string `json:"tab,omitempty"`
	URL      string `json:"url"`
	Name     string `json:"name"`
	Path     string `json:"path,omitempty"`
	State    string `json:"state"`
	Received int64  `json:"received"`
	Total    int64  `json:"total"`
}

// downloadStaging 은 받는 중인 파일을 두는 프로필 안의 폴더다.
const downloadStaging = "DMDownloads"

// downloads 는 매니저가 든다 — 프로필 브라우저가 끝나도 기록은 남는다 (`dmctl browser downloads`).
type downloads struct {
	mu   sync.Mutex
	list []*Download
	by   map[string]*Download
}

func (d *downloads) begin(guid, tab, url, name string) *Download {
	d.mu.Lock()
	defer d.mu.Unlock()
	x := &Download{GUID: guid, Tab: tab, URL: url, Name: filepath.Base(name), State: "inProgress"}
	if d.by == nil {
		d.by = map[string]*Download{}
	}
	d.by[guid] = x
	d.list = append(d.list, x)
	if len(d.list) > 200 {
		old := d.list[0]
		delete(d.by, old.GUID)
		d.list = d.list[1:]
	}
	return x
}

// uniquePath 는 같은 이름이 있으면 ` (1)` 을 붙인다.
func uniquePath(dir, name string) string {
	if name == "" || name == "." || name == "/" {
		name = "download"
	}
	p := filepath.Join(dir, name)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 1; ; i++ {
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return p
		}
		p = filepath.Join(dir, stem+" ("+strconv.Itoa(i)+")"+ext)
	}
}

// moveFile 은 옮기기다. 다운로드 폴더가 다른 볼륨이면 rename 이 못 하므로 복사한다.
func moveFile(src, dst string) error {
	if os.Rename(src, dst) == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return err
	}
	return os.Remove(src)
}

// onDownload 는 브라우저 수준의 다운로드 이벤트다. `allowAndName` 은 guid 로 저장하므로
// 끝나면 제안된 이름으로 옮긴다.
func (b *profileBrowser) onDownload(method string, params json.RawMessage) {
	d := &b.m.dls
	switch method {
	case "Browser.downloadWillBegin":
		var p struct {
			FrameID           string `json:"frameId"`
			GUID              string `json:"guid"`
			URL               string `json:"url"`
			SuggestedFilename string `json:"suggestedFilename"`
		}
		json.Unmarshal(params, &p)
		tab := ""
		if pg := b.byTarget(p.FrameID); pg != nil {
			tab = pg.tab
		}
		x := d.begin(p.GUID, tab, p.URL, p.SuggestedFilename)
		b.m.emitInfo(EvDownload, tab, x)
	case "Browser.downloadProgress":
		var p struct {
			GUID          string  `json:"guid"`
			State         string  `json:"state"`
			ReceivedBytes float64 `json:"receivedBytes"`
			TotalBytes    float64 `json:"totalBytes"`
		}
		json.Unmarshal(params, &p)
		d.mu.Lock()
		x := d.by[p.GUID]
		if x == nil {
			d.mu.Unlock()
			return
		}
		x.State, x.Received, x.Total = p.State, int64(p.ReceivedBytes), int64(p.TotalBytes)
		if p.State == "completed" {
			out := b.m.downloadDir()
			os.MkdirAll(out, 0o755)
			dst := uniquePath(out, x.Name)
			if err := moveFile(filepath.Join(b.dlDir, p.GUID), dst); err == nil {
				x.Path = dst
				x.Name = filepath.Base(dst)
			} else {
				x.Path = filepath.Join(b.dlDir, p.GUID)
			}
		}
		cp := *x
		d.mu.Unlock()
		// 진행은 잦다 — 끝과 1 MiB 단위만 알린다.
		if p.State != "inProgress" || cp.Received%(1<<20) < 64<<10 {
			b.m.emitInfo(EvDownload, cp.Tab, cp)
		}
	}
}

// Downloads 는 모든 프로필의 다운로드 목록이다 (`dmctl browser downloads`).
func (m *Manager) Downloads() []Download {
	m.dls.mu.Lock()
	defer m.dls.mu.Unlock()
	out := make([]Download, 0, len(m.dls.list))
	for _, x := range m.dls.list {
		out = append(out, *x)
	}
	return out
}

// downloadDir 는 저장 폴더다 — 설정 값, 없으면 서버 사용자의 ~/Downloads.
func (m *Manager) downloadDir() string {
	if m.cfg.DownloadDir != nil {
		if d := m.cfg.DownloadDir(); d != "" {
			return d
		}
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return os.TempDir()
	}
	return filepath.Join(h, "Downloads")
}

// ── DevTools (FR-BRT-84) ─────────────────────────────────────────

// openDevTools 는 그 페이지의 DevTools 를 **탭으로** 연다 (P6). 돌려받은 페이지는
// `devtoolsOf` 를 단 탭이 되고 대상 탭이 닫히면 함께 닫힌다.
func (pg *page) openDevTools(ctx context.Context, panel string) error {
	params := map[string]any{"targetId": pg.target}
	if panel != "" {
		params["panelId"] = panel
	}
	res, err := pg.call(ctx, "Target.openDevTools", params)
	if err != nil {
		// 페이지 세션이 모르면 브라우저 수준으로 다시 묻는다 — 판마다 받는 자리가 다르다.
		res, err = pg.b.cl.Call(ctx, "", "Target.openDevTools", params)
		if err != nil {
			return err
		}
	}
	var r struct {
		TargetID string `json:"targetId"`
	}
	json.Unmarshal(res, &r)
	b := pg.b
	b.mu.Lock()
	b.devtools[r.TargetID] = pg
	_, waiting := b.unclaimed[r.TargetID]
	b.mu.Unlock()
	if waiting {
		go b.adoptForeign(targetInfo{TargetID: r.TargetID})
	}
	return nil
}

// closeDevToolsOf 는 대상 탭이 닫힐 때 그 DevTools 탭들을 닫는다.
func (b *profileBrowser) closeDevToolsOf(pg *page) {
	b.mu.Lock()
	var gone []string
	for id, t := range b.pages {
		if t.devtoolsOf == pg.tab {
			gone = append(gone, id)
		}
	}
	b.mu.Unlock()
	for _, id := range gone {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		b.cl.Call(ctx, "", "Target.closeTarget", map[string]any{"targetId": id})
		cancel()
	}
}

// actOps 는 대화상자가 떠 있으면 거절하는 에이전트 조작이다.
var actOps = map[string]struct{}{"snapshot": {}, "click": {}, "hover": {}, "fill": {}, "select": {},
	"type": {}, "press": {}, "scroll": {}, "upload": {}, "wait": {}, "eval": {}}

// doFidelity 는 3단계 조작의 분기다.
func (pg *page) doFidelity(ctx context.Context, op string, params json.RawMessage) (any, bool, error) {
	var p struct {
		Q      string   `json:"q"`
		Dir    int      `json:"dir"`
		ID     int      `json:"id"`
		Value  string   `json:"value"`
		Accept bool     `json:"accept"`
		Text   string   `json:"text"`
		Files  []string `json:"files"`
		Panel  string   `json:"panel"`
	}
	json.Unmarshal(params, &p)
	switch op {
	case "find":
		v, err := pg.find(ctx, p.Q, p.Dir)
		return v, true, err
	case "widget":
		return okResult, true, pg.setWidget(ctx, p.ID, p.Value)
	case "dialog":
		return okResult, true, pg.answerDialog(ctx, p.ID, p.Accept, p.Text)
	case "chooser":
		return okResult, true, pg.answerChooser(ctx, p.ID, p.Files)
	case "devtools":
		return okResult, true, pg.openDevTools(ctx, p.Panel)
	case "audio":
		v, err := pg.audio(ctx, params)
		return v, true, err
	case "copyImage":
		v, err := pg.copyImage(ctx, params)
		return v, true, err
	case "auth":
		var a struct {
			ID     string `json:"id"`
			User   string `json:"user"`
			Pass   string `json:"pass"`
			Cancel bool   `json:"cancel"`
		}
		json.Unmarshal(params, &a)
		resp := map[string]any{"response": "ProvideCredentials", "username": a.User, "password": a.Pass}
		if a.Cancel {
			resp = map[string]any{"response": "CancelAuth"}
		}
		_, err := pg.call(ctx, "Fetch.continueWithAuth", map[string]any{"requestId": a.ID, "authChallengeResponse": resp})
		pg.b.m.emitInfo(EvAuth, pg.tab, map[string]any{"id": a.ID, "closed": true})
		return okResult, true, err
	}
	return nil, false, nil
}

// copyImage 는 컨텍스트 메뉴의 "이미지 복사" 다 (FR-BRT-87). 이미지 요소의 자리(문서 CSS 좌표)를
// 떠서 PNG 로 돌려준다 — 원본을 받지 않으므로 교차 출처 이미지도 된다. 뷰어가 제 클립보드에 쓴다.
func (pg *page) copyImage(ctx context.Context, params json.RawMessage) (any, error) {
	var p struct {
		X, Y, W, H float64
	}
	json.Unmarshal(params, &p)
	if p.W < 1 || p.H < 1 || p.W > 8192 || p.H > 8192 {
		return nil, errors.New("이미지 크기가 없습니다")
	}
	res, err := pg.call(ctx, "Page.captureScreenshot", map[string]any{"format": "png", "captureBeyondViewport": true,
		"clip": map[string]any{"x": p.X, "y": p.Y, "width": p.W, "height": p.H, "scale": 1}})
	if err != nil {
		return nil, err
	}
	var r struct {
		Data string `json:"data"`
	}
	json.Unmarshal(res, &r)
	return map[string]string{"png": r.Data}, nil
}
