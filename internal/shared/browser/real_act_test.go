package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 2단계 — 관찰·조작·대기 (TC-BRT-60~64). 실제 Chrome 이 없으면 건너뛴다.

func actSite(t *testing.T) (*httptest.Server, *httptest.Server) {
	t.Helper()
	frame := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<title>f</title><button id=fb onclick="this.textContent='frame-clicked'">in frame</button>`)
	}))
	t.Cleanup(frame.Close)
	// 교차 출처 iframe — 127.0.0.1 과 localhost 는 다른 사이트다.
	frameURL := strings.Replace(frame.URL, "127.0.0.1", "localhost", 1)
	main := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `<title>act</title>
<button id=b onclick="document.title='clicked';console.log('hello-console')">Press me</button>
<input id=t aria-label="Name">
<select id=s aria-label="Pick"><option value=a>Alpha</option><option value=b>Beta</option></select>
<div id=cov style="position:relative"><button id=hid>Covered</button>
  <div style="position:absolute;inset:0;background:red"></div></div>
<div onclick="document.title='div-clicked'" style="cursor:pointer;width:80px;height:20px">clickable div</div>
<iframe src="%s" width=300 height=80></iframe>
<script>document.getElementById('s').addEventListener('change',e=>{document.title='sel-'+e.target.value})</script>`, frameURL)
	}))
	t.Cleanup(main.Close)
	return main, frame
}

func do(t *testing.T, m *Manager, op string, p map[string]any) (json.RawMessage, error) {
	t.Helper()
	p["tab"] = "t"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return m.Call(ctx, op, p)
}

func refOf(t *testing.T, snap, needle string) string {
	t.Helper()
	for _, ln := range strings.Split(snap, "\n") {
		if strings.Contains(ln, needle) {
			if i := strings.Index(ln, "[ref="); i >= 0 {
				j := strings.Index(ln[i:], "]")
				return ln[i+5 : i+j]
			}
		}
	}
	t.Fatalf("%q 의 ref 가 없다:\n%s", needle, snap)
	return ""
}

func snap(t *testing.T, m *Manager, dom bool) string {
	t.Helper()
	res, err := do(t, m, "snapshot", map[string]any{"dom": dom})
	if err != nil {
		t.Fatal(err)
	}
	var s struct{ Snapshot string }
	json.Unmarshal(res, &s)
	return s.Snapshot
}

// TC-BRT-60: snapshot → click·fill·select·press·wait 흐름 · 무효 ref · 교차 출처 iframe.
func TestRealActFlow(t *testing.T) {
	m, _ := realManager(t)
	site, _ := actSite(t)
	if err := m.Open(context.Background(), OpenReq{Tab: "t", URL: site.URL + "/"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"act"`)
	// 교차 출처 iframe 의 세션이 붙기를 기다린다.
	var s string
	for i := 0; i < 50; i++ {
		s = snap(t, m, false)
		if strings.Contains(s, "in frame") {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !strings.Contains(s, `button "Press me" [ref=`) {
		t.Fatalf("snapshot 모양:\n%s", s)
	}
	if _, err := do(t, m, "click", map[string]any{"ref": refOf(t, s, `"Press me"`)}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"clicked"`)
	if _, err := do(t, m, "fill", map[string]any{"ref": refOf(t, s, `textbox "Name"`), "text": "안녕 world"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.getElementById('t').value`, `"안녕 world"`)
	if _, err := do(t, m, "press", map[string]any{"key": "Backspace"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.getElementById('t').value`, `"안녕 worl"`)
	if _, err := do(t, m, "select", map[string]any{"ref": refOf(t, s, `"Pick"`), "value": "Beta"}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"sel-b"`)
	// 교차 출처 iframe 안의 요소도 ref 를 받고 누를 수 있다.
	if _, err := do(t, m, "click", map[string]any{"ref": refOf(t, s, `"in frame"`)}); err != nil {
		t.Fatalf("iframe click: %v", err)
	}
	s2 := snap(t, m, false)
	if !strings.Contains(s2, "frame-clicked") {
		t.Fatalf("iframe 안의 클릭이 닿지 않았다:\n%s", s2)
	}
	// wait --text
	if _, err := do(t, m, "wait", map[string]any{"text": "clickable div"}); err != nil {
		t.Fatal(err)
	}
	// 무효 ref — 이동 뒤에는 다시 snapshot 이다.
	old := refOf(t, s2, `"Press me"`)
	if _, err := do(t, m, "nav", map[string]any{"action": "reload"}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	if _, err := do(t, m, "click", map[string]any{"ref": old}); err == nil || !strings.Contains(err.Error(), "다시 snapshot") {
		t.Fatalf("무효 ref: %v", err)
	}
}

// TC-BRT-61: 덮인 요소의 click 은 시간 초과로 실패하고 이유를 낸다.
func TestRealActCovered(t *testing.T) {
	m, _ := realManager(t)
	site, _ := actSite(t)
	m.Open(context.Background(), OpenReq{Tab: "t", URL: site.URL + "/"})
	waitEval(t, m, "t", `document.title`, `"act"`)
	// iframe 까지 다 읽히고 덮개가 그려진 뒤에 잰다 — 부하 걸린 러너에서 1.5초 안에 첫 판정도
	// 못 해 "보이지 않음" 으로 끝났다(CI 실측). 재는 것은 이유가 "가림" 인가다.
	waitEval(t, m, "t", `document.readyState==='complete'&&document.getElementById('hid').getBoundingClientRect().width>0`, `true`)
	s := snap(t, m, false)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := m.Call(ctx, "click", map[string]any{"tab": "t", "ref": refOf(t, s, `"Covered"`)})
	if err == nil || !strings.Contains(err.Error(), "가림") {
		t.Fatalf("덮인 요소: %v", err)
	}
}

// TC-BRT-62: `--dom` 이 `div onclick` 을 잡는다.
func TestRealDomSnapshot(t *testing.T) {
	m, _ := realManager(t)
	site, _ := actSite(t)
	m.Open(context.Background(), OpenReq{Tab: "t", URL: site.URL + "/"})
	waitEval(t, m, "t", `document.title`, `"act"`)
	s := snap(t, m, true)
	if !strings.HasPrefix(s, "# scroll:") || !strings.Contains(s, `<div> "clickable div"`) {
		t.Fatalf("--dom:\n%s", s)
	}
	var id string
	for _, ln := range strings.Split(s, "\n") {
		if strings.Contains(ln, "clickable div") {
			id = ln[1:strings.Index(ln, "]")]
		}
	}
	if _, err := do(t, m, "click", map[string]any{"ref": id}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"div-clicked"`)
}

// TC-BRT-64: screenshot · console · network 기록 · eval.
func TestRealLogsScreenshotEval(t *testing.T) {
	m, _ := realManager(t)
	site, _ := actSite(t)
	m.Open(context.Background(), OpenReq{Tab: "t", URL: site.URL + "/"})
	waitEval(t, m, "t", `document.title`, `"act"`)
	s := snap(t, m, false)
	do(t, m, "click", map[string]any{"ref": refOf(t, s, `"Press me"`)})
	waitEval(t, m, "t", `document.title`, `"clicked"`)
	res, _ := do(t, m, "console", map[string]any{"limit": 10})
	if !strings.Contains(string(res), "hello-console") {
		t.Fatalf("console: %s", res)
	}
	res, _ = do(t, m, "network", map[string]any{})
	if !strings.Contains(string(res), site.URL) || !strings.Contains(string(res), `"status":200`) {
		t.Fatalf("network: %s", res)
	}
	res, err := do(t, m, "screenshot", map[string]any{"full": true})
	if err != nil {
		t.Fatal(err)
	}
	var shot struct{ Png []byte }
	json.Unmarshal(res, &shot)
	if len(shot.Png) < 100 || string(shot.Png[1:4]) != "PNG" {
		t.Fatalf("PNG 가 아니다: %d", len(shot.Png))
	}
	res, err = do(t, m, "eval", map[string]any{"expr": "1+2"})
	if err != nil || !strings.Contains(string(res), `"value":3`) {
		t.Fatalf("eval: %s %v", res, err)
	}
	if _, err := do(t, m, "eval", map[string]any{"expr": "throw new Error('boom')"}); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("eval 예외: %v", err)
	}
}
