package httpapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// 묶음 C — 폴더 업로드의 서버측 (EXPLORER_TRANSFER_IGNORE_SRS §3.3,
// V-ETR-16~20).
//
// `relPath` 는 **확장이지 대체가 아니다** (D-8). 없이 부르면 지금과 같아야 하고,
// 있으면 대상 **아래로** 구조를 세운다 — 대상 자신은 여전히 만들지 않는다
// (FR-FTR-6 은 그대로다).

// relUploadBody 는 file 과 relPath 를 함께 담은 multipart 본문을 만든다.
// relPath 가 비면 필드를 아예 넣지 않는다 — "없을 때" 의 동작을 검사해야 한다.
func relUploadBody(t *testing.T, name, relPath string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	if relPath != "" {
		if err := mw.WriteField("relPath", relPath); err != nil {
			t.Fatal(err)
		}
	}
	fw, err := mw.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	fw.Write(content)
	mw.Close()
	return &b, mw.FormDataContentType()
}

func relUpload(t *testing.T, s *Server, root, dir, name, relPath string, content []byte) (int, map[string]any) {
	t.Helper()
	body, ct := relUploadBody(t, name, relPath, content)
	u := "/api/fs/upload?root=" + url.QueryEscape(root) + "&dir=" + url.QueryEscape(dir)
	r := httptest.NewRequest(http.MethodPost, u, body)
	r.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	http.HandlerFunc(s.handleAPI).ServeHTTP(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func uploadRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func readBody(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("읽지 못했다 %s: %v", p, err)
	}
	return string(b)
}

// V-ETR-16 (FR-ETR-17·19): 중간 디렉터리가 생기고 파일이 그 안에 놓인다.
func TestFSUpload_RelPathCreatesDirs(t *testing.T) {
	root := uploadRoot(t)
	srv := transferSrv(t, root)

	code, out := relUpload(t, srv, root, root, "c.txt", "a/b/c.txt", []byte("hi\n"))
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	got := filepath.Join(root, "a", "b", "c.txt")
	if body := readBody(t, got); body != "hi\n" {
		t.Fatalf("내용 = %q", body)
	}
}

// V-ETR-17 (FR-ETR-18): `..` 이 든 relPath 는 400 이고 **파일이 생기지 않는다.**
// 대상 dir 이 루트 아래여도 relPath 가 그 위로 올라갈 수 있다.
func TestFSUpload_RelPathRejectsDotDot(t *testing.T) {
	root := uploadRoot(t)
	srv := transferSrv(t, root)

	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	code, out := relUpload(t, srv, root, sub, "x.txt", "../../escaped.txt", []byte("no"))
	if code != http.StatusBadRequest {
		t.Fatalf("code=%d body=%v, want 400", code, out)
	}
	// 루트의 부모까지 올라간 자리에도, 루트 안에도 남으면 안 된다.
	for _, p := range []string{
		filepath.Join(filepath.Dir(root), "escaped.txt"),
		filepath.Join(root, "escaped.txt"),
	} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("탈출한 파일이 생겼다: %s", p)
		}
	}
}

// FR-ETR-18: 절대경로 relPath 도 거절한다 — 받는 것은 대상 **아래의** 상대경로다.
func TestFSUpload_RelPathRejectsAbsolute(t *testing.T) {
	root := uploadRoot(t)
	srv := transferSrv(t, root)

	abs := filepath.Join(root, "abs.txt")
	code, _ := relUpload(t, srv, root, root, "abs.txt", abs, []byte("no"))
	if code != http.StatusBadRequest {
		t.Fatalf("code=%d, want 400", code)
	}
}

// V-ETR-18 (FR-ETR-17): relPath 가 없으면 지금과 같다 — `dir/<이름>` 이다.
// 기존 호출자의 동작이 바뀌지 않는 것이 이 확장의 조건이다.
func TestFSUpload_WithoutRelPathUnchanged(t *testing.T) {
	root := uploadRoot(t)
	srv := transferSrv(t, root)

	code, out := relUpload(t, srv, root, root, "plain.txt", "", []byte("p\n"))
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if body := readBody(t, filepath.Join(root, "plain.txt")); body != "p\n" {
		t.Fatalf("내용 = %q", body)
	}
}

// V-ETR-19 (FR-ETR-20): 마지막 조각이 이미 있으면 409 이고 원본이 그대로다.
// FR-FTR-16 이 그대로 적용된다 — 덮어쓰지 않는다.
func TestFSUpload_RelPathConflictKeepsOriginal(t *testing.T) {
	root := uploadRoot(t)
	srv := transferSrv(t, root)

	dst := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dst, "c.txt"), []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out := relUpload(t, srv, root, root, "c.txt", "a/b/c.txt", []byte("new\n"))
	if code != http.StatusConflict {
		t.Fatalf("code=%d body=%v, want 409", code, out)
	}
	if out["code"] != fsErrExists {
		t.Fatalf("code=%v, want %q", out["code"], fsErrExists)
	}
	if body := readBody(t, filepath.Join(dst, "c.txt")); body != "old\n" {
		t.Fatalf("원본이 바뀌었다: %q", body)
	}
}

// FR-ETR-20: 중간 디렉터리가 이미 있는 것은 충돌이 아니다.
func TestFSUpload_RelPathExistingDirIsFine(t *testing.T) {
	root := uploadRoot(t)
	srv := transferSrv(t, root)

	if err := os.MkdirAll(filepath.Join(root, "a", "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	code, out := relUpload(t, srv, root, root, "c.txt", "a/b/c.txt", []byte("ok\n"))
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
}

// V-ETR-20 (FR-ETR-19): 대상 `dir` 자신은 만들지 않는다. 확장은 "대상 **아래로**
// 구조를 세운다" 까지이며 FR-FTR-6 은 그대로다 (D-8).
func TestFSUpload_RelPathDoesNotCreateTargetDir(t *testing.T) {
	root := uploadRoot(t)
	srv := transferSrv(t, root)

	missing := filepath.Join(root, "nope")
	code, _ := relUpload(t, srv, root, missing, "c.txt", "a/c.txt", []byte("x"))
	// 없는 dir 은 fsResolveExisting 이 not_found 로, 있으나 디렉터리가 아니면
	// uploadInto 가 bad_request 로 잡는다. 어느 쪽이든 만들어서는 안 된다.
	if code == http.StatusOK {
		t.Fatal("없는 대상 폴더에 업로드가 성공했다")
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatalf("대상 폴더를 만들었다: %s", missing)
	}
}

// FR-ETR-18 (세 번째 방어): 중간 조각이 **루트 밖을 가리키는 링크**면 거절한다.
// 문자열 판정 둘(절대경로·`..`)은 이것을 잡지 못한다 — `a/b.txt` 는 어느 모로
// 보아도 정상이고, `a` 가 링크라는 사실은 파일시스템만 안다. 막지 않으면
// `MkdirAll` 과 `os.OpenFile` 이 링크를 따라가 루트 밖에 쓴다.
func TestFSUpload_RelPathRejectsSymlinkedAncestor(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 는 심링크에 권한이 필요하다")
	}
	root := uploadRoot(t)
	srv := transferSrv(t, root)

	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "a")); err != nil {
		t.Fatal(err)
	}

	code, out := relUpload(t, srv, root, root, "b.txt", "a/b.txt", []byte("no"))
	if code != http.StatusForbidden {
		t.Fatalf("code=%d body=%v, want 403", code, out)
	}
	if _, err := os.Stat(filepath.Join(outside, "b.txt")); err == nil {
		t.Fatal("링크를 따라가 루트 밖에 썼다")
	}
}

// FR-ETR-18: 조각 하나가 `..` 인 경우뿐 아니라 이름 안에 섞인 것도 본다.
// `a/../../x` 는 Clean 하면 `../x` 다.
func TestFSUpload_RelPathRejectsCleanedEscape(t *testing.T) {
	root := uploadRoot(t)
	srv := transferSrv(t, root)

	code, _ := relUpload(t, srv, root, root, "x.txt", "a/../../x.txt", []byte("no"))
	if code != http.StatusBadRequest {
		t.Fatalf("code=%d, want 400", code)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "x.txt")); err == nil {
		t.Fatal("탈출한 파일이 생겼다")
	}
}
