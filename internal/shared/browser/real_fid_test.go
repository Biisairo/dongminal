package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 3단계 — 충실도 (TC-BRT-70~79 의 매니저 절반). 실제 Chrome 이 없으면 건너뛴다.

func fidSite(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/file.txt":
			w.Header().Set("Content-Disposition", `attachment; filename="report.txt"`)
			fmt.Fprint(w, "downloaded-body")
		case "/auth":
			if u, p, ok := r.BasicAuth(); !ok || u != "user" || p != "pw" {
				w.Header().Set("WWW-Authenticate", `Basic realm="dm"`)
				w.WriteHeader(401)
				return
			}
			fmt.Fprint(w, "<title>authed</title>")
		default:
			fmt.Fprint(w, `<title>fid</title>
<a id=dl href="/file.txt">download</a> <a id=mail href="mailto:a@b.example">mail</a>
<input id=f type=file multiple> <input id=d type=date> <input id=l list=opts><datalist id=opts><option value=one><option value=two></datalist>
<span id=tip title="hello tip" style="cursor:help">tip</span>
<form id=fm><input id=req required></form>
<p id=txt>findme here and findme there</p>`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func openFid(t *testing.T) (*Manager, *recorder, *httptest.Server) {
	m, r := realManager(t)
	m.cfg.DownloadDir = func() string { return filepath.Join(m.cfg.Home, "dl") }
	site := fidSite(t)
	if err := m.Open(context.Background(), OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"fid"`)
	return m, r, site
}

func clickSel(t *testing.T, m *Manager, sel string) {
	t.Helper()
	raw := evalIn(t, m, "t", `(()=>{const r=document.querySelector(`+"`"+sel+"`"+`).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`)
	var xy []float64
	json.Unmarshal(raw, &xy)
	pg, _ := m.page("t")
	ctx := context.Background()
	pg.mouse(ctx, "mouseMoved", xy[0], xy[1], 0)
	pg.mouse(ctx, "mousePressed", xy[0], xy[1], 1)
	pg.mouse(ctx, "mouseReleased", xy[0], xy[1], 1)
}

func report(t *testing.T, r *recorder, kind string) map[string]any {
	t.Helper()
	e := r.wait(t, 10*time.Second, func(e Event) bool {
		if e.Kind != EvReport {
			return false
		}
		var v map[string]any
		json.Unmarshal(e.Info, &v)
		return v["t"] == kind
	})
	var v map[string]any
	json.Unmarshal(e.Info, &v)
	return v
}

// TC-BRT-72: alert·confirm·prompt 가 뷰어로 가고, 답은 한 번이다. 떠 있는 동안 조작은 알린다.
func TestRealDialogs(t *testing.T) {
	m, r, _ := openFid(t)
	ctx := context.Background()
	pg, _ := m.page("t")
	go pg.call(ctx, "Runtime.evaluate", map[string]any{"expression": `window.__r = prompt('name?', 'def')`, "userGesture": true})
	e := r.wait(t, 10*time.Second, func(e Event) bool { return e.Kind == EvDialog && !strings.Contains(string(e.Info), "closed") })
	var d dialogInfo
	json.Unmarshal(e.Info, &d)
	if d.Type != "prompt" || d.Message != "name?" || d.Default != "def" {
		t.Fatalf("dialog: %+v", d)
	}
	if _, err := m.Call(ctx, "click", map[string]any{"tab": "t", "ref": "e1"}); err == nil || !strings.Contains(err.Error(), "대화상자") {
		t.Fatalf("떠 있는 동안의 조작: %v", err)
	}
	if _, err := m.Call(ctx, "dialog", map[string]any{"tab": "t", "id": d.ID, "accept": true, "text": "kim"}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Call(ctx, "dialog", map[string]any{"tab": "t", "id": d.ID, "accept": false}); err == nil {
		t.Fatal("같은 대화상자에 두 번 답했다")
	}
	waitEval(t, m, "t", `window.__r`, `"kim"`)
}

// TC-BRT-71: 파일 선택 → 서버 파일 → setFileInputFiles · 취소 · multiple.
func TestRealFileChooser(t *testing.T) {
	m, r, _ := openFid(t)
	ctx := context.Background()
	a := filepath.Join(t.TempDir(), "a.txt")
	os.WriteFile(a, []byte("A"), 0o600)
	b := filepath.Join(t.TempDir(), "b.txt")
	os.WriteFile(b, []byte("B"), 0o600)
	clickSel(t, m, "#f")
	e := r.wait(t, 10*time.Second, func(e Event) bool { return e.Kind == EvChooser })
	var c struct {
		ID       int  `json:"id"`
		Multiple bool `json:"multiple"`
	}
	json.Unmarshal(e.Info, &c)
	if !c.Multiple {
		t.Fatalf("multiple 이 아니다: %s", e.Info)
	}
	if _, err := m.Call(ctx, "chooser", map[string]any{"tab": "t", "id": c.ID, "files": []string{a, b}}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `[...document.getElementById('f').files].map(f=>f.name).join(',')`, `"a.txt,b.txt"`)
}

// TC-BRT-70: 다운로드 → 서버 폴더에 파일, 이름 복원, 목록.
func TestRealDownload(t *testing.T) {
	m, r, _ := openFid(t)
	// 설정은 그 다운로드가 끝날 때 읽는다 — 브라우저를 다시 띄우지 않아도 바뀐 폴더로 간다.
	later := filepath.Join(m.cfg.Home, "later")
	m.cfg.DownloadDir = func() string { return later }
	clickSel(t, m, "#dl")
	e := r.wait(t, 15*time.Second, func(e Event) bool {
		var d Download
		json.Unmarshal(e.Info, &d)
		return e.Kind == EvDownload && d.State == "completed"
	})
	var d Download
	json.Unmarshal(e.Info, &d)
	b, err := os.ReadFile(d.Path)
	if err != nil || string(b) != "downloaded-body" || d.Path != filepath.Join(later, "report.txt") || d.Tab != "t" {
		t.Fatalf("download: %+v %q %v", d, b, err)
	}
	res, _ := m.Call(context.Background(), "downloads", map[string]any{})
	if !strings.Contains(string(res), "report.txt") {
		t.Fatalf("목록: %s", res)
	}
}

// TC-BRT-73: HTTP 기본 인증.
func TestRealHTTPAuth(t *testing.T) {
	m, r, site := openFid(t)
	ctx := context.Background()
	m.Call(ctx, "nav", map[string]any{"tab": "t", "action": "goto", "url": site.URL + "/auth"})
	e := r.wait(t, 10*time.Second, func(e Event) bool { return e.Kind == EvAuth && !strings.Contains(string(e.Info), "closed") })
	var a struct {
		ID    string `json:"id"`
		Realm string `json:"realm"`
	}
	json.Unmarshal(e.Info, &a)
	if a.Realm != "dm" {
		t.Fatalf("auth: %s", e.Info)
	}
	if _, err := m.Call(ctx, "auth", map[string]any{"tab": "t", "id": a.ID, "user": "user", "pass": "pw"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"authed"`)
}

// TC-BRT-75·79·74·76: 커서·툴팁·검증 말풍선·위젯·비웹 링크·복사·컨텍스트 메뉴 보고.
func TestRealReports(t *testing.T) {
	m, r, _ := openFid(t)
	ctx := context.Background()
	pg, _ := m.page("t")
	raw := evalIn(t, m, "t", `(()=>{const r=document.getElementById('tip').getBoundingClientRect();return [r.left+2,r.top+2]})()`)
	var xy []float64
	json.Unmarshal(raw, &xy)
	pg.mouse(ctx, "mouseMoved", xy[0], xy[1], 0)
	if v := report(t, r, "tooltip"); v["v"] != "hello tip" {
		t.Fatalf("tooltip: %v", v)
	}
	if v := report(t, r, "cursor"); v["v"] != "help" {
		t.Fatalf("cursor: %v", v)
	}
	clickSel(t, m, "#mail")
	if v := report(t, r, "extlink"); v["href"] != "mailto:a@b.example" {
		t.Fatalf("extlink: %v", v)
	}
	clickSel(t, m, "#d")
	w := report(t, r, "widget")
	if w["kind"] != "date" {
		t.Fatalf("widget: %v", w)
	}
	if _, err := m.Call(ctx, "widget", map[string]any{"tab": "t", "id": w["id"], "value": "2026-09-27"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.getElementById('d').value`, `"2026-09-27"`)
	clickSel(t, m, "#l")
	dle := r.wait(t, 10*time.Second, func(e Event) bool {
		return e.Kind == EvReport && strings.Contains(string(e.Info), `"kind":"datalist"`)
	})
	if !strings.Contains(string(dle.Info), `"two"`) {
		t.Fatalf("datalist: %s", dle.Info)
	}
	evalIn(t, m, "t", `document.getElementById('fm').reportValidity(); 1`)
	if v := report(t, r, "invalid"); v["v"] == "" {
		t.Fatalf("invalid: %v", v)
	}
	evalIn(t, m, "t", `(()=>{const r=document.createRange();r.selectNodeContents(document.getElementById('txt'));getSelection().removeAllRanges();getSelection().addRange(r);return 1})()`)
	// 복사는 신뢰 입력의 편집 명령으로 일으킨다 — 스크립트의 execCommand 는 복사 이벤트를 내지 않는다.
	pg.call(ctx, "Input.dispatchKeyEvent", map[string]any{"type": "rawKeyDown", "key": "c", "code": "KeyC",
		"windowsVirtualKeyCode": 67, "modifiers": ModCtrl, "commands": []string{"copy"}})
	pg.call(ctx, "Input.dispatchKeyEvent", map[string]any{"type": "keyUp", "key": "c", "code": "KeyC", "windowsVirtualKeyCode": 67, "modifiers": ModCtrl})
	if v := report(t, r, "copy"); !strings.Contains(fmt.Sprint(v["v"]), "findme") {
		t.Fatalf("copy: %v", v)
	}
	raw = evalIn(t, m, "t", `(()=>{const r=document.getElementById('dl').getBoundingClientRect();return [r.left+2,r.top+2]})()`)
	json.Unmarshal(raw, &xy)
	pg.call(ctx, "Input.dispatchMouseEvent", map[string]any{"type": "mousePressed", "x": xy[0], "y": xy[1], "button": "right", "buttons": 2, "clickCount": 1})
	pg.call(ctx, "Input.dispatchMouseEvent", map[string]any{"type": "mouseReleased", "x": xy[0], "y": xy[1], "button": "right", "clickCount": 1})
	if v := report(t, r, "menu"); !strings.HasSuffix(fmt.Sprint(v["href"]), "/file.txt") {
		t.Fatalf("menu: %v", v)
	}
}

// TC-BRT-74 (막는 쪽): 페이지가 contextmenu 를 막으면 메뉴를 보고하지 않는다.
func TestRealContextMenuPrevented(t *testing.T) {
	m, r, _ := openFid(t)
	ctx := context.Background()
	pg, _ := m.page("t")
	evalIn(t, m, "t", `document.addEventListener('contextmenu', e => e.preventDefault()); 1`)
	pg.call(ctx, "Input.dispatchMouseEvent", map[string]any{"type": "mousePressed", "x": 5, "y": 5, "button": "right", "buttons": 2, "clickCount": 1})
	pg.call(ctx, "Input.dispatchMouseEvent", map[string]any{"type": "mouseReleased", "x": 5, "y": 5, "button": "right", "clickCount": 1})
	time.Sleep(500 * time.Millisecond)
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.evs {
		if e.Kind == EvReport && strings.Contains(string(e.Info), `"t":"menu"`) {
			t.Fatalf("막았는데 메뉴를 보고했다: %s", e.Info)
		}
	}
}

// TC-BRT-78: 찾기.
func TestRealFind(t *testing.T) {
	m, _, _ := openFid(t)
	ctx := context.Background()
	res, err := m.Call(ctx, "find", map[string]any{"tab": "t", "q": "findme", "dir": 1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(res), `"count":2`) || !strings.Contains(string(res), `"index":1`) {
		t.Fatalf("find: %s", res)
	}
	res, _ = m.Call(ctx, "find", map[string]any{"tab": "t", "q": "findme", "dir": 1})
	if !strings.Contains(string(res), `"index":2`) {
		t.Fatalf("다음: %s", res)
	}
	// 강조의 레지스트리는 문서의 것이다 — 페이지에서도 칠한 둘이 보인다.
	waitEval(t, m, "t", `CSS.highlights.size`, `2`)
	m.Call(ctx, "find", map[string]any{"tab": "t", "q": ""})
	waitEval(t, m, "t", `CSS.highlights.size`, `0`)
}

// TC-BRT-77: DevTools 탭 — 열림, 대상이 닫히면 함께 닫힘 (P6).
func TestRealDevTools(t *testing.T) {
	m, r, _ := openFid(t)
	ctx := context.Background()
	if _, err := m.Call(ctx, "devtools", map[string]any{"tab": "t"}); err != nil {
		t.Fatal(err)
	}
	e := r.wait(t, 15*time.Second, func(e Event) bool { return e.Kind == EvCreated })
	var c Created
	json.Unmarshal(e.Info, &c)
	if c.DevtoolsOf != "t" || !strings.HasPrefix(c.Name, "DevTools") || !strings.HasPrefix(c.URL, "devtools://") {
		t.Fatalf("devtools: %+v", c)
	}
	m.CloseTab(ctx, "t")
	r.wait(t, 10*time.Second, func(x Event) bool { return x.Kind == EvClosed && x.Tab == e.Tab })
}
