package httpapi

import (
	"net/http"
	"net/http/httptest"
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
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/js/app.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("ETag 가 없다 — 브라우저가 옛 자산을 계속 쓴다")
	}

	// 같은 ETag 를 되보내면 304 다. 본문을 다시 실어 보내면 검증자를 붙인 뜻이 없다.
	req := httptest.NewRequest(http.MethodGet, "/js/app.js", nil)
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
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/js/app.js", nil))
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
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ping", nil))
	if rec.Header().Get("ETag") != "" {
		t.Fatalf("API 에 ETag 가 붙었다: %q", rec.Header().Get("ETag"))
	}
}
