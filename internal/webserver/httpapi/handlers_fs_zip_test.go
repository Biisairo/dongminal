package httpapi

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
)

// 묶음 B — 폴더 다운로드 (EXPLORER_TRANSFER_IGNORE_SRS §3.2, V-ETR-9~15).
//
// 검사가 **헤더와 zip 의 내용** 둘에 걸린다. 스트리밍이 시작된 뒤에는 오류를
// 보낼 자리가 없으므로(D-6), 거절해야 하는 경우에 `Content-Disposition` 이
// 나가지 않았는지가 곧 "판정이 쓰기보다 앞섰다" 의 증거다.

// zipTree 는 검사에 쓸 트리를 만든다. 빈 디렉터리와 깊은 경로가 함께 있다 —
// 구조 보존(FR-ETR-14)을 검사하려면 둘 다 필요하다.
func zipTree(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	mk := func(rel string, body string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("box/a.txt", "aaa\n")
	mk("box/sub/b.txt", "bbb\n")
	mk("box/sub/deep/c.txt", "ccc\n")
	if err := os.MkdirAll(filepath.Join(root, "box", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	return root
}

func downloadDir(t *testing.T, s *Server, root, path string) *httptest.ResponseRecorder {
	t.Helper()
	u := "/api/fs/download-dir?root=" + url.QueryEscape(root) + "&path=" + url.QueryEscape(path)
	return doGet(t, s, u)
}

// zipEntries 는 응답 본문을 zip 으로 읽어 이름 목록을 준다. 디렉터리 엔트리는
// 끝에 "/" 가 붙은 채로 남긴다 — 빈 디렉터리의 보존을 검사해야 한다.
func zipEntries(t *testing.T, body []byte) []string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("zip 을 읽지 못했다: %v (본문 %d바이트)", err, len(body))
	}
	names := make([]string, 0, len(zr.File))
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	sort.Strings(names)
	return names
}

func zipContent(t *testing.T, body []byte, name string) string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		defer rc.Close()
		var b bytes.Buffer
		if _, err := b.ReadFrom(rc); err != nil {
			t.Fatal(err)
		}
		return b.String()
	}
	t.Fatalf("%q 가 zip 에 없다", name)
	return ""
}

// V-ETR-9 (FR-ETR-9·14): 하위 구조와 빈 디렉터리가 그대로 담긴다. 경로는
// **대상 폴더 이름을 뿌리로** 상대경로여야 한다 — 풀었을 때 폴더 하나가 나와야
// 사용자가 "복사" 로 읽는다.
func TestFSDownloadDir_PreservesTree(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)

	rec := downloadDir(t, srv, root, filepath.Join(root, "box"))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	got := zipEntries(t, rec.Body.Bytes())
	// 디렉터리는 **전부** 엔트리로 들어간다. 빈 것만 넣으면 푸는 쪽이 중간
	// 디렉터리의 mtime·권한을 잃는다 — zip 의 관례가 전부 넣는 것이다.
	want := []string{
		"box/a.txt", "box/empty/", "box/sub/", "box/sub/b.txt",
		"box/sub/deep/", "box/sub/deep/c.txt",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("엔트리 = %v\nwant %v", got, want)
	}
	if c := zipContent(t, rec.Body.Bytes(), "box/sub/deep/c.txt"); c != "ccc\n" {
		t.Fatalf("내용 = %q", c)
	}
}

// V-ETR-10 (FR-ETR-10): 이름 헤더는 파일 다운로드와 **같은 함수**가 만든다
// (FR-FTR-1·4). 확장자는 .zip 이다.
func TestFSDownloadDir_DispositionTwoForms(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)

	dir := filepath.Join(root, "한글 폴더")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := downloadDir(t, srv, root, dir)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	cd := rec.Header().Get("Content-Disposition")
	if !strings.Contains(cd, `filename="`) || !strings.Contains(cd, "filename*=UTF-8''") {
		t.Fatalf("Content-Disposition = %q — 두 벌이 아니다", cd)
	}
	if !strings.Contains(cd, ".zip") {
		t.Fatalf("Content-Disposition = %q — .zip 이 없다", cd)
	}
	// ASCII 폴백은 non-ASCII 를 밑줄로 바꾸되 단위가 **rune** 이다 — "한글 폴더"
	// 는 밑줄 둘·공백·밑줄 둘이지, 바이트로 센 밑줄 열둘이 아니다
	// (asciiFallbackName).
	if !strings.Contains(cd, `filename="__ __.zip"`) {
		t.Fatalf("Content-Disposition = %q — ASCII 폴백이 rune 단위가 아니다", cd)
	}
}

// V-ETR-11 (FR-ETR-11): 파일 경로로 부르면 400 이고 **본문이 나가지 않는다.**
// 두 종단이 서로의 일을 대신하지 않는다.
func TestFSDownloadDir_RejectsFile(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)

	rec := downloadDir(t, srv, root, filepath.Join(root, "box", "a.txt"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code=%d, want 400", rec.Code)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("거절인데 Content-Disposition 이 나갔다: %q", cd)
	}
}

// V-ETR-12 (FR-ETR-12, D-6): 상한을 넘으면 **헤더를 쓰기 전에** 거절한다.
// 스트리밍이 시작된 뒤에는 되돌릴 수 없다 — FR-FTR-2 가 같은 사고에서 나왔다.
func TestFSDownloadDir_OverLimitSendsNothing(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)

	old := zipMaxEntries
	zipMaxEntries = 2
	t.Cleanup(func() { zipMaxEntries = old })

	rec := downloadDir(t, srv, root, filepath.Join(root, "box"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code=%d body=%s, want 400", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("거절인데 Content-Disposition 이 나갔다: %q", cd)
	}
	// 본문이 zip 이면 이미 쓰기 시작한 것이다.
	if bytes.HasPrefix(rec.Body.Bytes(), []byte("PK")) {
		t.Fatal("거절인데 zip 본문이 나갔다")
	}
}

// FR-ETR-12: 바이트 상한도 같은 자리에서 본다.
func TestFSDownloadDir_OverByteLimit(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)

	old := zipMaxBytes
	zipMaxBytes = 4
	t.Cleanup(func() { zipMaxBytes = old })

	rec := downloadDir(t, srv, root, filepath.Join(root, "box"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code=%d, want 400", rec.Code)
	}
}

// V-ETR-13 (FR-ETR-14, D-7): 링크는 담기지 않고 나머지는 담긴다. 따라가면
// 순환과 루트 밖 유출이 함께 열린다.
func TestFSDownloadDir_SkipsSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 는 심링크에 권한이 필요하다")
	}
	root := zipTree(t)
	srv := transferSrv(t, root)

	if err := os.Symlink(filepath.Join(root, "box", "a.txt"),
		filepath.Join(root, "box", "link.txt")); err != nil {
		t.Fatal(err)
	}
	rec := downloadDir(t, srv, root, filepath.Join(root, "box"))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, n := range zipEntries(t, rec.Body.Bytes()) {
		if n == "box/link.txt" {
			t.Fatal("링크가 zip 에 들어갔다")
		}
	}
	if c := zipContent(t, rec.Body.Bytes(), "box/a.txt"); c != "aaa\n" {
		t.Fatalf("나머지가 온전하지 않다: %q", c)
	}
}

// V-ETR-14 (FR-ETR-15): 읽을 수 없는 파일 하나가 전체를 무너뜨리지 않는다.
// 스트리밍이 시작된 뒤에는 오류를 보낼 자리가 없고, 절반짜리 zip 보다 하나
// 빠진 zip 이 낫다.
func TestFSDownloadDir_UnreadableFileSkipped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 는 퍼미션 모델이 다르다")
	}
	if os.Geteuid() == 0 {
		t.Skip("root 는 퍼미션을 무시한다")
	}
	root := zipTree(t)
	srv := transferSrv(t, root)

	bad := filepath.Join(root, "box", "secret.txt")
	if err := os.WriteFile(bad, []byte("s"), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(bad, 0o644) })

	rec := downloadDir(t, srv, root, filepath.Join(root, "box"))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if c := zipContent(t, rec.Body.Bytes(), "box/a.txt"); c != "aaa\n" {
		t.Fatalf("나머지가 온전하지 않다: %q", c)
	}
}

// V-ETR-15 (FR-ETR-9): 루트 밖은 403 이다 — 조회·조작·파일 다운로드와 같은
// 가드다 (FR-EDT-112·113).
func TestFSDownloadDir_RejectsOutsideRoot(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)

	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rec := downloadDir(t, srv, root, outside)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code=%d body=%s, want 403", rec.Code, rec.Body.String())
	}
}

// FR-ETR-9: 루트 자신도 내려받을 수 있다 — 트리 전체를 가져가는 것은 정상 조작이다.
func TestFSDownloadDir_RootItself(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)

	rec := downloadDir(t, srv, root, root)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(zipEntries(t, rec.Body.Bytes())) == 0 {
		t.Fatal("zip 이 비었다")
	}
}

// FR-ETR-9: 라우트가 등록돼 있는가.
func TestFSDownloadDirRouteRegistered(t *testing.T) {
	found := false
	for _, rt := range apiRoutes {
		if rt.method == http.MethodGet && rt.match("/api/fs/download-dir") {
			found = true
		}
	}
	if !found {
		t.Fatal("GET /api/fs/download-dir 이 apiRoutes 에 없다")
	}
}
