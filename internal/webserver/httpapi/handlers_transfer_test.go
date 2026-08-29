package httpapi

import (
	"bytes"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 파일 전송 (FILE_TRANSFER_SRS §3.1·3.2·3.4·3.5, V-FTR-1~7·11·13).
//
// 두 표면이 같은 헤더를 만들어야 하므로(FR-FTR-4) 검사는 종단이 아니라 **결과
// 헤더**에 건다 — 한쪽만 고쳐지는 것을 잡는 유일한 자리다.

// transferSrv 는 editors.list 에 root 를 심은 서버를 세운다. /api/fs/* 는
// 클라이언트가 보낸 root 를 신뢰하지 않는다 (FR-EDT-113).
func transferSrv(t *testing.T, root string) *Server {
	t.Helper()
	srv, ws, _ := fsTestServer(t)
	seedRoot(t, ws, root)
	return srv
}

func doGet(t *testing.T, s *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	http.HandlerFunc(s.handleAPI).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// multipartBody 는 파일 하나를 담은 multipart 본문을 만든다.
func multipartBody(t *testing.T, name string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	fw.Write(content)
	mw.Close()
	return &b, mw.FormDataContentType()
}

func doUpload(t *testing.T, s *Server, path, name string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := multipartBody(t, name, content)
	r := httptest.NewRequest(http.MethodPost, path, body)
	r.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	http.HandlerFunc(s.handleAPI).ServeHTTP(rec, r)
	return rec
}

// V-FTR-1 (FR-FTR-1): 이름은 두 벌로 나간다 — ASCII 폴백과 RFC 5987 의 filename*.
func TestDownload_ContentDisposition_NonASCII(t *testing.T) {
	root := t.TempDir()
	name := "한글 파일 이름.txt"
	os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644)
	srv := transferSrv(t, root)

	rec := doGet(t, srv, "/api/download?path="+url.QueryEscape(filepath.Join(root, name)))
	if rec.Code != 200 {
		t.Fatalf("status=%d want 200", rec.Code)
	}
	cd := rec.Header().Get("Content-Disposition")
	// ParseMediaType 은 RFC 2231 의 `filename*` 를 풀어 `filename` 에 넣는다 —
	// 원본이 돌아온다는 것이 곧 인코딩이 규격을 지켰다는 뜻이다.
	_, params, err := mime.ParseMediaType(cd)
	if err != nil {
		t.Fatalf("Content-Disposition 을 파싱하지 못했다 (%q): %v", cd, err)
	}
	if got := params["filename"]; got != name {
		t.Fatalf("filename*=%q want %q (cd=%q)", got, name, cd)
	}
	// ASCII 폴백은 raw 로 본다 — 파서가 filename* 로 덮어쓰기 때문이다.
	if !strings.Contains(cd, `filename="__ __ __.txt"`) {
		t.Fatalf("ASCII 폴백이 없다 (non-ASCII 는 rune 하나당 _ 하나): %q", cd)
	}
}

// V-FTR-1: 따옴표와 역슬래시는 폴백에서 사라진다 — quoted-string 을 깨뜨린다.
func TestDownload_ContentDisposition_QuoteEscape(t *testing.T) {
	root := t.TempDir()
	name := `a"b\c.txt`
	if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644); err != nil {
		t.Skipf("이 파일시스템은 %q 를 만들지 못한다: %v", name, err)
	}
	srv := transferSrv(t, root)

	rec := doGet(t, srv, "/api/download?path="+url.QueryEscape(filepath.Join(root, name)))
	cd := rec.Header().Get("Content-Disposition")
	if _, _, err := mime.ParseMediaType(cd); err != nil {
		t.Fatalf("Content-Disposition 을 파싱하지 못했다 (%q): %v", cd, err)
	}
	if !strings.Contains(cd, `filename="a_b_c.txt"`) {
		t.Fatalf("따옴표·역슬래시가 폴백에 그대로 남았다: %q", cd)
	}
}

// V-FTR-2 (FR-FTR-2): 디렉터리는 400 이다. 지금은 200 + 빈 본문이 나간다.
func TestDownload_Directory(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	os.Mkdir(sub, 0o755)
	srv := transferSrv(t, root)

	rec := doGet(t, srv, "/api/download?path="+url.QueryEscape(sub))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400 (body=%q)", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("거절인데 Content-Disposition 이 나갔다: %q", cd)
	}
	if !strings.Contains(rec.Body.String(), "not a file") {
		t.Fatalf("body=%q want 'not a file'", rec.Body.String())
	}
}

// V-FTR-3 (FR-FTR-3): 실패 본문에 서버의 경로가 실리지 않는다.
func TestDownload_NotFound_NoPathLeak(t *testing.T) {
	root := t.TempDir()
	srv := transferSrv(t, root)
	miss := filepath.Join(root, "nope.txt")

	rec := doGet(t, srv, "/api/download?path="+url.QueryEscape(miss))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d want 404", rec.Code)
	}
	if strings.Contains(rec.Body.String(), root) {
		t.Fatalf("본문에 서버 경로가 실렸다: %q", rec.Body.String())
	}
}

// V-FTR-4 (FR-FTR-4): 두 표면이 같은 입력에 같은 헤더를 만든다.
func TestDownload_BothSurfaces_SameHeader(t *testing.T) {
	root := t.TempDir()
	name := "같은 이름.md"
	p := filepath.Join(root, name)
	os.WriteFile(p, []byte("body"), 0o644)
	srv := transferSrv(t, root)

	a := doGet(t, srv, "/api/download?path="+url.QueryEscape(p))
	b := doGet(t, srv, "/api/fs/download?root="+url.QueryEscape(root)+"&path="+url.QueryEscape(p))
	if b.Code != 200 {
		t.Fatalf("/api/fs/download status=%d want 200 (body=%q)", b.Code, b.Body.String())
	}
	if a.Header().Get("Content-Disposition") != b.Header().Get("Content-Disposition") {
		t.Fatalf("헤더가 두 벌이다:\n  /api/download    %q\n  /api/fs/download %q",
			a.Header().Get("Content-Disposition"), b.Header().Get("Content-Disposition"))
	}
	if b.Body.String() != "body" {
		t.Fatalf("body=%q", b.Body.String())
	}
}

// V-FTR-11 (FR-FTR-12): 루트 밖은 403 이다. 루트 대조도 함께 본다.
func TestFSDownload_Guards(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("s"), 0o644)
	os.WriteFile(filepath.Join(root, "ok.txt"), []byte("o"), 0o644)
	srv := transferSrv(t, root)

	rec := doGet(t, srv, "/api/fs/download?root="+url.QueryEscape(root)+
		"&path="+url.QueryEscape(filepath.Join(outside, "secret.txt")))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("루트 밖: status=%d want 403", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), fsErrOutsideRoot) {
		t.Fatalf("body=%q want %s", rec.Body.String(), fsErrOutsideRoot)
	}

	rec = doGet(t, srv, "/api/fs/download?root="+url.QueryEscape(outside)+
		"&path="+url.QueryEscape(filepath.Join(outside, "secret.txt")))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("목록에 없는 root: status=%d want 403", rec.Code)
	}

	rec = doGet(t, srv, "/api/fs/download?root="+url.QueryEscape(root)+
		"&path="+url.QueryEscape(filepath.Join(root, "sub")))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("없는 파일: status=%d want 404", rec.Code)
	}
}

// V-FTR-5 (FR-FTR-5): 상한을 넘으면 413 이고 파일이 남지 않는다.
func TestUpload_MaxBytes(t *testing.T) {
	root := t.TempDir()
	srv := transferSrv(t, root)
	old := uploadMaxBytes
	uploadMaxBytes = 64
	t.Cleanup(func() { uploadMaxBytes = old })

	rec := doUpload(t, srv, "/api/upload?dir="+url.QueryEscape(root), "big.txt", bytes.Repeat([]byte("x"), 4096))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d want 413 (body=%q)", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "big.txt")); err == nil {
		t.Fatalf("거절했는데 파일이 남았다")
	}

	rec = doUpload(t, srv, "/api/fs/upload?root="+url.QueryEscape(root)+"&dir="+url.QueryEscape(root),
		"big.txt", bytes.Repeat([]byte("x"), 4096))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("/api/fs/upload status=%d want 413 (body=%q)", rec.Code, rec.Body.String())
	}
}

// V-FTR-6 (FR-FTR-6): 없는 폴더는 400 이다 — 만들지 않는다.
func TestUpload_MissingDir(t *testing.T) {
	root := t.TempDir()
	srv := transferSrv(t, root)
	gone := filepath.Join(root, "no-such-dir")

	rec := doUpload(t, srv, "/api/upload?dir="+url.QueryEscape(gone), "a.txt", []byte("a"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400 (body=%q)", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(gone); err == nil {
		t.Fatalf("업로드가 폴더를 만들었다")
	}

	// 파일을 폴더로 지목하는 것도 같다.
	f := filepath.Join(root, "f.txt")
	os.WriteFile(f, []byte("f"), 0o644)
	rec = doUpload(t, srv, "/api/upload?dir="+url.QueryEscape(f), "a.txt", []byte("a"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("파일을 dir 로: status=%d want 400", rec.Code)
	}
}

// V-FTR-13 (FR-FTR-16): 탐색기 업로드는 충돌을 거부한다 — 덮어쓰지도 개명하지도
// 않는다. 터미널 업로드의 자동 개명과 다른 것은 의도다 (D-3).
func TestFSUpload_ExistsRejected(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "dup.txt"), []byte("ORIGINAL"), 0o644)
	srv := transferSrv(t, root)

	rec := doUpload(t, srv, "/api/fs/upload?root="+url.QueryEscape(root)+"&dir="+url.QueryEscape(root),
		"dup.txt", []byte("NEW"))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d want 409 (body=%q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), fsErrExists) {
		t.Fatalf("body=%q want %s", rec.Body.String(), fsErrExists)
	}
	got, _ := os.ReadFile(filepath.Join(root, "dup.txt"))
	if string(got) != "ORIGINAL" {
		t.Fatalf("원본이 바뀌었다: %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, "dup (1).txt")); err == nil {
		t.Fatalf("탐색기 업로드가 이름을 자동으로 바꿨다")
	}
}

// FR-FTR-15: 성공하면 그 이름 그대로 그 폴더에 놓인다. 루트 밖 dir 은 거절한다.
func TestFSUpload_OKAndGuards(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "a", "b", "c")
	os.MkdirAll(sub, 0o755)
	outside := t.TempDir()
	srv := transferSrv(t, root)

	rec := doUpload(t, srv, "/api/fs/upload?root="+url.QueryEscape(root)+"&dir="+url.QueryEscape(sub),
		"깊은 곳.txt", []byte("deep"))
	if rec.Code != 200 {
		t.Fatalf("status=%d want 200 (body=%q)", rec.Code, rec.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(sub, "깊은 곳.txt"))
	if err != nil || string(got) != "deep" {
		t.Fatalf("올라간 파일=%q err=%v", got, err)
	}

	rec = doUpload(t, srv, "/api/fs/upload?root="+url.QueryEscape(root)+"&dir="+url.QueryEscape(outside),
		"x.txt", []byte("x"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("루트 밖 dir: status=%d want 403", rec.Code)
	}
}

// V-FTR-7 (FR-FTR-7): cwd 의 근거를 함께 싣는다. 폴백 자체는 유지한다 (D-4).
func TestCwd_Source(t *testing.T) {
	srv := transferSrv(t, t.TempDir())
	hub := newFakePaneHub()
	hub.setCwd("p1", "/tmp/tool-cwd")
	srv.Tools = hub

	rec := doGet(t, srv, "/api/cwd?tool=p1")
	if body := rec.Body.String(); !strings.Contains(body, `"source":"tool"`) ||
		!strings.Contains(body, "/tmp/tool-cwd") {
		t.Fatalf("body=%q want source=tool", body)
	}

	rec = doGet(t, srv, "/api/cwd?tool=unknown")
	if body := rec.Body.String(); !strings.Contains(body, `"source":"server"`) {
		t.Fatalf("body=%q want source=server", body)
	}
	wd, _ := os.Getwd()
	if !strings.Contains(rec.Body.String(), wd) {
		t.Fatalf("폴백이 사라졌다 — 소비자 넷이 이것을 딛는다: %q", rec.Body.String())
	}
}

// 기존 계약은 그대로다 — 터미널 업로드의 자동 개명 (api.md).
func TestUpload_UniquePathKept(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "dup.txt"), []byte("x"), 0o644)
	srv := transferSrv(t, root)

	rec := doUpload(t, srv, "/api/upload?dir="+url.QueryEscape(root), "dup.txt", []byte("y"))
	if rec.Code != 200 {
		t.Fatalf("status=%d want 200 (body=%q)", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "dup (1).txt")); err != nil {
		t.Fatalf("자동 개명이 사라졌다: %v", err)
	}
}
