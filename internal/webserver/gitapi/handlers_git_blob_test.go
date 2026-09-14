package gitapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// V-M9-20·21 (M9_SRS FR-M9-20·21) — 그림 diff 의 서버측.
//
// **재는 것은 "그림으로 볼 수 있는가" 와 "그 바이트가 잠금장치를 달고 나가는가"
// 둘이다.** 화면이 그림을 그리는지는 e2e 가 본다.

// 1×1 PNG. `http.DetectContentType` 이 `image/png` 로 보는 가장 작은 바이트다.
var pngBytes = []byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
	0, 0, 0, 0x0d, 'I', 'H', 'D', 'R',
	0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
}

const svgBody = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>`

func gitBlobServer(t *testing.T, f *gitDiffFake) *GitServer {
	t.Helper()
	s := gitDiffServer(t, f)
	// D-M9-16: 그림 전용 실행기. 같은 fake 를 쓰되 상한만 다르다 — 이 검사가
	// 재는 것은 상한이 아니라 배선이다.
	s.Images = core.New(core.WithRunner(f.runner), core.WithMaxOutput(1<<20))
	return s
}

func blobReq(t *testing.T, s *GitServer, url string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

// V-M9-21a: 이전 판(블롭)의 바이트가 MIME·nosniff 와 함께 나간다.
func TestAPIGitBlob_ServesOriginalWithLocks(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs["HEAD:a.png"] = string(pngBytes)
	s := gitBlobServer(t, f)

	rec := blobReq(t, s, "/api/git/blob?repo="+f.root+"&axis=worktree-head&path=a.png&side=original")
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("Content-Type=%q", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("nosniff 가 없다: %q", got)
	}
	// SVG 가 아니면 sandbox 를 달지 않는다 — 그 헤더는 문서인 형식의 것이다.
	if got := rec.Header().Get("Content-Security-Policy"); got != "" {
		t.Fatalf("png 에 CSP 가 붙었다: %q", got)
	}
	if rec.Body.String() != string(pngBytes) {
		t.Fatalf("바이트가 다르다: %d바이트", rec.Body.Len())
	}
}

// V-M9-21b: 현재 판은 **작업 트리**에서 온다 — git 을 지나지 않는다.
func TestAPIGitBlob_ServesModifiedFromWorktree(t *testing.T) {
	f := newGitDiffFake(t)
	if err := os.WriteFile(filepath.Join(f.root, "b.png"), pngBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	s := gitBlobServer(t, f)

	rec := blobReq(t, s, "/api/git/blob?repo="+f.root+"&axis=worktree-head&path=b.png&side=modified")
	if rec.Code != http.StatusOK || rec.Body.String() != string(pngBytes) {
		t.Fatalf("code=%d len=%d", rec.Code, rec.Body.Len())
	}
}

// V-M9-21c: **SVG 에는 sandbox 가 함께 간다** (FR-DRV-24 와 같은 잠금장치).
//
// 사용자가 이 URL 을 주소창에 직접 열었을 때 문서의 스크립트가 우리 출처에서
// 도는 것을 막는 것은 이 헤더뿐이다.
func TestAPIGitBlob_SVGCarriesSandbox(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs["HEAD:i.svg"] = svgBody
	s := gitBlobServer(t, f)

	rec := blobReq(t, s, "/api/git/blob?repo="+f.root+"&axis=worktree-head&path=i.svg&side=original")
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "image/svg+xml" {
		t.Fatalf("Content-Type=%q", got)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got != "sandbox" {
		t.Fatalf("SVG 에 sandbox 가 없다: %q", got)
	}
}

// V-M9-21d: **그림이 아니면 내보내지 않는다.** 임의의 파일을 추론된 MIME 으로
// 같은 출처에서 인라인 제공하면 저장형 XSS 이고, 저장소 안의 파일이라고 달라지지
// 않는다. `.svg` 로 이름만 바꾼 HTML 도 여기서 걸린다.
func TestAPIGitBlob_RejectsNonImage(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs["HEAD:a.txt"] = "plain\n"
	f.blobs["HEAD:evil.svg"] = "<html><script>alert(1)</script></html>"
	s := gitBlobServer(t, f)

	for _, p := range []string{"a.txt", "evil.svg"} {
		rec := blobReq(t, s, "/api/git/blob?repo="+f.root+"&axis=worktree-head&path="+p+"&side=original")
		if rec.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("%s: code=%d body=%q — 415 여야 한다", p, rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "not_an_image") {
			t.Fatalf("%s: body=%q", p, rec.Body.String())
		}
	}
}

// V-M9-21e: 거부가 각자의 코드를 준다 — side·축이 틀리면 400, 없으면 404.
func TestAPIGitBlob_RejectionsAreDistinct(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs["HEAD:a.png"] = string(pngBytes)
	s := gitBlobServer(t, f)

	cases := []struct {
		name, url string
		want      int
	}{
		{"side 없음", "&axis=worktree-head&path=a.png", http.StatusBadRequest},
		{"side 이상", "&axis=worktree-head&path=a.png&side=both", http.StatusBadRequest},
		{"축 이상", "&axis=nope&path=a.png&side=original", http.StatusBadRequest},
		{"없는 파일", "&axis=worktree-head&path=zz.png&side=original", http.StatusNotFound},
	}
	for _, c := range cases {
		rec := blobReq(t, s, "/api/git/blob?repo="+f.root+c.url)
		if rec.Code != c.want {
			t.Fatalf("%s: code=%d want %d body=%q", c.name, rec.Code, c.want, rec.Body.String())
		}
	}
}

// V-M9-21f: `Images` 가 없으면 **공용 서비스로 떨어지지 않는다** (D-M9-16).
// 그쪽은 1MiB 에서 자르고, 잘린 그림은 "깨진 파일" 로만 보인다.
func TestAPIGitBlob_WithoutImageServiceIsUnavailable(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs["HEAD:a.png"] = string(pngBytes)
	s := gitDiffServer(t, f) // Images 를 주지 않는다

	rec := blobReq(t, s, "/api/git/blob?repo="+f.root+"&axis=worktree-head&path=a.png&side=original")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d body=%q — 503 이어야 한다", rec.Code, rec.Body.String())
	}
}

// V-M9-20a: `imageMime` 은 **내용**으로 정해지고 side 의 kind 를 건드리지 않는다.
func TestAPIGitDiffContent_ImageMime(t *testing.T) {
	cases := []struct {
		name, path, body, wantMime, wantKind string
	}{
		{"PNG 는 그림이고 kind 는 binary 그대로", "a.png", string(pngBytes), "image/png", "binary"},
		{"SVG 는 그림이고 kind 는 text 그대로", "i.svg", svgBody, "image/svg+xml", "text"},
		{"그림 아닌 텍스트", "a.txt", "plain\n", "", "text"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitDiffFake(t)
			f.blobs["HEAD:"+c.path] = c.body
			s := gitBlobServer(t, f)

			code, out := gitReq(t, s, http.MethodGet,
				"/api/git/diff-content?repo="+f.root+"&axis=worktree-head&path="+c.path, "")
			if code != http.StatusOK {
				t.Fatalf("code=%d out=%v", code, out)
			}
			if got, _ := out["imageMime"].(string); got != c.wantMime {
				t.Fatalf("imageMime=%q want %q", got, c.wantMime)
			}
			orig, _ := out["original"].(map[string]any)
			if orig["kind"] != c.wantKind {
				t.Fatalf("original.kind=%v want %v", orig["kind"], c.wantKind)
			}
			// 그림이면 "본문을 표시하지 않습니다" 를 말하지 않는다.
			if c.wantMime != "" && out["note"] != nil && out["note"] != "" {
				t.Fatalf("그림인데 note 가 남았다: %v", out["note"])
			}
		})
	}
}

// V-M9-20b: 그림 갈래가 서지 않는 배선에서는 `imageMime` 이 **언제나 빈다** —
// 틀린 답을 주지 않는다.
func TestAPIGitDiffContent_NoImageServiceLeavesMimeEmpty(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs["HEAD:a.png"] = string(pngBytes)
	s := gitDiffServer(t, f)

	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/diff-content?repo="+f.root+"&axis=worktree-head&path=a.png", "")
	if code != http.StatusOK {
		t.Fatalf("code=%d", code)
	}
	if got, _ := out["imageMime"].(string); got != "" {
		t.Fatalf("imageMime=%q — 비어야 한다", got)
	}
}
