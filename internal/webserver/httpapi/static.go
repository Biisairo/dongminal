package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"sync"
)

// staticHandler 는 정적 자산에 **내용 기반 ETag** 를 붙인다.
//
// go:embed 로 담긴 파일은 ModTime 이 zero 여서 http.FileServer 가 Last-Modified 를
// 붙이지 못한다. 검증자가 하나도 없으면 브라우저는 heuristic 으로 캐시하고, 새
// 빌드를 띄워도 옛 JS 가 계속 돈다 — 실제로 그 혼란이 있었다 (Add 다이얼로그가
// 바뀌었는데 브라우저 프롬프트가 떴다).
//
// 해시는 파일당 한 번만 계산해 기억한다. 자산은 바이너리에 박혀 있어 프로세스가
// 사는 동안 바뀌지 않으므로, 무효화 걱정 없이 캐시할 수 있다.
type staticHandler struct {
	fsys fs.FS
	next http.Handler

	mu    sync.RWMutex
	etags map[string]string
}

func newStaticHandler(fsys fs.FS) http.Handler {
	return &staticHandler{fsys: fsys, next: http.FileServer(http.FS(fsys)), etags: map[string]string{}}
}

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
	h.next.ServeHTTP(w, r)
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
		name = path.Join(name, "index.html")
	}
	if !fs.ValidPath(name) {
		return ""
	}
	h.mu.RLock()
	tag, ok := h.etags[name]
	h.mu.RUnlock()
	if ok {
		return tag
	}
	tag = hashFile(h.fsys, name)
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
	// 약한 검증자가 아니다 — 바이트가 같아야 같다.
	return `"` + hex.EncodeToString(sum.Sum(nil))[:32] + `"`
}
