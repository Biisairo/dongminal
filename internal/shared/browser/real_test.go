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
