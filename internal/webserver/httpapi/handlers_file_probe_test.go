package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"

	"dongminal/internal/webserver/domain/wsentry"
	"testing"
)

// EDITOR_GIT_UX_SRS 묶음 V — 열 수 있는 것과 없는 것.
// 검증 V-EVW-1·4·5.

// 최소 PNG. 시그니처만 있으면 http.DetectContentType 이 image/png 로 읽는다.
var pngBytes = append(
	[]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a},
	bytes.Repeat([]byte{0}, 32)...)

func probeGet(t *testing.T, s *Server, path, p string) (int, map[string]any) {
	t.Helper()
	r := apiTestRequest("GET", path+"?path="+url.QueryEscape(p), nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	return w.Code, body
}

func probeServer(t *testing.T) (*Server, string) {
	t.Helper()
	srv, err := New(Config{Port: "0", DataDir: t.TempDir()},
		Deps{Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// FILE_API_BOUNDARY_SRS FR-FAB-1: `/api/file/*` 는 이제 허용 루트 아래만 연다.
	// 이 검사들이 재는 것은 **무엇을 열 수 있는가**(kind·mime·인라인 규칙)이지
	// 경계가 아니므로, 작업 폴더를 Editor 루트로 등록해 두고 그 위에서 잰다.
	// 경계 자체는 `handlers_files_boundary_test.go` 가 잰다.
	dir := t.TempDir()
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	if _, err := srv.Entries.Mutate(func(cur wsentry.Lists) wsentry.Lists {
		cur.Editors = append(cur.Editors, dir)
		return cur
	}); err != nil {
		t.Fatalf("Editor 루트 등록: %v", err)
	}
	return srv, dir
}

func writeAt(t *testing.T, dir, name string, blob []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, blob, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// V-EVW-1: 판정은 내용이 우선이다 (FR-EVW-2). 확장자는 근거가 아니다.
func TestFileProbeClassifiesByContent(t *testing.T) {
	s, dir := probeServer(t)
	cases := []struct {
		name string
		blob []byte
		want string
	}{
		// .txt 로 저장된 PNG — 확장자를 믿으면 text 로 잘못 읽는다.
		{"disguised.txt", pngBytes, "image"},
		// 확장자 없는 스크립트 — 확장자를 믿으면 열지 못한다.
		{"script", []byte("#!/bin/sh\necho hi\n"), "text"},
		{"code.go", []byte("package main\n"), "text"},
		{"blob.bin", append([]byte("MZ\x00\x01"), bytes.Repeat([]byte{0x01, 0x00}, 64)...), "binary"},
		{"empty.txt", []byte{}, "text"},
	}
	for _, tc := range cases {
		p := writeAt(t, dir, tc.name, tc.blob)
		code, body := probeGet(t, s, "/api/file/probe", p)
		if code != 200 {
			t.Fatalf("%s: code=%d body=%v", tc.name, code, body)
		}
		if body["kind"] != tc.want {
			t.Fatalf("%s: kind=%v, want %s (mime=%v)", tc.name, body["kind"], tc.want, body["mime"])
		}
	}
}

// probe 는 크기도 준다 — 뷰어가 그것으로 안내를 고른다.
func TestFileProbeReportsSize(t *testing.T) {
	s, dir := probeServer(t)
	p := writeAt(t, dir, "a.txt", []byte("12345"))
	_, body := probeGet(t, s, "/api/file/probe", p)
	if n, _ := body["size"].(float64); n != 5 {
		t.Fatalf("size=%v, want 5", body["size"])
	}
}

func TestFileProbeRejectsBadPath(t *testing.T) {
	s, dir := probeServer(t)
	for _, p := range []string{"", "relative/path", filepath.Join(dir, "nope")} {
		code, _ := probeGet(t, s, "/api/file/probe", p)
		if code == 200 {
			t.Fatalf("path=%q 가 통과했다", p)
		}
	}
	// 디렉터리도 파일이 아니다.
	if code, _ := probeGet(t, s, "/api/file/probe", dir); code == 200 {
		t.Fatal("디렉터리가 통과했다")
	}
}

// V-EVW-5: 이미지는 올바른 MIME 과 nosniff 로 나간다 (FR-EVW-5·6).
func TestFileRawServesImageInline(t *testing.T) {
	s, dir := probeServer(t)
	p := writeAt(t, dir, "pic.png", pngBytes)

	r := apiTestRequest("GET", "/api/file/raw?path="+url.QueryEscape(p), nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("Content-Type=%q, want image/png", ct)
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("nosniff 가 없다 — FR-EVW-6 위반")
	}
	if !bytes.Equal(w.Body.Bytes(), pngBytes) {
		t.Fatal("본문이 원본과 다르다")
	}
}

// V-EVW-4: 이미지가 아닌 것은 인라인으로 내보내지 않는다 (FR-EVW-5).
// 임의의 파일을 추론된 MIME 으로 같은 출처에서 제공하면 저장형 XSS 가 된다.
//
// **SVG 가 이 목록에서 빠졌다** (DOC_RENDER_VIEW_SRS FR-DRV-24 가 FR-EVW-5 를 그만큼
// 개정한다).
//
//	이전 동작: `.svg` 도 415 였다 — 내보낼 길이 없었다
//	새  동작: 내용이 SVG 면 `image/svg+xml` 로 나간다
//	이유:     Markdown 문서 안에서 참조된 `.svg` 이미지가 이 길로 와야 그려진다.
//	          여는 대신 **잠금장치를 함께 달았다** — 내용 판정(확장자를 믿지 않는다)과
//	          `Content-Security-Policy: sandbox`. 그 둘을 TestFileRawServesSVGSandboxed
//	          와 TestFileRawRejectsHTMLNamedSVG 가 잡고 있다.
//
// 아래 목록에 `a.xml` 을 더한 것은 그 개정의 **경계를 재기 위해서다** — SVG 가
// 통과한다고 해서 XML 이 통과하지는 않는다.
func TestFileRawRefusesNonImage(t *testing.T) {
	s, dir := probeServer(t)
	for _, tc := range []struct{ name, body string }{
		{"page.html", "<script>alert(1)</script>"},
		{"a.txt", "plain text"},
		{"a.xml", "<?xml version='1.0'?><root><item/></root>"},
	} {
		p := writeAt(t, dir, tc.name, []byte(tc.body))
		r := apiTestRequest("GET", "/api/file/raw?path="+url.QueryEscape(p), nil)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("%s: code=%d, want 415 — FR-EVW-5 위반", tc.name, w.Code)
		}
	}
}

// ── SVG (DOC_RENDER_VIEW_SRS FR-DRV-24 · V-DRV-10·11) ──
//
// SVG 는 **이미지이면서 문서다.** 그려 보이려면 내보내야 하고, 내보내면 그 안의
// 스크립트가 우리 출처에서 돌 수 있다 — §2.3 이 막고 있던 바로 그 함정이다.
// 그래서 문을 내면서 잠금장치를 함께 단다.

var svgBytes = []byte(`<?xml version="1.0"?>
<!-- 주석 -->
<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>`)

// V-DRV-10: SVG 를 내보낼 때 nosniff 와 CSP sandbox 를 함께 보낸다.
//
// **CSP 가 없으면 사용자가 그 URL 을 주소창에 직접 열었을 때** 문서의 스크립트가
// 우리 출처에서 돈다. `<img>` 안에서 안전한 것과 그것은 다른 이야기다.
func TestFileRawServesSVGSandboxed(t *testing.T) {
	s, dir := probeServer(t)
	p := writeAt(t, dir, "icon.svg", svgBytes)
	r := apiTestRequest("GET", "/api/file/raw?path="+url.QueryEscape(p), nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("SVG 가 거절됐다: %d %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Content-Type"); got != "image/svg+xml" {
		t.Errorf("Content-Type = %q, want image/svg+xml", got)
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("nosniff 가 없다: %q", got)
	}
	if got := w.Header().Get("Content-Security-Policy"); got != "sandbox" {
		t.Errorf("CSP = %q, want sandbox", got)
	}
	if !bytes.Equal(w.Body.Bytes(), svgBytes) {
		t.Errorf("본문이 원본과 다르다")
	}
}

// V-DRV-11: 판정은 **내용**이다 (FR-EVW-2 와 같은 근거). `.svg` 로 이름만 바꾼
// HTML 이 통과하면 확장자 하나로 저장형 XSS 의 길이 열린다.
func TestFileRawRejectsHTMLNamedSVG(t *testing.T) {
	s, dir := probeServer(t)
	p := writeAt(t, dir, "evil.svg", []byte("<html><body><script>alert(1)</script></body></html>"))
	r := apiTestRequest("GET", "/api/file/raw?path="+url.QueryEscape(p), nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code == 200 {
		t.Fatalf("이름만 .svg 인 HTML 이 통과했다: %s", w.Header().Get("Content-Type"))
	}
}

// SVG 는 편집기에서 **소스로 열려야 한다.** probe 가 이것을 이미지로 판정하면
// 그 파일을 고칠 길이 사라진다 — 그리는 일은 렌더 뷰의 것이다 (FR-DRV-14).
func TestFileProbeKeepsSVGEditable(t *testing.T) {
	s, dir := probeServer(t)
	p := writeAt(t, dir, "icon.svg", svgBytes)
	code, body := probeGet(t, s, "/api/file/probe", p)
	if code != 200 {
		t.Fatalf("probe %d", code)
	}
	if body["kind"] != "text" {
		t.Errorf("kind = %v, want text — SVG 는 편집할 수 있어야 한다", body["kind"])
	}
}
