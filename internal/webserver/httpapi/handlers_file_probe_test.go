package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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
	r := httptest.NewRequest("GET", path+"?path="+url.QueryEscape(p), nil)
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
	return srv, t.TempDir()
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

	r := httptest.NewRequest("GET", "/api/file/raw?path="+url.QueryEscape(p), nil)
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
func TestFileRawRefusesNonImage(t *testing.T) {
	s, dir := probeServer(t)
	for _, tc := range []struct{ name, body string }{
		{"page.html", "<script>alert(1)</script>"},
		{"a.txt", "plain text"},
		{"a.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>"},
	} {
		p := writeAt(t, dir, tc.name, []byte(tc.body))
		r := httptest.NewRequest("GET", "/api/file/raw?path="+url.QueryEscape(p), nil)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusUnsupportedMediaType {
			t.Fatalf("%s: code=%d, want 415 — FR-EVW-5 위반", tc.name, w.Code)
		}
	}
}
