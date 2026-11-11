package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// UX_BATCH12_SRS TC-EXD-3 (FR-EXD-4): 여러 경로를 zip 하나로 내려받는다.

func downloadMany(t *testing.T, s *Server, root string, paths ...string) *httptest.ResponseRecorder {
	t.Helper()
	q := url.Values{"root": {root}}
	for _, p := range paths {
		q.Add("path", p)
	}
	return doGet(t, s, "/api/fs/download-many?"+q.Encode())
}

func TestFSDownloadMany_FileAndDirAtTop(t *testing.T) {
	root := zipTree(t)
	if err := os.WriteFile(filepath.Join(root, "top.txt"), []byte("top\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := transferSrv(t, root)

	rec := downloadMany(t, srv, root, filepath.Join(root, "top.txt"), filepath.Join(root, "box", "sub"))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	got := zipEntries(t, rec.Body.Bytes())
	// 뿌리 폴더 자신은 엔트리로 넣지 않는다 — `download-dir` 의 관례다(하위 이름이 이미 그것으로 시작한다).
	want := []string{"sub/b.txt", "sub/deep/", "sub/deep/c.txt", "top.txt"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("엔트리 = %v\nwant %v", got, want)
	}
	if c := zipContent(t, rec.Body.Bytes(), "top.txt"); c != "top\n" {
		t.Fatalf("내용 = %q", c)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, ".zip") {
		t.Fatalf("zip 이름이 아니다: %q", cd)
	}
}

func TestFSDownloadMany_Rejections(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "other", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		paths []string
		code  int
	}{
		{"루트 밖", []string{filepath.Join(root, "box", "a.txt"), outside}, http.StatusForbidden},
		{"경로 없음", nil, http.StatusBadRequest},
		{"같은 이름 둘", []string{filepath.Join(root, "box", "sub"), filepath.Join(root, "other", "sub")}, http.StatusBadRequest},
	}
	for _, c := range cases {
		rec := downloadMany(t, srv, root, c.paths...)
		if rec.Code != c.code {
			t.Fatalf("%s: code=%d body=%s, want %d", c.name, rec.Code, rec.Body.String(), c.code)
		}
		if cd := rec.Header().Get("Content-Disposition"); cd != "" {
			t.Fatalf("%s: 거절인데 Content-Disposition 이 나갔다: %q", c.name, cd)
		}
	}
}

// FR-EXD-4: 상한은 경로 전체의 합이다.
func TestFSDownloadMany_LimitIsSum(t *testing.T) {
	root := zipTree(t)
	srv := transferSrv(t, root)
	old := zipMaxEntries
	zipMaxEntries = 4 // box/sub 하나는 4항목(sub, b, deep, c) — 둘을 합치면 넘는다
	t.Cleanup(func() { zipMaxEntries = old })

	rec := downloadMany(t, srv, root, filepath.Join(root, "box", "sub"), filepath.Join(root, "box", "a.txt"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code=%d body=%s, want 400", rec.Code, rec.Body.String())
	}
	if bytes.HasPrefix(rec.Body.Bytes(), []byte("PK")) {
		t.Fatal("거절인데 zip 본문이 나갔다")
	}
}
