package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// `go:embed` 로 담긴 파일은 ModTime 이 zero 여서 http.FileServer 가 Last-Modified 를
// 붙이지 못하고, ETag 도 없다. 검증자가 없으면 브라우저는 heuristic 으로 캐시하고
// **새 빌드를 띄워도 옛 JS 가 돈다** — 실제로 그 혼란이 있었다.
func staticTestServer(t *testing.T, files fstest.MapFS) http.Handler {
	t.Helper()
	srv, err := New(Config{Port: "0", DataDir: t.TempDir(), StaticFS: files}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv.Handler()
}

func TestStaticAssetsCarryETag(t *testing.T) {
	h := staticTestServer(t, fstest.MapFS{
		"js/app.js": &fstest.MapFile{Data: []byte("console.log(1)\n")},
	})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, apiTestRequest(http.MethodGet, "/js/app.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("ETag 가 없다 — 브라우저가 옛 자산을 계속 쓴다")
	}

	// 같은 ETag 를 되보내면 304 다. 본문을 다시 실어 보내면 검증자를 붙인 뜻이 없다.
	req := apiTestRequest(http.MethodGet, "/js/app.js", nil)
	req.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req)
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("code = %d, want 304", rec2.Code)
	}
	if rec2.Body.Len() != 0 {
		t.Fatalf("304 인데 본문이 있다: %d바이트", rec2.Body.Len())
	}
}

// 내용이 다르면 ETag 도 달라야 한다 — 빌드가 바뀐 것을 브라우저가 알아야 한다.
func TestStaticETagFollowsContent(t *testing.T) {
	get := func(body string) string {
		h := staticTestServer(t, fstest.MapFS{"js/app.js": &fstest.MapFile{Data: []byte(body)}})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, apiTestRequest(http.MethodGet, "/js/app.js", nil))
		return rec.Header().Get("ETag")
	}
	if a, b := get("old\n"), get("new\n"); a == b {
		t.Fatalf("내용이 다른데 ETag 가 같다: %q", a)
	}
}

// API 응답에는 손대지 않는다 — 정적 자산의 규약이다.
func TestStaticETagDoesNotTouchAPI(t *testing.T) {
	h := staticTestServer(t, fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>")}})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, apiTestRequest(http.MethodGet, "/api/ping", nil))
	if rec.Header().Get("ETag") != "" {
		t.Fatalf("API 에 ETag 가 붙었다: %q", rec.Header().Get("ETag"))
	}
}

// 04-secops §4.3 — 정적 응답의 보안 헤더.
//
// CSP 는 마크업 이스케이프의 **대체가 아니라 그 뒤의 그물**이다. 앞의 방어는
// `scripts/check-html.sh` 가 지키고, 이것은 그것이 언젠가 새는 날을 위한 것이다.
func TestStatic_SecurityHeaders(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir(), StaticFS: fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html></html>")},
	}}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp := mustGet(t, ts.URL+"/")
	defer resp.Body.Close()

	for _, want := range []struct{ key, contains string }{
		{"Content-Security-Policy", "default-src 'self'"},
		{"Content-Security-Policy", "frame-ancestors 'none'"},
		{"X-Frame-Options", "DENY"},
		{"X-Content-Type-Options", "nosniff"},
		{"Referrer-Policy", "no-referrer"},
	} {
		if got := resp.Header.Get(want.key); !strings.Contains(got, want.contains) {
			t.Errorf("%s=%q 에 %q 가 없다", want.key, got, want.contains)
		}
	}
}

// `script-src` 에 남은 외부 호스트는 **Monaco 하나**여야 한다.
//
// 이 검사는 "없다" 가 아니라 "하나이고 그것이 무엇인지 안다" 를 잰다. 벤더링이
// 끝나면 이 검사가 먼저 실패하고, 그것이 곧 이 줄을 지울 때가 됐다는 신호다.
func TestStatic_CSPExternalHostsAreKnown(t *testing.T) {
	const monaco = "https://cdn.jsdelivr.net"
	rest := strings.ReplaceAll(contentSecurityPolicy, monaco, "")
	if strings.Contains(rest, "https://") || strings.Contains(rest, "http://") {
		t.Fatalf("CSP 에 모르는 외부 호스트가 있다: %s", contentSecurityPolicy)
	}
	if !strings.Contains(contentSecurityPolicy, "script-src 'self' "+monaco) {
		t.Fatalf("script-src 의 모양이 바뀌었다 — 벤더링이 끝났다면 이 검사를 지워라")
	}
}
