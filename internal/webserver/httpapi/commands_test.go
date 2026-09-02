package httpapi

import (
	"dongminal/internal/webserver/hub"

	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestHandleCommandPost(t *testing.T) {
	// fakeCommandBroker does not implement add/remove, so we use a real cmdHub for the handler
	// and just verify the handler logic via the real cmdHub integration.
	cmdHub := hub.NewCommandHub()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: cmdHub})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// allowed action
	body := `{"action":"focus","args":{"location":"1.1.1"}}`
	resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, b)
	}

	// unknown action
	body2 := `{"action":"hack"}`
	resp2, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body2))
	if err != nil {
		t.Fatalf("POST2: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 400 {
		t.Fatalf("status=%d want 400", resp2.StatusCode)
	}

	// invalid json
	resp3, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader("{bad"))
	if err != nil {
		t.Fatalf("POST3: %v", err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != 400 {
		t.Fatalf("status=%d want 400", resp3.StatusCode)
	}
}

func TestHandleCommandPost_MethodNotAllowed(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/commands", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 405 {
		t.Fatalf("status=%d want 405", resp.StatusCode)
	}
}

func TestHandleCommandSSE_ConnectAndClose(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/commands/sse")
	if err != nil {
		t.Fatalf("GET SSE: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type=%q want text/event-stream", ct)
	}
	// Read first line to confirm stream started.
	buf := make([]byte, 1024)
	n, _ := resp.Body.Read(buf)
	if n == 0 {
		t.Fatal("SSE stream empty")
	}
	if !bytes.Contains(buf[:n], []byte(": connected")) {
		t.Fatalf("expected ': connected', got %q", buf[:n])
	}
}

// RELOAD_CONTINUITY_SRS TC-RLC-20 (FR-RLC-20): 구독이 열리자마자 서버가 자기 자산
// 버전을 말한다.
//
// 값의 출처는 ASSET_VERSION_SINGLE_SOURCE_SRS FR-AVS-1·3 으로 내려갔다 — 문서에 적힌
// 표기가 아니라 **자산의 내용**이며, 문서에 넣는 값과 여기 싣는 값이 같은 하나다.
// 그 둘이 같다는 것은 TC-AVS-4 가 잰다.
func TestHandleCommandSSE_ServerHello(t *testing.T) {
	files := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte(
			`<script src="js/core/main.js?v=__ASSETV__"></script>`)},
		"js/core/main.js": &fstest.MapFile{Data: []byte("console.log(1)\n")},
	}
	srv, err := New(Config{DataDir: t.TempDir(), StaticFS: files}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/commands/sse")
	if err != nil {
		t.Fatalf("GET SSE: %v", err)
	}
	defer resp.Body.Close()

	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	got := string(buf[:n])
	if !strings.Contains(got, `"action":"server_hello"`) {
		t.Fatalf("첫 이벤트에 server_hello 가 없다: %q", got)
	}
	want := `"assetVersion":"` + computeAssetVersion(files) + `"`
	if !strings.Contains(got, want) {
		t.Fatalf("인사가 자산의 판을 싣지 않았다 (%s): %q", want, got)
	}
}

// TC-RLC-21 (FR-RLC-22) · TC-AVS-7 (FR-AVS-10): 판을 모르면 **판만 빠진다.** 인사를
// 통째로 거르면 생존 신호(FR-RLC-25)가 함께 사라져, 화면이 멀쩡한 구독을 죽었다고
// 판정한다.
//
// 판을 모르는 경우는 이제 **정적 자산이 아예 없는 구성** 하나뿐이다. 판이 문서의
// 표기가 아니라 자산의 내용에서 나오므로, 문서가 어떤 모양이든 값은 있다 — 종전의
// 두 번째 경우("index.html 에 ?v= 가 없다")는 성립하지 않는다 (FR-AVS-10a 는 자산이
// 하나도 없는 구성에서도 판이 있음을 따로 잰다).
func TestHandleCommandSSE_HelloWithoutVersion(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir(), StaticFS: nil}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/commands/sse")
	if err != nil {
		t.Fatalf("GET SSE: %v", err)
	}
	defer resp.Body.Close()

	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	got := string(buf[:n])
	if !strings.Contains(got, `"action":"server_hello"`) {
		t.Fatalf("판을 몰라도 인사는 와야 한다 — 그것이 생존 신호다: %q", got)
	}
	if strings.Contains(got, "assetVersion") {
		t.Fatalf("모르는 판을 실었다: %q", got)
	}
}

// TC-RLC-24 (FR-RLC-20a): 인사는 **되풀이된다.** keepalive 주석을 대신하므로,
// 화면은 그 도착으로 구독이 살아 있음을 안다 — 주석은 EventSource 가 이벤트로
// 발화하지 않아 관측할 수 없다.
func TestHandleCommandSSE_HelloRepeats(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir(), StaticFS: fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte(`<script src="js/core/main.js?v=__ASSETV__"></script>`)},
	}}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// 주기를 시험이 기다릴 수 있는 길이로 줄인다 — 15초를 그대로 기다릴 수는 없다.
	srv.helloEvery = 50 * time.Millisecond
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/commands/sse")
	if err != nil {
		t.Fatalf("GET SSE: %v", err)
	}
	defer resp.Body.Close()

	// 첫 인사 + 되풀이 하나를 읽는다.
	seen := 0
	deadline := time.Now().Add(3 * time.Second)
	buf := make([]byte, 4096)
	for seen < 2 && time.Now().Before(deadline) {
		n, err := resp.Body.Read(buf)
		if err != nil {
			break
		}
		seen += strings.Count(string(buf[:n]), `"action":"server_hello"`)
	}
	if seen < 2 {
		t.Fatalf("인사가 되풀이되지 않는다: %d회", seen)
	}
}

// 주석 keepalive 는 인사가 대신한다 — 둘 다 보내면 오가는 양만 는다.
func TestHandleCommandSSE_NoKeepComment(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir(), StaticFS: fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte(`<script src="js/core/main.js?v=__ASSETV__"></script>`)},
	}}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	srv.helloEvery = 50 * time.Millisecond
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/commands/sse")
	if err != nil {
		t.Fatalf("GET SSE: %v", err)
	}
	defer resp.Body.Close()

	buf := make([]byte, 4096)
	got := ""
	deadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(deadline) {
		n, err := resp.Body.Read(buf)
		if err != nil {
			break
		}
		got += string(buf[:n])
		if strings.Count(got, "server_hello") >= 2 {
			break
		}
	}
	if strings.Contains(got, ": keep") {
		t.Errorf("주석 keepalive 가 남아 있다: %q", got)
	}
}
