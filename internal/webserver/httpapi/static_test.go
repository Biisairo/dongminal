package httpapi

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

// `go:embed` 로 담긴 파일은 ModTime 이 zero 여서 http.FileServer 가 Last-Modified 를
// 붙이지 못하고, ETag 도 없다. 검증자가 없으면 브라우저는 heuristic 으로 캐시하고
// **새 빌드를 띄워도 옛 JS 가 돈다** — 실제로 그 혼란이 있었다.
// **인자가 `fs.FS` 다.** 종전에는 `fstest.MapFS` 였고, 그러면 세는 FS 를 끼울 수
// 없다 — `Open` 횟수가 이 묶음의 측정이다 (PERFORMANCE_HARDENING_SRS FR-PRF-52).
func staticTestServer(t *testing.T, files fs.FS) http.Handler {
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

// CSP 에 외부 호스트가 **하나도 없다** (MONACO_VENDORING_SRS FR-MVN-13).
//
// 종전에는 이 검사가 "하나이고 그것이 무엇인지 안다" 를 쟀다 — Monaco 를 CDN 에서
// 받았기 때문이다. 벤더링이 끝났으므로 아는 목록이 비었다. 새 외부 호스트가
// 들어오면 여기서 먼저 걸린다.
func TestStatic_CSPExternalHostsAreKnown(t *testing.T) {
	csp := cspFor(nil)
	if strings.Contains(csp, "https://") || strings.Contains(csp, "http://") {
		t.Fatalf("CSP 에 외부 호스트가 있다: %s", csp)
	}
}

// TC-MVN-10: 인라인을 통째로 여는 문은 열지 않는다.
//
// `'unsafe-inline'` 을 켜면 `FE-1`(터미널 출력 → 상태바 XSS)의 2차 방어가 통째로
// 사라진다. 선주입 스크립트는 **해시로** 허용한다.
func TestStatic_CSPHasNoUnsafeInlineScript(t *testing.T) {
	csp := cspFor([]byte("<script>var a=1</script>"))
	scriptSrc, _, _ := strings.Cut(strings.TrimPrefix(csp, "default-src 'self'; "), "; ")
	if strings.Contains(scriptSrc, "unsafe-inline") {
		t.Fatalf("script-src 에 unsafe-inline 이 있다: %s", scriptSrc)
	}
}

// TC-MVN-10a: 해시의 개수가 인라인 스크립트의 개수와 같다 (FR-MVN-13a).
//
// **이것이 첫 페인트를 지키는 검사다.** `script-src 'self'` 만으로는 head 의
// 선주입 스크립트가 막히고, 막히면 저장된 테마가 첫 페인트에 반영되지 않는다
// (BOOT_SCREEN_SRS FR-BTS-3 · `boot-screen.spec.ts` V-1·V-3).
func TestStatic_CSPHashesEveryInlineScript(t *testing.T) {
	doc := []byte("<head><script>var a=1</script>\n<script>var b=2</script>\n" +
		`<script src="js/app.js"></script></head>`)
	csp := cspFor(doc)
	if got := strings.Count(csp, "'sha256-"); got != 2 {
		t.Fatalf("해시가 %d개다 — 인라인 스크립트는 2개다: %s", got, csp)
	}
}

// TC-MVN-10b: 인라인 스크립트가 바뀌면 해시도 바뀐다. 두 벌이 될 수 없다는 뜻이다.
func TestStatic_CSPHashFollowsContent(t *testing.T) {
	a := cspFor([]byte("<script>var a=1</script>"))
	b := cspFor([]byte("<script>var a=2</script>"))
	if a == b {
		t.Fatalf("내용이 다른데 해시가 같다: %s", a)
	}
}

// **저장소의 진짜 `index.html`** 로도 같은 것을 잰다. 위의 셋은 규칙을 재고,
// 이것은 그 규칙이 실제 문서에 닿는지를 잰다.
func TestStatic_CSPCoversRealIndex(t *testing.T) {
	doc, err := os.ReadFile(filepath.Join("..", "..", "..", "web", indexPage))
	if err != nil {
		t.Skipf("index.html 을 읽지 못했다: %v", err)
	}
	want := bytes.Count(doc, []byte("<script>"))
	if want == 0 {
		t.Fatal("index.html 에 인라인 스크립트가 없다 — 이 검사의 전제가 바뀌었다")
	}
	if got := strings.Count(cspFor(doc), "'sha256-"); got != want {
		t.Fatalf("해시 %d개 · 인라인 스크립트 %d개 — 첫 페인트가 막힌다", got, want)
	}
}

// ── 사전압축 자산 (MONACO_VENDORING_SRS 묶음 Z) ─────────────────────────────
//
// `go:embed` 는 압축하지 않고 릴리스는 raw 바이너리를 그대로 올린다. Monaco 의
// `min/vs` 는 raw 23.3MB·gzip 5.4MB 이며, 그 차이가 사용자가 받는 파일에 실린다.
// 그래서 담긴 채로 내보낸다 — 아래가 그 규약이다.

// gzBytes 는 검사용 사전압축 본문을 만든다.
func gzBytes(t *testing.T, plain string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(plain)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// precompressedFS 는 `.gz` 하나와, 비교용 평문 자산 하나를 든다.
func precompressedFS(t *testing.T, plain string) fstest.MapFS {
	t.Helper()
	return fstest.MapFS{
		"index.html":                                 &fstest.MapFile{Data: []byte("<html></html>")},
		"vendor/monaco/vs/loader.js.gz":              &fstest.MapFile{Data: gzBytes(t, plain)},
		"vendor/monaco/vs/editor/editor.main.css.gz": &fstest.MapFile{Data: gzBytes(t, "body{}")},
		"vendor/xterm.js":                            &fstest.MapFile{Data: []byte("xterm\n")},
	}
}

// TC-MVN-1: gzip 을 밝히면 **담긴 채로** 나가고, 형식은 `.gz` 를 뗀 이름으로 정해진다.
func TestStatic_PrecompressedServedAsGzip(t *testing.T) {
	const plain = "define('loader',[],function(){})\n"
	h := staticTestServer(t, precompressedFS(t, plain))

	req := apiTestRequest(http.MethodGet, "/vendor/monaco/vs/loader.js", nil)
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	// `application/gzip` 이 나가면 브라우저가 스크립트로 실행하지 않는다 (FR-MVN-7).
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("Content-Type = %q, want text/javascript…", ct)
	}
	zr, err := gzip.NewReader(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("본문이 gzip 이 아니다: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("본문 해제 실패: %v", err)
	}
	if string(got) != plain {
		t.Fatalf("해제한 본문이 다르다: %q", got)
	}
}

// TC-MVN-2·3: gzip 을 밝히지 않으면 **서버가 풀어서** 준다.
//
// 이 폴백이 없으면 브라우저 아닌 클라이언트가 깨진 바이트를 받고 그 사실을 모른다.
func TestStatic_PrecompressedFallsBackToPlain(t *testing.T) {
	const plain = "define('loader',[],function(){})\n"
	h := staticTestServer(t, precompressedFS(t, plain))

	for _, ae := range []string{"", "identity", "gzip;q=0", "br"} {
		req := apiTestRequest(http.MethodGet, "/vendor/monaco/vs/loader.js", nil)
		if ae != "" {
			req.Header.Set("Accept-Encoding", ae)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("Accept-Encoding=%q: code = %d", ae, rec.Code)
		}
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Fatalf("Accept-Encoding=%q: Content-Encoding = %q, want 없음", ae, got)
		}
		if rec.Body.String() != plain {
			t.Fatalf("Accept-Encoding=%q: 본문이 평문이 아니다: %q", ae, rec.Body.String())
		}
	}
}

// TC-MVN-4·5: 한 URL 이 두 표현을 가지므로 `Vary` 가 그것을 밝히고, ETag 는 둘이 같다.
func TestStatic_PrecompressedVaryAndETag(t *testing.T) {
	h := staticTestServer(t, precompressedFS(t, "x\n"))

	get := func(ae string) *httptest.ResponseRecorder {
		req := apiTestRequest(http.MethodGet, "/vendor/monaco/vs/loader.js", nil)
		if ae != "" {
			req.Header.Set("Accept-Encoding", ae)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	zipped, plain := get("gzip"), get("")
	for _, rec := range []*httptest.ResponseRecorder{zipped, plain} {
		if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
			t.Fatalf("Vary = %q, want Accept-Encoding", got)
		}
		if rec.Header().Get("ETag") == "" {
			t.Fatal("ETag 가 없다")
		}
	}
	if a, b := zipped.Header().Get("ETag"), plain.Header().Get("ETag"); a != b {
		t.Fatalf("ETag 가 표현마다 다르다: %q vs %q", a, b)
	}
}

// TC-MVN-6: `.gz` 를 직접 요청해도 숨기지 않는다 — 숨기면 규칙이 둘이 된다.
func TestStatic_PrecompressedRawPathStillServed(t *testing.T) {
	h := staticTestServer(t, precompressedFS(t, "x\n"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, apiTestRequest(http.MethodGet, "/vendor/monaco/vs/loader.js.gz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q — 직접 요청은 그냥 파일이다", got)
	}
}

// TC-MVN-7: `.gz` 가 없는 자산의 응답은 바뀌지 않는다 (회귀).
func TestStatic_PlainAssetsUnchanged(t *testing.T) {
	h := staticTestServer(t, precompressedFS(t, "x\n"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, apiTestRequest(http.MethodGet, "/vendor/xterm.js", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want 없음", got)
	}
	if rec.Body.String() != "xterm\n" {
		t.Fatalf("본문 = %q", rec.Body.String())
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatal("ETag 가 사라졌다")
	}
}

// TC-MVN-8: 형식은 확장자마다 제대로 갈린다.
func TestStatic_PrecompressedContentTypeByExt(t *testing.T) {
	h := staticTestServer(t, precompressedFS(t, "x\n"))
	req := apiTestRequest(http.MethodGet, "/vendor/monaco/vs/editor/editor.main.css", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/css") {
		t.Fatalf("Content-Type = %q, want text/css…", ct)
	}
}

// FR-MVN-7 (2026-09-11, Windows CI 가 잡았다) — **형식은 우리가 정한다.**
//
// `mime.TypeByExtension` 에 맡기면 호스트의 설정이 응답을 정한다. Windows 는
// 레지스트리(`HKCR\.js`)를 먼저 읽고 그 값이 `application/javascript` 여서, 같은
// 코드가 러너에서만 다른 형식을 내보냈다. 이 검사는 그 의존을 막는다.
func TestContentTypeFor_IsHostIndependent(t *testing.T) {
	cases := map[string]string{
		"app.js":     "text/javascript; charset=utf-8",
		"APP.JS":     "text/javascript; charset=utf-8", // 확장자는 대소문자를 가리지 않는다
		"style.css":  "text/css; charset=utf-8",
		"index.html": "text/html; charset=utf-8",
		"icon.svg":   "image/svg+xml",
		"f.woff2":    "font/woff2",
	}
	for name, want := range cases {
		if got := contentTypeFor(name); got != want {
			t.Errorf("contentTypeFor(%q) = %q, want %q", name, got, want)
		}
	}
	// 우리 자산이 아닌 것은 종전대로다 — 모르면 octet-stream 이고 sniff 에 맡기지
	// 않는다.
	if got := contentTypeFor("x.unknown-ext-xyz"); got != "application/octet-stream" {
		t.Errorf("모르는 확장자 = %q", got)
	}
}

// ── 성능: 자산 바이트 캐시와 etag 음수 캐시 (PERFORMANCE_HARDENING_SRS 묶음 P-C) ──

// countingFS 는 `Open` 을 이름별로 센다. **셀 수 있는 수**만 게이트가 된다
// (FR-PRF-3) — 벽시계는 이 기계의 것이고 `Open` 횟수는 어디서 재도 같다.
type countingFS struct {
	fs.FS
	mu    sync.Mutex
	opens map[string]int
}

func newCountingFS(inner fs.FS) *countingFS {
	return &countingFS{FS: inner, opens: map[string]int{}}
}

func (c *countingFS) Open(name string) (fs.File, error) {
	c.mu.Lock()
	c.opens[name]++
	c.mu.Unlock()
	return c.FS.Open(name)
}

// **`Stat` 을 위임한다.** 두지 않으면 `fs.Stat` 이 `Open`+`Stat` 으로 물러서고,
// 그러면 `gzName` 의 존재 확인 둘이 읽기로 잡혀 **재려던 것과 다른 것을 센다**
// (첫 판이 요청 5회에 7을 봤다 — 그중 다섯이 Stat 이었다).
func (c *countingFS) Stat(name string) (fs.FileInfo, error) { return fs.Stat(c.FS, name) }

func (c *countingFS) count(name string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.opens[name]
}

// TC-PRF-14: 같은 `.gz` 자산을 N번 요청해도 **파일은 한 번만 읽는다** (FR-PRF-50~52).
//
// 종전에는 요청마다 `fs.ReadFile` 로 전체를 힙에 복사했다. Monaco 의 `min/vs` 는
// raw 23.3MB·gzip 5.4MB 이고 콜드 페이지 로드는 수십 개의 청크를 받는다 — 매 요청이
// 자기 크기만큼 힙을 잡았다 버렸다 (`AUDIT-go-http.md` P-1).
func TestStatic_PrecompressedReadsFileOnce(t *testing.T) {
	const plain = "define('loader',[],function(){})\n"
	cfs := newCountingFS(precompressedFS(t, plain))
	h := staticTestServer(t, cfs)

	const name = "vendor/monaco/vs/loader.js.gz"
	for i := 0; i < 5; i++ {
		req := apiTestRequest(http.MethodGet, "/vendor/monaco/vs/loader.js", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%d회차 code = %d", i, rec.Code)
		}
	}
	// ETag 계산이 첫 회차에 한 번 더 연다 — 그쪽도 캐시가 있으므로 한 번이다.
	if got := cfs.count(name); got > 2 {
		t.Fatalf("%s 를 %d번 열었다 — 요청마다 읽고 있다 (FR-PRF-52)", name, got)
	}
}

// TC-PRF-15: 캐시가 서도 **비gzip 클라이언트는 같은 바이트**를 받는다 (FR-MVN-8 회귀).
func TestStatic_PrecompressedCacheKeepsPlainFallback(t *testing.T) {
	const plain = "define('loader',[],function(){})\n"
	h := staticTestServer(t, newCountingFS(precompressedFS(t, plain)))

	for i := 0; i < 3; i++ {
		req := apiTestRequest(http.MethodGet, "/vendor/monaco/vs/loader.js", nil)
		req.Header.Set("Accept-Encoding", "identity")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%d회차 code = %d", i, rec.Code)
		}
		if enc := rec.Header().Get("Content-Encoding"); enc != "" {
			t.Fatalf("%d회차 Content-Encoding = %q, want 없음", i, enc)
		}
		if rec.Body.String() != plain {
			t.Fatalf("%d회차 본문이 다르다: %q", i, rec.Body.String())
		}
	}
}

// TC-PRF-16: **없는 경로는 기억하지 않는다** (FR-PRF-53).
//
// 키가 요청 URL 에서 오므로 종전에는 `/a1`, `/a2`, … 를 되풀이하면 맵이 요청 수만큼
// 자랐다. 상한도 만료도 없었다 (`AUDIT-go-http.md` P-2).
func TestStatic_ETagDoesNotCacheMisses(t *testing.T) {
	h, ok := newStaticHandler(fstest.MapFS{
		"js/app.js": &fstest.MapFile{Data: []byte("console.log(1)\n")},
	}, "v1").(*staticHandler)
	if !ok {
		t.Fatal("newStaticHandler 가 *staticHandler 를 주지 않는다")
	}

	const n = 1000
	for i := 0; i < n; i++ {
		h.etagFor("/no-such-" + strconv.Itoa(i) + ".js")
	}
	h.mu.RLock()
	got := len(h.etags)
	h.mu.RUnlock()
	if got != 0 {
		t.Fatalf("없는 경로 %d개 뒤 etags 항목 %d개 — 요청자가 키를 정하는 캐시다 (FR-PRF-54)", n, got)
	}

	// TC-PRF-17: 있는 자산은 **여전히** 기억한다 — 고치려던 것은 음수 캐시뿐이다.
	if tag := h.etagFor("/js/app.js"); tag == "" {
		t.Fatal("있는 자산의 ETag 가 비었다")
	}
	h.mu.RLock()
	got = len(h.etags)
	h.mu.RUnlock()
	if got != 1 {
		t.Fatalf("있는 자산 하나 뒤 etags 항목 %d개, want 1", got)
	}
}

// 벽시계가 아니라 **할당**을 기록한다 (FR-PRF-3 · TC-PRF-28). CI 는 이것을 강제하지
// 않는다 — 기록은 커밋 메시지와 `PERFORMANCE_BUDGET.md` 에 남는다.
func BenchmarkStaticPrecompressed(b *testing.B) {
	// **잘 안 눌리는 바이트여야 한다.** 같은 줄을 8,000번 되풀이하면 gzip 이
	// 수백 바이트로 줄어들어, 캐시가 없애는 읽기가 측정에 보이지 않는다
	// (첫 판이 4,584 → 3,880 B/op 을 봤고 그것은 담긴 바이트가 작았기 때문이다).
	// Monaco 청크는 40KB 안팎이므로 그 자릿수를 맞춘다.
	var sb strings.Builder
	for i := 0; i < 20000; i++ {
		sb.WriteString("var v" + strconv.Itoa(i*7919%1000003) + "=" + strconv.Itoa(i*104729%999983) + ";\n")
	}
	plain := sb.String()
	fsys := fstest.MapFS{
		"index.html":                    &fstest.MapFile{Data: []byte("<html></html>")},
		"vendor/monaco/vs/loader.js.gz": &fstest.MapFile{Data: gzBytesB(b, plain)},
	}
	h := newStaticHandler(fsys, "v1")
	req := httptest.NewRequest(http.MethodGet, "/vendor/monaco/vs/loader.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	// **본문을 버린다.** `httptest.NewRecorder()` 는 본문을 버퍼에 쌓으므로 그
	// 할당이 재려는 것을 덮는다 (첫 판이 674KB → 527KB 를 봤고 그 527KB 의 대부분이
	// 기록기의 것이었다).
	w := &discardWriter{h: http.Header{}}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.ServeHTTP(w, req)
	}
}

// 응답을 버리는 최소 ResponseWriter. 재려는 것은 **서버가 무는 할당**이다.
type discardWriter struct{ h http.Header }

func (d *discardWriter) Header() http.Header         { return d.h }
func (d *discardWriter) Write(p []byte) (int, error) { return len(p), nil }
func (d *discardWriter) WriteHeader(int)             {}

func gzBytesB(b *testing.B, s string) []byte {
	b.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(s)); err != nil {
		b.Fatalf("gzip write: %v", err)
	}
	if err := zw.Close(); err != nil {
		b.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}
