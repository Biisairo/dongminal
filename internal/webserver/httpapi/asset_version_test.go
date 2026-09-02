package httpapi

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"testing/fstest"
)

// ASSET_VERSION_SINGLE_SOURCE_SRS §5 — 자산 판의 단일 출처.
//
// 판은 사람이 적는 수가 아니라 **서빙되는 자산의 내용**이다 (FR-AVS-1). 그래야
// "올리는 것을 잊는다" 는 실패가 존재할 수 없다.

// docWith 는 자리표시자를 쓰는 문서 하나를 만든다 — 실물 `index.html` 과 같은 표기다.
const docWith = `<link rel="stylesheet" href="style.css?v=__ASSETV__">` +
	`<script src="js/core/main.js?v=__ASSETV__"></script>`

func fsWith(files map[string]string) fstest.MapFS {
	m := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(docWith)}}
	for n, b := range files {
		m[n] = &fstest.MapFile{Data: []byte(b)}
	}
	return m
}

// TC-AVS-1 (FR-AVS-1·1a·1b): 판은 JS·CSS 에서 나온다. `vendor/` 와 `index.html` 은
// 그 밖이다 — 하나는 제3자 사본이라 고치는 순간 이름이 바뀌고, 하나는 판을 담는
// 문서라서 넣으면 서로를 물고 늘어진다.
func TestAssetVersionFollowsAssets(t *testing.T) {
	base := computeAssetVersion(fsWith(map[string]string{
		"js/app.js":       "console.log(1)\n",
		"style.css":       "body{}\n",
		"vendor/xterm.js": "/* v1 */\n",
	}))

	for _, tc := range []struct {
		name  string
		files map[string]string
		want  bool // 판이 바뀌어야 하는가
	}{
		{"JS 가 바뀌면", map[string]string{
			"js/app.js": "console.log(2)\n", "style.css": "body{}\n", "vendor/xterm.js": "/* v1 */\n",
		}, true},
		{"CSS 가 바뀌면", map[string]string{
			"js/app.js": "console.log(1)\n", "style.css": "body{color:red}\n", "vendor/xterm.js": "/* v1 */\n",
		}, true},
		{"vendor 가 바뀌면", map[string]string{
			"js/app.js": "console.log(1)\n", "style.css": "body{}\n", "vendor/xterm.js": "/* v2 */\n",
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := computeAssetVersion(fsWith(tc.files))
			if changed := got != base; changed != tc.want {
				t.Fatalf("판이 바뀌었는가 = %v, want %v (%s → %s)", changed, tc.want, base, got)
			}
		})
	}

	t.Run("index.html 이 바뀌어도", func(t *testing.T) {
		m := fsWith(map[string]string{
			"js/app.js": "console.log(1)\n", "style.css": "body{}\n", "vendor/xterm.js": "/* v1 */\n",
		})
		m["index.html"] = &fstest.MapFile{Data: []byte(docWith + "<!-- 주석 -->")}
		if got := computeAssetVersion(m); got != base {
			t.Fatalf("문서가 판을 바꿨다: %s → %s", base, got)
		}
	})
}

// TC-AVS-2 (FR-AVS-1): 내용을 그대로 둔 채 이름만 바꾸는 것도 판의 변화다. 경로를
// 해시에 넣지 않으면 그것이 보이지 않는다.
func TestAssetVersionFollowsNames(t *testing.T) {
	a := computeAssetVersion(fsWith(map[string]string{"js/old.js": "x\n"}))
	b := computeAssetVersion(fsWith(map[string]string{"js/new.js": "x\n"}))
	if a == b {
		t.Fatalf("이름이 바뀌었는데 판이 같다: %s", a)
	}
}

// TC-AVS-8 (FR-AVS-10a): JS·CSS 가 하나도 없어도 판은 있다 — 빈 목록의 해시다.
func TestAssetVersionWithoutAssets(t *testing.T) {
	if v := computeAssetVersion(fsWith(nil)); v == "" {
		t.Fatal("자산이 없다고 판까지 없앴다")
	}
}

var servedVerRe = regexp.MustCompile(`\?v=([0-9a-f]+)`)

func servedIndex(t *testing.T, h http.Handler) string {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / = %d", rec.Code)
	}
	return rec.Body.String()
}

// TC-AVS-3 (FR-AVS-5·8): 서빙된 문서에 자리표시자가 남아서는 안 된다. 남아도 파일
// 서빙은 멀쩡히 되고 캐시 키만 영구히 고정된다 — 조용히 틀리는 종류다.
func TestIndexPlaceholderSubstituted(t *testing.T) {
	files := fsWith(map[string]string{"js/app.js": "console.log(1)\n"})
	body := servedIndex(t, staticTestServer(t, files))

	if strings.Contains(body, assetVerPlaceholder) {
		t.Fatalf("자리표시자가 그대로 나갔다: %q", body)
	}
	want := computeAssetVersion(files)
	m := servedVerRe.FindAllStringSubmatch(body, -1)
	if len(m) != 2 {
		t.Fatalf("?v= 가 %d 개다 — 문서의 두 자리가 모두 치환돼야 한다: %q", len(m), body)
	}
	for _, g := range m {
		if g[1] != want {
			t.Fatalf("?v=%s 가 판(%s)과 다르다", g[1], want)
		}
	}
}

// TC-AVS-3a (FR-AVS-6): `/index.html` 의 301 은 예전 그대로다. 없애면 조용한 동작
// 변경이고, 따라가면 어차피 치환본에 닿는다.
func TestIndexPathRedirectsAsBefore(t *testing.T) {
	h := staticTestServer(t, fsWith(map[string]string{"js/app.js": "x\n"}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/index.html", nil))
	if rec.Code != http.StatusMovedPermanently {
		t.Fatalf("code = %d, want 301", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "./" {
		t.Fatalf("Location = %q, want %q", loc, "./")
	}
}

// TC-AVS-6 (FR-AVS-9): 자리표시자를 두는 곳은 문서 하나다. 자산의 본문은 건드리지
// 않는다 — 우연히 같은 글자가 들어 있어도 그것은 그 파일의 내용이다.
func TestAssetsAreNotSubstituted(t *testing.T) {
	const body = "const P='__ASSETV__'\n"
	h := staticTestServer(t, fsWith(map[string]string{"js/app.js": body}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/js/app.js", nil))
	if got := rec.Body.String(); got != body {
		t.Fatalf("자산이 치환됐다: %q", got)
	}
}

// TC-AVS-5 (FR-AVS-7): **이 변경의 함정이다.** ETag 를 embed 원본에서 계산하면, JS 만
// 고친 빌드에서 문서 원본은 한 글자도 바뀌지 않으므로 브라우저가 재검증하러 와도
// 304 를 받는다 — 옛 HTML 이 남고 옛 `?v=` 를 가리킨다. `?v=` 를 올리지 않았을 때와
// 정확히 같은 증상이며, 이 변경이 없애려는 바로 그것이다.
func TestIndexETagFollowsSubstitution(t *testing.T) {
	etagOf := func(js string) string {
		h := staticTestServer(t, fsWith(map[string]string{"js/app.js": js}))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET / = %d", rec.Code)
		}
		return rec.Header().Get("ETag")
	}

	a, b := etagOf("console.log(1)\n"), etagOf("console.log(2)\n")
	if a == "" {
		t.Fatal("문서에 ETag 가 없다")
	}
	if a == b {
		t.Fatalf("JS 가 바뀌어 문서의 ?v= 가 달라졌는데 ETag 가 같다: %q", a)
	}
}

// 검증자를 붙인 뜻은 재검증이 싸다는 데 있다. 같은 ETag 를 되보내면 304 여야 한다.
func TestIndexETagRevalidates(t *testing.T) {
	h := staticTestServer(t, fsWith(map[string]string{"js/app.js": "x\n"}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	etag := rec.Header().Get("ETag")
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("문서가 재검증되지 않는다: %q", rec.Header().Get("Cache-Control"))
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
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

// TC-AVS-4 (FR-AVS-3): 판을 아는 자리는 하나다. 문서에 적히는 값과 인사에 실리는
// 값이 갈리면 화면이 영원히 새로고침하거나 영원히 하지 않는다.
func TestServedVersionMatchesHello(t *testing.T) {
	files := fsWith(map[string]string{"js/app.js": "console.log(1)\n", "style.css": "body{}\n"})
	srv, err := New(Config{DataDir: t.TempDir(), StaticFS: files}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	h := srv.Handler()

	m := servedVerRe.FindStringSubmatch(servedIndex(t, h))
	if m == nil {
		t.Fatal("서빙된 문서에 ?v= 가 없다")
	}
	if got := srv.assetVersion(); got != m[1] {
		t.Fatalf("인사의 판(%s)이 문서의 ?v=(%s)와 다르다", got, m[1])
	}
}
