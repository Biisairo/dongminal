package runtimebin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TC-BRT-50 (dmctl 절반): open-url·dmctl open-url 은 `dmctl browser open --focus` 와
// 같은 길로 브라우저 탭을 연다 (FR-BRT-70). 호출 칸은 이 도구다.
func TestOpenURL_OpensBrowserTab(t *testing.T) {
	var got map[string]any
	var path string
	defer captureAPI(t, `{"ok":true,"tab":"T1"}`, &got, &path, nil)()
	t.Setenv("DONGMINAL_TOOL_ID", "tool-9")
	var stdout, stderr bytes.Buffer
	if rc := runOpenURL([]string{"https://example.com/a?b=1"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	if path != "/api/browser/open" {
		t.Fatalf("path=%s", path)
	}
	if got["url"] != "https://example.com/a?b=1" || got["focus"] != true || got["tool"] != "tool-9" {
		t.Fatalf("body=%v", got)
	}
}

// FR-BRT-65: 열 수 없는 scheme 은 서버에 가지 않고 1 로 끝난다.
func TestOpenURL_RejectsScheme(t *testing.T) {
	var path string
	defer captureAPI(t, `{}`, nil, &path, nil)()
	var stdout, stderr bytes.Buffer
	if rc := runOpenURL([]string{"javascript:alert(1)"}, &stdout, &stderr); rc != 1 {
		t.Fatalf("rc=%d", rc)
	}
	if path != "" {
		t.Fatalf("서버에 갔다: %s", path)
	}
}

func TestOpenURL_Usage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if rc := runOpenURL(nil, &stdout, &stderr); rc != 2 {
		t.Fatalf("rc=%d", rc)
	}
}

// FR-BRT-66: 경로는 이 셸의 cwd 로 풀어 file:// 로 연다.
func TestBrowserOpen_PathBecomesFileURL(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.html"), []byte("x"), 0o600)
	wd, _ := os.Getwd()
	os.Chdir(dir)
	defer os.Chdir(wd)
	var got map[string]any
	defer captureAPI(t, `{"ok":true,"tab":"T1"}`, &got, nil, nil)()
	var stdout, stderr bytes.Buffer
	if rc := runDmctlBrowser([]string{"open", "a.html", "--split", "none", "--isolated"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr.String())
	}
	u, _ := got["url"].(string)
	if !strings.HasPrefix(u, "file://") || !strings.HasSuffix(u, "/a.html") {
		t.Fatalf("url=%q", u)
	}
	if got["split"] != "none" || got["isolated"] != true || got["focus"] != false {
		t.Fatalf("body=%v", got)
	}
	if !strings.Contains(stdout.String(), "tab=T1") {
		t.Fatalf("stdout=%q", stdout.String())
	}
}

// FR-BRT-78: 사용법 오류는 2, 동작 실패는 1.
func TestBrowserExitCodes(t *testing.T) {
	var stdout, stderr bytes.Buffer
	for _, args := range [][]string{{"open"}, {"viewport", "12x"}, {"open", "x", "--split", "left"}, {"nope"}} {
		if rc := runDmctlBrowser(args, &stdout, &stderr); rc != 2 {
			t.Errorf("%v → %d want 2", args, rc)
		}
	}
	defer withDmctlServerStatus(t, 409, "Google Chrome 을 찾지 못했습니다")()
	stderr.Reset()
	if rc := runDmctlBrowser([]string{"reload"}, &stdout, &stderr); rc != 1 {
		t.Fatalf("동작 실패 rc=%d", rc)
	}
	// TC-BRT-2: 엔진이 없으면 open 도 안내를 내고 1 로 끝난다.
	if rc := runDmctlBrowser([]string{"open", "https://example.com"}, &stdout, &stderr); rc != 1 {
		t.Fatalf("open 의 엔진 없음 rc=%d", rc)
	}
	if !strings.Contains(stderr.String(), "Chrome") {
		t.Fatalf("stderr=%q", stderr.String())
	}
}

// --tab 이 없으면 도구 id 를 실어 서버가 마지막 탭을 고르게 한다 (FR-BRT-75).
func TestBrowserTabCallCarriesTool(t *testing.T) {
	var got map[string]any
	var path string
	defer captureAPI(t, `{"ok":true}`, &got, &path, nil)()
	t.Setenv("DONGMINAL_TOOL_ID", "tool-3")
	var stdout, stderr bytes.Buffer
	if rc := runDmctlBrowser([]string{"reload", "--hard"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d %s", rc, stderr.String())
	}
	if path != "/api/browser/nav" || got["action"] != "reload" || got["hard"] != true || got["tool"] != "tool-3" || got["tab"] != "" {
		t.Fatalf("path=%s body=%v", path, got)
	}
	if rc := runDmctlBrowser([]string{"viewport", "1280x800", "--tab", "U"}, &stdout, &stderr); rc != 0 {
		t.Fatal(stderr.String())
	}
	if path != "/api/browser/viewport" || got["w"] != float64(1280) || got["h"] != float64(800) || got["tab"] != "U" {
		t.Fatalf("viewport body=%v", got)
	}
}

func withDmctlServerStatus(t *testing.T, code int, body string) func() {
	return withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(code)
		w.Write([]byte(body))
	})
}

// FR-BRT-75·78: 2단계 명령은 /api/browser/act 한 곳을 지나고, 사용법 오류는 2 다.
func TestBrowserActCommands(t *testing.T) {
	var got map[string]any
	var path string
	defer captureAPI(t, `{"snapshot":"- button \"x\" [ref=e1]","value":3,"url":"https://u","title":"T","items":[{"type":"log","text":"hi"}]}`, &got, &path, nil)()
	var stdout, stderr bytes.Buffer
	if rc := runDmctlBrowser([]string{"snapshot", "--dom"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d %s", rc, stderr.String())
	}
	if path != "/api/browser/act" || got["op"] != "snapshot" || got["dom"] != true || !strings.Contains(stdout.String(), "[ref=e1]") {
		t.Fatalf("snapshot: %s %v %q", path, got, stdout.String())
	}
	stdout.Reset()
	runDmctlBrowser([]string{"fill", "e3", "hello world"}, &stdout, &stderr)
	if got["op"] != "fill" || got["ref"] != "e3" || got["text"] != "hello world" {
		t.Fatalf("fill: %v", got)
	}
	runDmctlBrowser([]string{"wait", "--text", "done", "--timeout", "2s"}, &stdout, &stderr)
	if got["op"] != "wait" || got["text"] != "done" || got["timeoutMs"] != float64(2000) {
		t.Fatalf("wait: %v", got)
	}
	stdout.Reset()
	runDmctlBrowser([]string{"url"}, &stdout, &stderr)
	if got["op"] != "state" || stdout.String() != "https://u\n" {
		t.Fatalf("url: %v %q", got, stdout.String())
	}
	stdout.Reset()
	runDmctlBrowser([]string{"console"}, &stdout, &stderr)
	if stdout.String() != "[log] hi\n" {
		t.Fatalf("console: %q", stdout.String())
	}
	for _, args := range [][]string{{"wait"}, {"click"}, {"fill", "e1"}, {"console", "--limit", "0"}, {"wait", "--text", "x", "--timeout", "soon"}} {
		if rc := runDmctlBrowser(args, &stdout, &stderr); rc != 2 {
			t.Errorf("%v → %d want 2", args, rc)
		}
	}
}

// screenshot 은 PNG 를 이 셸의 폴더(서버)에 쓰고 경로를 낸다.
func TestBrowserScreenshotWritesFile(t *testing.T) {
	dir := t.TempDir()
	defer captureAPI(t, `{"png":"iVBORw0KGgo="}`, nil, nil, nil)()
	var stdout, stderr bytes.Buffer
	out := filepath.Join(dir, "s.png")
	if rc := runDmctlBrowser([]string{"screenshot", "-o", out}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d %s", rc, stderr.String())
	}
	b, err := os.ReadFile(out)
	if err != nil || string(b[1:4]) != "PNG" || strings.TrimSpace(stdout.String()) != out {
		t.Fatalf("파일: %v %q %q", err, b, stdout.String())
	}
}

// FR-BRT-80·84·85: 3단계 명령 — 대화상자의 답·DevTools 는 act, 다운로드는 목록 GET 이다.
func TestBrowserFidelityCommands(t *testing.T) {
	var got map[string]any
	var path string
	defer captureAPI(t, `{"downloads":[{"guid":"g","name":"a.zip","path":"/d/a.zip","state":"completed","received":3,"total":3}]}`, &got, &path, nil)()
	var stdout, stderr bytes.Buffer
	if rc := runDmctlBrowser([]string{"dialog", "--accept", "--text", "yes"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d %s", rc, stderr.String())
	}
	if path != "/api/browser/act" || got["op"] != "dialog" || got["accept"] != true || got["text"] != "yes" {
		t.Fatalf("dialog: %s %v", path, got)
	}
	runDmctlBrowser([]string{"dialog", "--dismiss"}, &stdout, &stderr)
	if got["op"] != "dialog" || got["accept"] != false {
		t.Fatalf("dismiss: %v", got)
	}
	runDmctlBrowser([]string{"devtools", "--panel", "console"}, &stdout, &stderr)
	if got["op"] != "devtools" || got["panel"] != "console" {
		t.Fatalf("devtools: %v", got)
	}
	stdout.Reset()
	got = nil
	if rc := runDmctlBrowser([]string{"downloads"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("downloads rc=%d %s", rc, stderr.String())
	}
	if path != "/api/browser/downloads" || stdout.String() != "completed 3/3 /d/a.zip\n" {
		t.Fatalf("downloads: %s %q", path, stdout.String())
	}
	for _, args := range [][]string{{"dialog"}, {"dialog", "--accept", "--dismiss"}, {"devtools", "x"}, {"downloads", "x"}} {
		if rc := runDmctlBrowser(args, &stdout, &stderr); rc != 2 {
			t.Errorf("%v → %d want 2", args, rc)
		}
	}
}

// TC-BRT-63: `--json` 은 서버의 답을 그대로 한 줄로 낸다 — 기계가 읽는다.
func TestBrowserJSONOutput(t *testing.T) {
	defer captureAPI(t, `{"snapshot":"- button [ref=e1]","refs":1}`, nil, nil, nil)()
	var stdout, stderr bytes.Buffer
	if rc := runDmctlBrowser([]string{"snapshot", "--json"}, &stdout, &stderr); rc != 0 {
		t.Fatalf("rc=%d %s", rc, stderr.String())
	}
	var v map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &v); err != nil || v["snapshot"] != "- button [ref=e1]" || !strings.HasSuffix(stdout.String(), "}\n") {
		t.Fatalf("--json: %q %v", stdout.String(), err)
	}
}
