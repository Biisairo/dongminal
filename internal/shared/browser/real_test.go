package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
)

// 실제 Chrome 으로 도는 시험이다. Chrome 이 없으면 건너뛴다 — CI(Linux·Windows)는
// Chrome 을 갖춘다 (NFR-BRT-Q1).

type recorder struct {
	mu  sync.Mutex
	evs []Event
}

func (r *recorder) sink(e Event) {
	r.mu.Lock()
	r.evs = append(r.evs, e)
	r.mu.Unlock()
}

func (r *recorder) wait(t *testing.T, d time.Duration, pred func(Event) bool) Event {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		r.mu.Lock()
		for _, e := range r.evs {
			if pred(e) {
				r.mu.Unlock()
				return e
			}
		}
		r.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	r.mu.Lock()
	for _, e := range r.evs {
		if e.Kind != EvFrame {
			t.Logf("EV %s %s %s", e.Kind, e.Tab, e.Info)
		}
	}
	r.mu.Unlock()
	t.Fatal("기다린 이벤트가 오지 않았다")
	return Event{}
}

func realManager(t *testing.T) (*Manager, *recorder) {
	t.Helper()
	eng := platform.Current().Chrome
	if _, err := eng.Find(); err != nil {
		t.Skip("Chrome 없음")
	}
	m := New(Config{Home: t.TempDir(), Engine: eng})
	r := &recorder{}
	m.SetSink(r.sink)
	t.Cleanup(m.Close)
	return m, r
}

func evalIn(t *testing.T, m *Manager, tab, expr string) json.RawMessage {
	t.Helper()
	res, err := m.Do(context.Background(), "cdp", mustJSON(map[string]any{"tab": tab, "method": "Runtime.evaluate",
		"params": map[string]any{"expression": expr, "returnByValue": true, "awaitPromise": true, "userGesture": true}}))
	if err != nil {
		t.Fatalf("evaluate %q: %v", expr, err)
	}
	var r struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
	}
	json.Unmarshal(res.(json.RawMessage), &r)
	return r.Result.Value
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func waitEval(t *testing.T, m *Manager, tab, expr, want string) {
	t.Helper()
	end := time.Now().Add(10 * time.Second)
	var got string
	for time.Now().Before(end) {
		raw := evalIn(t, m, tab, expr)
		var v any
		json.Unmarshal(raw, &v)
		b, _ := json.Marshal(v)
		got = string(b)
		if got == want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s = %s, want %s", expr, got, want)
}

func testSite(t *testing.T) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/set", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "k", Value: r.URL.Query().Get("v"), Path: "/"})
		fmt.Fprint(w, "<title>set</title>ok")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<title>hello</title><select id=s><option>a</option><option>b</option></select>
<input id=i><a id=blank href="/other" target=_blank>new</a>`)
	})
	mux.HandleFunc("/other", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<title>other</title>") })
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

// 여는 흐름 전체 — 즉시 생성(FR-BRT-36) · 제목 상태 · 보면 첫 프레임 · base-select
// (TC-BRT-45 의 CSS 절반) · 닫으면 브라우저가 끝난다 (TC-BRT-7).
func TestRealOpenWatchClose(t *testing.T) {
	m, r := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t1", URL: site.URL + "/"}); err != nil {
		t.Fatalf("Open: %v", err)
	}
	r.wait(t, 10*time.Second, func(e Event) bool {
		if e.Kind != EvState || e.Tab != "t1" {
			return false
		}
		var st TabState
		json.Unmarshal(e.Info, &st)
		return st.Title == "hello"
	})
	// 탭 목록과 페이지 목록이 같다 — 기동 때 Chrome 이 연 빈 페이지가 남지 않는다.
	res, _ := browserOf(m, DefaultProfile).cl.Call(ctx, "", "Target.getTargets", nil)
	var tg struct {
		TargetInfos []targetInfo `json:"targetInfos"`
	}
	json.Unmarshal(res, &tg)
	pages := 0
	for _, ti := range tg.TargetInfos {
		if ti.Type == "page" {
			pages++
		}
	}
	if pages != 1 {
		t.Fatalf("페이지 %d개 — 탭은 하나다", pages)
	}
	waitEval(t, m, "t1", `getComputedStyle(document.getElementById('s')).appearance`, `"base-select"`)
	m.Do(ctx, "viewport", mustJSON(map[string]any{"tab": "t1", "w": 800, "h": 600, "dpr": 1}))
	if _, err := m.Do(ctx, "watch", mustJSON(map[string]any{"tab": "t1", "on": true})); err != nil {
		t.Fatal(err)
	}
	f := r.wait(t, 10*time.Second, func(e Event) bool { return e.Kind == EvFrame && e.Tab == "t1" })
	if len(f.Data) < 100 || f.Data[0] != 0xFF || f.Data[1] != 0xD8 {
		t.Fatalf("JPEG 가 아니다: %d바이트", len(f.Data))
	}
	waitEval(t, m, "t1", `innerWidth`, `800`)
	// TC-BRT-46: 확대 z=2 → innerWidth 가 1/z.
	m.Do(ctx, "zoom", mustJSON(map[string]any{"tab": "t1", "zoom": 2}))
	waitEval(t, m, "t1", `innerWidth`, `400`)
	b := browserOf(m, DefaultProfile)
	if err := m.CloseTab(ctx, "t1"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-b.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("마지막 페이지가 닫혔는데 브라우저가 끝나지 않았다")
	}
}

// TC-BRT-32 절반: 페이지가 연 페이지는 매니저가 탭으로 만든다 (`created` 에 opener).
// TC-BRT-35 절반: 페이지가 스스로 닫히면 `closed`.
func TestRealOpenedByPageAndWindowClose(t *testing.T) {
	m, r := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t1", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t1", `document.title`, `"hello"`)
	evalIn(t, m, "t1", `window.open('/other'); 1`)
	c := r.wait(t, 10*time.Second, func(e Event) bool { return e.Kind == EvCreated })
	var cr Created
	json.Unmarshal(c.Info, &cr)
	if cr.Opener != "t1" {
		t.Fatalf("opener=%q", cr.Opener)
	}
	waitEval(t, m, c.Tab, `document.title`, `"other"`)
	evalIn(t, m, c.Tab, `window.close(); 1`)
	r.wait(t, 10*time.Second, func(e Event) bool { return e.Kind == EvClosed && e.Tab == c.Tab })
}

// TC-BRT-13·14: 두 프로필은 쿠키가 섞이지 않고, 임시 탭은 기본 컨텍스트의 쿠키를 보지 않는다.
func TestRealProfilesAndIsolation(t *testing.T) {
	m, _ := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.CreateProfile("work"); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(m.Open(ctx, OpenReq{Tab: "a", URL: site.URL + "/set?v=A"}))
	must(m.Open(ctx, OpenReq{Tab: "w", URL: site.URL + "/set?v=W", Profile: "work"}))
	waitEval(t, m, "a", `document.cookie`, `"k=A"`)
	waitEval(t, m, "w", `document.cookie`, `"k=W"`)
	if browserOf(m, DefaultProfile).proc.Pid == browserOf(m, "work").proc.Pid {
		t.Fatal("프로필 둘이 한 프로세스다")
	}
	must(m.Open(ctx, OpenReq{Tab: "i", URL: site.URL + "/", Isolated: true}))
	waitEval(t, m, "i", `document.title`, `"hello"`)
	waitEval(t, m, "i", `document.cookie`, `""`)
	b := browserOf(m, DefaultProfile)
	pg, _ := m.page("i")
	cid := pg.context
	must(m.CloseTab(ctx, "i"))
	res, _ := b.cl.Call(ctx, "", "Target.getBrowserContexts", nil)
	if strings.Contains(string(res), cid) {
		t.Fatalf("마지막 임시 탭이 닫혔는데 컨텍스트가 남았다: %s", res)
	}
	// TC-BRT-12: 사용 중 프로필 삭제 → 탭 닫힘 · 프로세스 종료 · 폴더 삭제.
	wb := browserOf(m, "work")
	must(m.DeleteProfile("work"))
	select {
	case <-wb.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("프로필 브라우저가 끝나지 않았다")
	}
	if _, err := m.page("w"); err == nil {
		t.Fatal("지운 프로필의 탭이 남았다")
	}
}

// TC-BRT-43 (매니저 절반): 한글 조합 입력이 composition 이벤트 열과 값을 낸다 (P5).
func TestRealIMEComposition(t *testing.T) {
	m, _ := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"hello"`)
	evalIn(t, m, "t", `window.__ev=[]; const i=document.getElementById('i');
for (const k of ['compositionstart','compositionupdate','compositionend']) i.addEventListener(k, e => __ev.push(k[11]+(e.data||'')));
i.focus(); 1`)
	for _, s := range []string{"ㅎ", "하", "한", "한ㄱ", "한그", "한글"} {
		if _, err := m.Do(ctx, "input", mustJSON(map[string]any{"tab": "t", "t": "ime", "text": s})); err != nil {
			t.Fatal(err)
		}
	}
	m.Do(ctx, "input", mustJSON(map[string]any{"tab": "t", "t": "insert", "text": "한글"}))
	time.Sleep(100 * time.Millisecond)
	waitEval(t, m, "t", `document.getElementById('i').value`, `"한글"`)
	var got string
	json.Unmarshal(evalIn(t, m, "t", `__ev.join(',')`), &got)
	if !strings.HasPrefix(got, "s,uㅎ,u하,u한,u한ㄱ,u한그,u한글") || !strings.HasSuffix(got, "e한글") {
		t.Fatalf("composition 열: %s", got)
	}
}

// 키 입력이 글자를 넣는다 (FR-BRT-54). 입력은 줄에 서서 차례로 간다.
func TestRealKeyTyping(t *testing.T) {
	m, _ := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"hello"`)
	evalIn(t, m, "t", `document.getElementById('i').focus(); 1`)
	for _, k := range []string{"h", "i"} {
		for _, typ := range []string{"keyDown", "keyUp"} {
			m.Do(ctx, "input", mustJSON(map[string]any{"tab": "t", "t": "key", "type": typ, "key": k,
				"code": "Key" + strings.ToUpper(k), "keyCode": int(strings.ToUpper(k)[0])}))
		}
	}
	waitEval(t, m, "t", `document.getElementById('i').value`, `"hi"`)
}

// TC-BRT-36·38: 프로필 브라우저가 끝나면 탭은 유령이 되고(크래시 안내), 다음에 보일 때
// 저장된 url 로 다시 만든다. 임시 탭은 새 임시 컨텍스트다.
func TestRealBrowserGoneThenLazyRestore(t *testing.T) {
	m, r := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	if err := m.Open(ctx, OpenReq{Tab: "i", URL: site.URL + "/other", Isolated: true}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"hello"`)
	waitEval(t, m, "i", `document.title`, `"other"`)
	b := browserOf(m, DefaultProfile)
	b.proc.Kill()
	r.wait(t, 10*time.Second, func(e Event) bool {
		var st TabState
		json.Unmarshal(e.Info, &st)
		return e.Kind == EvState && e.Tab == "t" && st.Crashed
	})
	for _, ti := range m.Tabs() {
		if ti.Live {
			t.Fatalf("끝난 브라우저의 탭이 살아 있다: %+v", ti)
		}
	}
	// 보이지 않는 동안에는 페이지가 없다 — Ensure 가 불릴 때 생긴다.
	if err := m.Ensure(ctx, OpenReq{Tab: "t"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `location.pathname`, `"/"`)
	if err := m.Ensure(ctx, OpenReq{Tab: "i"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "i", `location.pathname`, `"/other"`)
	pg, _ := m.page("i")
	if pg.context == "" || !pg.isolated {
		t.Fatal("임시 탭이 새 임시 컨텍스트에서 열리지 않았다")
	}
}

func browserOf(m *Manager, profile string) *profileBrowser {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.browsers[profile]
}

// FR-BRT-52: 복원할 고정 크기는 페이지를 만들 때 걸리고 상태에 실린다. auto 는 푼다.
func TestRealOpenWithFixedViewport(t *testing.T) {
	m, r := realManager(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: "about:blank", Viewport: &Size{W: 640, H: 480}}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `innerWidth+'x'+innerHeight`, `"640x480"`)
	// 창 주인의 크기는 고정 중에는 적용되지 않는다 (TC-BRT-41).
	if _, err := m.Call(ctx, "viewport", map[string]any{"tab": "t", "w": 1000, "h": 700}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `innerWidth+'x'+innerHeight`, `"640x480"`)
	if _, err := m.Call(ctx, "viewport", map[string]any{"tab": "t", "fixed": false}); err != nil {
		t.Fatal(err)
	}
	r.wait(t, 5*time.Second, func(e Event) bool {
		var st TabState
		json.Unmarshal(e.Info, &st)
		return e.Kind == EvState && e.Tab == "t" && st.Viewport == nil
	})
	waitEval(t, m, "t", `innerWidth+'x'+innerHeight`, `"1000x700"`)
}

// TC-BRT-7: 매니저가 끝나면 프로필 브라우저(자식 트리)가 남지 않는다.
func TestRealCloseLeavesNoChrome(t *testing.T) {
	eng := platform.Current().Chrome
	if _, err := eng.Find(); err != nil {
		t.Skip("Chrome 없음")
	}
	m := New(Config{Home: t.TempDir(), Engine: eng})
	if err := m.Open(context.Background(), OpenReq{Tab: "t", URL: "about:blank"}); err != nil {
		t.Fatal(err)
	}
	pid := browserOf(m, DefaultProfile).proc.Pid
	proc := platform.Current().Process
	if !proc.Alive(pid) {
		t.Fatal("브라우저가 떠 있지 않다")
	}
	m.Close()
	end := time.Now().Add(5 * time.Second)
	for proc.Alive(pid) && time.Now().Before(end) {
		time.Sleep(50 * time.Millisecond)
	}
	if proc.Alive(pid) {
		t.Fatalf("매니저가 끝났는데 Chrome(pid %d)이 남았다", pid)
	}
}

// TC-BRT-83 (FR-BRT-92): 첫 요청부터 UA 에 headless 표식이 없다.
func TestRealUserAgentHasNoHeadless(t *testing.T) {
	m, _ := realManager(t)
	uas := make(chan [2]string, 8)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case uas <- [2]string{r.UserAgent(), r.Header.Get("Sec-CH-UA")}:
		default:
		}
		fmt.Fprint(w, "<title>ua</title>")
	}))
	defer site.Close()
	if err := m.Open(context.Background(), OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	var got [2]string
	select {
	case got = <-uas:
	case <-time.After(15 * time.Second):
		t.Fatal("요청이 오지 않았다")
	}
	first := got[0]
	if strings.Contains(first, "HeadlessChrome") || !strings.Contains(first, "Chrome/") {
		t.Fatalf("첫 요청 UA: %q", first)
	}
	// UA 만 덮으면 Chrome 이 Client Hints 를 비운다(실측) — 비지 않아야 한다.
	if !strings.Contains(got[1], "Chrome") {
		t.Fatalf("첫 요청 Sec-CH-UA: %q", got[1])
	}
	waitEval(t, m, "t", `document.title`, `"ua"`)
	var nav string
	json.Unmarshal(evalIn(t, m, "t", `navigator.userAgent`), &nav)
	if nav != first {
		t.Fatalf("navigator.userAgent %q ≠ 헤더 %q", nav, first)
	}
	waitEval(t, m, "t", `navigator.userAgentData.brands.length > 0`, `true`)
}

// TC-BRT-84 (FR-BRT-93): 최상위 페이지와 교차 출처 iframe 모두 `navigator.webdriver` 가 false 다.
func TestRealNoWebdriver(t *testing.T) {
	m, _ := realManager(t)
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<script>parent.postMessage(String(navigator.webdriver), '*')</script>`)
	}))
	defer inner.Close()
	outer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `<title>wd</title><script>addEventListener('message', e => { window.__inner = e.data })</script><iframe src="%s/"></iframe>`, inner.URL)
	}))
	defer outer.Close()
	// 바깥은 localhost, 안은 127.0.0.1 — 출처가 다르다.
	if err := m.Open(context.Background(), OpenReq{Tab: "t", URL: strings.Replace(outer.URL, "127.0.0.1", "localhost", 1) + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"wd"`)
	waitEval(t, m, "t", `navigator.webdriver`, `false`)
	waitEval(t, m, "t", `window.__inner`, `"false"`)
}

// TC-BRT-88 (FR-BRT-96): `nav signin` 은 Chrome 설정의 로그인 자리로 간다. 사용자가 적은 chrome: 주소는 여전히 거절이다.
func TestRealNavSignin(t *testing.T) {
	m, _ := realManager(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: "about:blank"}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Call(ctx, "nav", map[string]any{"tab": "t", "action": "goto", "url": "chrome://settings/people"}); err == nil {
		t.Fatal("goto chrome: 가 거절되지 않았다")
	}
	if _, err := m.Call(ctx, "nav", map[string]any{"tab": "t", "action": "signin"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `location.href`, `"chrome://settings/people"`)
	// 설정은 shadow DOM 이다 — 안으로 내려가며 찾는다.
	waitEval(t, m, "t", `(()=>{const f=n=>{if(!n)return false;if(n.id==='signIn')return true;if(n.shadowRoot&&f(n.shadowRoot))return true;for(const c of n.children||[])if(f(c))return true;return false};return f(document.documentElement)})()`, `true`)
}

// TC-BRT-91 (FR-BRT-33a): Chrome 이 연(opener 없는) 페이지는 최근에 입력받은 탭 옆에 앞으로 연다.
func TestRealBrowserOpenedFollowsLastInput(t *testing.T) {
	m, r := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	for _, tab := range []string{"a", "b"} {
		if err := m.Open(ctx, OpenReq{Tab: tab, URL: site.URL + "/"}); err != nil {
			t.Fatal(err)
		}
		waitEval(t, m, tab, `document.title`, `"hello"`)
	}
	created := func(path string) Created {
		if _, err := browserOf(m, DefaultProfile).cl.Call(ctx, "", "Target.createTarget", map[string]any{"url": site.URL + path}); err != nil {
			t.Fatal(err)
		}
		e := r.wait(t, 15*time.Second, func(e Event) bool {
			var c Created
			return e.Kind == EvCreated && json.Unmarshal(e.Info, &c) == nil && strings.HasSuffix(c.URL, path)
		})
		var c Created
		json.Unmarshal(e.Info, &c)
		return c
	}
	if c := created("/other?none"); c.Opener != "" || !c.Background {
		t.Fatalf("입력 전: %+v", c)
	}
	if _, err := m.Call(ctx, "input", map[string]any{"tab": "a", "t": "mouse", "type": "mouseMoved", "x": 5, "y": 5}); err != nil {
		t.Fatal(err)
	}
	if c := created("/other?after"); c.Opener != "a" || c.Background {
		t.Fatalf("a 에 입력한 뒤: %+v", c)
	}
}
