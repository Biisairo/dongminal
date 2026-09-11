package httpapi

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// staticHandler 는 정적 자산에 **내용 기반 ETag** 를 붙인다.
//
// `go:embed` 로 담긴 파일은 ModTime 이 zero 여서 http.FileServer 가 Last-Modified 를
// 붙이지 못한다. 검증자가 하나도 없으면 브라우저는 heuristic 으로 캐시하고, 새
// 빌드를 띄워도 옛 JS 가 계속 돈다 — 실제로 그 혼란이 있었다 (Add 다이얼로그가
// 바뀌었는데 브라우저 프롬프트가 떴다).
//
// 해시는 파일당 한 번만 계산해 기억한다. 자산은 바이너리에 박혀 있어 프로세스가
// 사는 동안 바뀌지 않으므로, 무효화 걱정 없이 캐시할 수 있다.
//
// 그리고 `index.html` 의 **자리표시자를 판으로 치환해** 내보낸다
// (ASSET_VERSION_SINGLE_SOURCE_SRS FR-AVS-5). 문서가 판을 손으로 적지 않게 되면서,
// 그것을 채우는 일이 이 자리로 왔다.
type staticHandler struct {
	fsys fs.FS
	next http.Handler

	// csp 는 이 자산 집합에 맞춘 Content-Security-Policy 다.
	//
	// **정적이지 않은 이유는 head 선주입 스크립트 둘이다** (FR-MVN-13a). 그것은
	// 인라인이어야 하고(`BOOT_SCREEN_SRS` NFR-1: 네트워크에 닿지 않는다),
	// `'unsafe-inline'` 은 켤 수 없다(그러면 `FE-1` 의 2차 방어가 사라진다).
	// 남는 길은 해시이며, 해시는 **서빙되는 바이트에서** 계산해야 어긋나지 않는다.
	csp string

	// index 는 치환을 마친 `index.html` 이다. 요청마다 만들지 않는다 — 자산도 판도
	// 프로세스가 사는 동안 그대로다. 문서를 읽지 못했으면 nil 이고, 그때는
	// FileServer 가 평소대로 답한다 (404).
	index     []byte
	indexETag string

	mu    sync.RWMutex
	etags map[string]string
}

func newStaticHandler(fsys fs.FS, version string) http.Handler {
	h := &staticHandler{fsys: fsys, next: http.FileServer(http.FS(fsys)), etags: map[string]string{}}
	if b, err := fs.ReadFile(fsys, indexPage); err == nil {
		h.index = []byte(strings.ReplaceAll(string(b), assetVerPlaceholder, version))
		h.indexETag = hashBytes(h.index)
	}
	h.csp = cspFor(h.index)
	return h
}

// inlineScriptRe 는 **속성이 없는** `<script>` 블록을 집는다 (FR-MVN-13b).
//
// 속성이 붙은 인라인 스크립트는 일부러 놓친다 — 그것은 막히고, 막히면 보인다.
// 조용히 허용되는 것보다 낫다.
var inlineScriptRe = regexp.MustCompile(`(?s)<script>(.*?)</script>`)

// cspFor 는 서빙될 `index.html` 에 맞춘 정책을 만든다.
//
// head 선주입 스크립트 둘(테마 변수·사이드바 너비)은 첫 페인트 **이전에** 돌아야
// 하므로 외부 파일로 뺄 수 없다 (`BOOT_SCREEN_SRS` FR-BTS-3·NFR-1). 그 둘의
// 해시를 `script-src` 에 실어 **그것만** 허용한다.
//
// `index` 가 비면(문서를 읽지 못한 구성) 해시 없는 정책이다 — 그때는 선주입도
// 없다.
func cspFor(index []byte) string {
	var b strings.Builder
	b.WriteString("default-src 'self'; script-src 'self'")
	for _, m := range inlineScriptRe.FindAllSubmatch(index, -1) {
		sum := sha256.Sum256(m[1])
		b.WriteString(" 'sha256-")
		b.WriteString(base64.StdEncoding.EncodeToString(sum[:]))
		b.WriteString("'")
	}
	b.WriteString("; ")
	b.WriteString(cspRest)
	return b.String()
}

// 보안 헤더 (04-secops §4.3 · 02-fe-arch 의 P0 2차 방어).
//
// **CSP 는 마크업 이스케이프의 대체가 아니라 그 뒤의 그물이다.** 앞의 방어는
// `scripts/check-html.sh` 가 지키고, 여기는 그것이 언젠가 새는 날을 위한 것이다.
//
// **외부 출처가 하나도 없다.** 종전에는 `script-src` 를 비롯한 넷에
// `https://cdn.jsdelivr.net` 이 열려 있었다 — Monaco 편집기만 런타임에 CDN 에서
// 받았기 때문이다. 이제 그것도 `web/vendor/monaco` 에 있다
// (MONACO_VENDORING_SRS FR-MVN-12). 새 외부 호스트가 들어오면
// `TestStatic_CSPExternalHostsAreKnown` 이 먼저 실패한다.
//
// `'unsafe-inline'` 이 style 에 남는 것은 앱이 스타일을 계산해 넣기 때문이다
// (테마·레이아웃). 그것을 없애려면 nonce 를 자산 판마다 심어야 하고, 그 값이
// 스타일 계산 경로 전체를 지나야 한다.
//
// cspRest 는 `script-src` 를 뺀 나머지다. `script-src` 만 문서에 따라 달라진다
// (FR-MVN-13a) — 나머지는 고정이므로 여기 그대로 둔다.
const cspRest = "style-src 'self' 'unsafe-inline'; " +
	"font-src 'self' data:; " +
	"img-src 'self' data: blob:; " +
	"connect-src 'self' ws: wss:; " +
	"worker-src 'self' blob:; " +
	"frame-ancestors 'none'; " +
	"base-uri 'self'; " +
	"form-action 'self'"

func setSecurityHeaders(w http.ResponseWriter, csp string) {
	h := w.Header()
	h.Set("Content-Security-Policy", csp)
	// `frame-ancestors` 를 모르는 브라우저를 위한 같은 뜻의 옛 헤더.
	h.Set("X-Frame-Options", "DENY")
	// 추론된 MIME 으로 실행되는 것을 막는다. `/api/file/raw` 가 이미 이 함정을
	// 개별로 피하고 있었다 (`handlers_file_probe.go`).
	h.Set("X-Content-Type-Options", "nosniff")
	// 이 앱의 URL 에는 경로와 도구 id 가 들어간다. 밖으로 나갈 이유가 없다.
	h.Set("Referrer-Policy", "no-referrer")
}

// 사전압축 자산의 접미사. 저장소에 담기는 이름은 `<논리 경로>.gz` 다.
const gzSuffix = ".gz"

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setSecurityHeaders(w, h.csp)
	if tag := h.etagFor(r.URL.Path); tag != "" {
		w.Header().Set("ETag", tag)
	}
	// HTML 은 항상 재검증한다. ETag 만 있고 Cache-Control 이 없으면 브라우저는
	// heuristic freshness 로 재검증을 건너뛸 수 있고, 그러면 새 빌드를 띄워도
	// index.html 이 옛 `?v=` 를 가리켜 옛 JS 가 계속 돈다. 나머지 자산은 `?v=`
	// 로 무효화되므로 ETag 만으로 충분하다.
	if isHTMLPath(r.URL.Path) {
		w.Header().Set("Cache-Control", "no-cache")
	}
	// 치환본을 직접 내는 경로는 루트 하나다. `/index.html` 은 FileServer 가 예전처럼
	// `./` 로 301 을 주며 (FR-AVS-6), 따라가면 여기에 닿는다.
	if h.index != nil && r.URL.Path == "/" {
		http.ServeContent(w, r, indexPage, time.Time{}, bytes.NewReader(h.index))
		return
	}
	if h.servePrecompressed(w, r) {
		return
	}
	h.next.ServeHTTP(w, r)
}

// gzName 은 논리 경로에 대응하는 사전압축 자산의 이름이다. 없으면 빈 값이다.
//
// **논리 경로에 실제 파일이 있으면 그쪽이 진실이다** — 둘 다 있는 상태를 만들지
// 않는 것이 규약이지만(FR-MVN-5), 만들어졌다면 평문이 이긴다. 그래야 `.gz` 하나가
// 낡은 채 남았을 때 화면이 낡은 것을 보여 주지 않는다.
func (h *staticHandler) gzName(urlPath string) string {
	name := strings.TrimPrefix(path.Clean(urlPath), "/")
	if name == "" || !fs.ValidPath(name) {
		return ""
	}
	if _, err := fs.Stat(h.fsys, name); err == nil {
		return ""
	}
	gz := name + gzSuffix
	if st, err := fs.Stat(h.fsys, gz); err != nil || st.IsDir() {
		return ""
	}
	return gz
}

// servePrecompressed 는 `.gz` 로 담긴 자산을 낸다 (MONACO_VENDORING_SRS 묶음 Z).
//
// `go:embed` 는 압축하지 않고 릴리스는 raw 바이너리를 그대로 올린다. Monaco 의
// `min/vs` 는 raw 23.3MB·gzip 5.4MB 이고, 그 차이가 배포본에 그대로 실린다 —
// 그래서 **담긴 채로 내보낸다.**
//
// 규칙은 monaco 전용이 아니다. `.gz` 를 갖는 자산이 지금 그것뿐인 것과, 규칙이
// 그것만 아는 것은 다르다 (FR-MVN-6).
func (h *staticHandler) servePrecompressed(w http.ResponseWriter, r *http.Request) bool {
	gz := h.gzName(r.URL.Path)
	if gz == "" {
		return false
	}
	data, err := fs.ReadFile(h.fsys, gz)
	if err != nil {
		return false
	}
	head := w.Header()
	// **`.gz` 를 뗀 이름으로 정한다.** 확장자를 그대로 보면 `application/gzip` 이
	// 나가고, 브라우저는 그것을 스크립트로 실행하지 않는다 (FR-MVN-7).
	head.Set("Content-Type", contentTypeFor(strings.TrimSuffix(gz, gzSuffix)))
	// 같은 URL 이 두 표현을 갖는다. 중간 캐시가 한쪽 답을 다른 쪽에 주지 않게 한다
	// (FR-MVN-9). ETag 는 **담긴 바이트**의 것이며 둘이 같다 (FR-MVN-10).
	head.Set("Vary", "Accept-Encoding")
	if acceptsGzip(r) {
		head.Set("Content-Encoding", "gzip")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
		return true
	}
	// gzip 을 밝히지 않은 클라이언트에는 **풀어서** 준다. 이 폴백을 생략하면
	// 브라우저 아닌 클라이언트가 깨진 바이트를 받고 그 사실을 모른다 (FR-MVN-8).
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "corrupt asset", http.StatusInternalServerError)
		return true
	}
	defer zr.Close()
	plain, err := io.ReadAll(zr)
	if err != nil {
		http.Error(w, "corrupt asset", http.StatusInternalServerError)
		return true
	}
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(plain))
	return true
}

// staticTypes 는 **우리가 내보내는 자산의 형식을 우리가 정한다** (FR-MVN-7).
//
// `mime.TypeByExtension` 에 맡기면 **호스트의 설정이 응답을 정한다.** Windows 는
// 레지스트리(`HKCR\.js`)를 먼저 읽고 그 값이 `application/javascript` 여서, 같은
// 코드가 러너에서만 다른 형식을 내보냈다 (Windows CI 실측, 2026-09-11). 형식이
// 호스트마다 다르면 그것을 재는 검사도 호스트마다 다른 답을 받는다.
//
// 여기 적힌 것만 우리 자산이다. 그 밖은 아래에서 종전대로 표준 테이블을 본다.
var staticTypes = map[string]string{
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".html":  "text/html; charset=utf-8",
	".json":  "application/json",
	".svg":   "image/svg+xml",
	".woff2": "font/woff2",
	".map":   "application/json",
}

// contentTypeFor 는 확장자로 형식을 정한다. 모르는 확장자는 sniff 에 맡기지 않는다 —
// 응답에 `X-Content-Type-Options: nosniff` 가 이미 붙어 있다.
func contentTypeFor(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if ct, ok := staticTypes[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// acceptsGzip 은 `Accept-Encoding` 을 토큰으로 읽는다.
//
// `strings.Contains` 로 보지 않는 이유는 `gzip;q=0` 하나다 — 그것은 "받지
// 않겠다" 는 뜻이고, 그때 압축본을 보내면 클라이언트가 깨진 바이트를 받는다.
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		switch strings.ToLower(strings.TrimSpace(fields[0])) {
		case "gzip", "x-gzip", "*":
		default:
			continue
		}
		if qZero(fields[1:]) {
			continue
		}
		return true
	}
	return false
}

func qZero(params []string) bool {
	for _, p := range params {
		v, ok := strings.CutPrefix(strings.ToLower(strings.TrimSpace(p)), "q=")
		if !ok {
			continue
		}
		if q, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && q <= 0 {
			return true
		}
	}
	return false
}

func isHTMLPath(p string) bool {
	return p == "/" || strings.HasSuffix(p, "/") || strings.HasSuffix(p, ".html")
}

// etagFor 는 경로의 내용 해시를 준다. 디렉터리·없는 파일은 빈 값이며, 그때는
// FileServer 가 평소대로 답한다 (디렉터리 목록·404).
func (h *staticHandler) etagFor(urlPath string) string {
	name := strings.TrimPrefix(path.Clean(urlPath), "/")
	// FileServer 는 디렉터리에 index.html 을 준다 — 그 내용으로 판정해야 한다.
	if name == "" || strings.HasSuffix(urlPath, "/") {
		name = path.Join(name, indexPage)
	}
	if !fs.ValidPath(name) {
		return ""
	}
	// 문서는 **치환된 것**이 나간다. 원본으로 판정하면 JS 만 고친 빌드에서 검증자가
	// 그대로여서 브라우저가 304 를 받고, 옛 `?v=` 를 가리키는 옛 HTML 이 남는다 —
	// `?v=` 를 올리지 않았을 때와 같은 증상이다 (FR-AVS-7).
	if name == indexPage && h.indexETag != "" {
		return h.indexETag
	}
	h.mu.RLock()
	tag, ok := h.etags[name]
	h.mu.RUnlock()
	if ok {
		return tag
	}
	tag = hashFile(h.fsys, name)
	// 사전압축 자산은 논리 경로에 파일이 없다. 검증자는 **담긴 바이트**의 것이며,
	// 압축 여부와 무관하게 같다 (FR-MVN-10).
	if tag == "" {
		tag = hashFile(h.fsys, name+gzSuffix)
	}
	h.mu.Lock()
	h.etags[name] = tag
	h.mu.Unlock()
	return tag
}

func hashFile(fsys fs.FS, name string) string {
	f, err := fsys.Open(name)
	if err != nil {
		return ""
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || st.IsDir() {
		return ""
	}
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return ""
	}
	return etagOf(sum.Sum(nil))
}

func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return etagOf(sum[:])
}

// 약한 검증자가 아니다 — 바이트가 같아야 같다.
func etagOf(sum []byte) string { return `"` + hex.EncodeToString(sum)[:32] + `"` }
