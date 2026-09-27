package browser

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TC-BRT-35: 렌더러가 죽으면 상태가 crashed 가 된다 — 뷰어가 "페이지가 멈췄습니다" 와 새로고침을 띄운다.
func TestRealCrashState(t *testing.T) {
	m, r := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"hello"`)
	// Page.crash 는 Linux headless 에서 렌더러를 죽이지 않았다(CI 실측) — Puppeteer 처럼
	// chrome://crash 로 이동해 죽인다. 매니저의 이동(nav)은 이 scheme 을 거절하므로 CDP 로 간다.
	go m.Do(ctx, "cdp", mustJSON(map[string]any{"tab": "t", "method": "Page.navigate", "params": map[string]any{"url": "chrome://crash"}}))
	r.wait(t, 10*time.Second, func(e Event) bool {
		var st TabState
		json.Unmarshal(e.Info, &st)
		return e.Kind == EvState && e.Tab == "t" && st.Crashed
	})
	// 새로고침이 되살린다.
	if _, err := m.Call(ctx, "nav", map[string]any{"tab": "t", "action": "reload"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"hello"`)
}

// TC-BRT-37: 보지 않으면 프레임이 없고, 다시 보면 페이지가 바뀌지 않아도 첫 프레임이 곧 온다 (FR-BRT-40).
func TestRealReshowSendsFrame(t *testing.T) {
	m, r := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"hello"`)
	m.Call(ctx, "viewport", map[string]any{"tab": "t", "w": 640, "h": 480, "dpr": 1})
	m.Call(ctx, "watch", map[string]any{"tab": "t", "on": true})
	r.wait(t, 10*time.Second, func(e Event) bool { return e.Kind == EvFrame && e.Tab == "t" })
	m.Call(ctx, "watch", map[string]any{"tab": "t", "on": false})
	time.Sleep(300 * time.Millisecond)
	count := func() int {
		r.mu.Lock()
		defer r.mu.Unlock()
		n := 0
		for _, e := range r.evs {
			if e.Kind == EvFrame && e.Tab == "t" {
				n++
			}
		}
		return n
	}
	n := count()
	evalIn(t, m, "t", `document.title='changed'`)
	time.Sleep(500 * time.Millisecond)
	if count() != n {
		t.Fatal("보지 않는 탭이 프레임을 보냈다")
	}
	t0 := time.Now()
	m.Call(ctx, "watch", map[string]any{"tab": "t", "on": true})
	for count() == n {
		if time.Since(t0) > 2*time.Second {
			t.Fatal("다시 보였는데 첫 프레임이 오지 않는다")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TC-BRT-72: beforeunload 도 대화상자로 온다 — 떠나기를 고르면 이동한다.
func TestRealBeforeUnload(t *testing.T) {
	m, r, site := openFid(t)
	ctx := context.Background()
	evalIn(t, m, "t", `addEventListener('beforeunload',e=>{e.preventDefault();e.returnValue=''});document.getElementById('cq').focus();true`)
	// beforeunload 는 사용자 활성화가 있어야 뜬다.
	clickSel(t, m, "#cq")
	go m.Call(ctx, "nav", map[string]any{"tab": "t", "action": "goto", "url": site.URL + "/?after"})
	e := r.wait(t, 10*time.Second, func(e Event) bool {
		return e.Kind == EvDialog && strings.Contains(string(e.Info), `"beforeunload"`)
	})
	var d dialogInfo
	json.Unmarshal(e.Info, &d)
	if _, err := m.Call(ctx, "dialog", map[string]any{"tab": "t", "id": d.ID, "accept": true}); err != nil {
		t.Fatal(err)
	}
	r.wait(t, 10*time.Second, func(e Event) bool {
		var st TabState
		json.Unmarshal(e.Info, &st)
		return e.Kind == EvState && e.Tab == "t" && strings.HasSuffix(st.URL, "/?after")
	})
}

// TC-BRT-45: base-select 의 목록이 페이지 안에 그려지고, 옵션을 누르면 값이 바뀐다.
func TestRealBaseSelectPick(t *testing.T) {
	m, _ := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `getComputedStyle(document.getElementById('s')).appearance`, `"base-select"`)
	pg, _ := m.page("t")
	click := func(expr string) {
		t.Helper()
		var xy []float64
		json.Unmarshal(evalIn(t, m, "t", `(()=>{const r=(`+expr+`).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`), &xy)
		pg.mouse(ctx, "mouseMoved", xy[0], xy[1], 0)
		pg.mouse(ctx, "mousePressed", xy[0], xy[1], 1)
		pg.mouse(ctx, "mouseReleased", xy[0], xy[1], 1)
	}
	click(`document.getElementById('s')`)
	waitEval(t, m, "t", `document.getElementById('s').matches(':open')`, `true`)
	click(`document.getElementById('s').options[1]`)
	waitEval(t, m, "t", `document.getElementById('s').value`, `"b"`)
}

// TC-BRT-32: 수정키(⌘/Ctrl) 클릭으로 연 탭도 연 탭의 것이고 뒤에 열린다 — Chrome 은 이때
// opener 를 싣지 않는다(실측).
func TestRealModClickOpensBackground(t *testing.T) {
	m, r := realManager(t)
	site := testSite(t)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"hello"`)
	var xy []float64
	json.Unmarshal(evalIn(t, m, "t", `(()=>{const r=document.getElementById('blank').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`), &xy)
	mod := ModCtrl
	if pg, _ := m.page("t"); pg.serverMac() {
		mod = ModMeta
	}
	for _, typ := range []string{"mousePressed", "mouseReleased"} {
		if _, err := m.Call(ctx, "input", map[string]any{"tab": "t", "t": "mouse", "type": typ, "x": xy[0], "y": xy[1],
			"button": "left", "buttons": 1, "clickCount": 1, "mods": mod}); err != nil {
			t.Fatal(err)
		}
	}
	e := r.wait(t, 10*time.Second, func(e Event) bool { return e.Kind == EvCreated })
	var c Created
	json.Unmarshal(e.Info, &c)
	if c.Opener != "t" || !c.Background {
		t.Fatalf("수정키 클릭: %+v", c)
	}
}
