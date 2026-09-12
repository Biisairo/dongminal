package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// 터미널 표면의 폴더 업로드 (TERMINAL_FOLDER_DROP_SRS §4.4, FR-TFD-30).
//
// 탐색기(`/api/fs/upload`)와 **같은 함수**가 자리를 정하지만 두 가지가 다르다:
//
//	경계   탐색기는 편집기 루트, 터미널은 **이 도구의 cwd 자신**
//	충돌   탐색기는 거부(409), 터미널은 **자동 개명**(`(1)`) — api.md 의 공개 계약
//
// 그래서 `handlers_fs_relpath_test.go` 의 검사를 여기서 되풀이하지 않고, **다른
// 두 가지**와 그 경계만 잰다.

func termUpload(t *testing.T, s *Server, dir, name, relPath string, content []byte) (int, map[string]any) {
	t.Helper()
	body, ct := relUploadBody(t, name, relPath, content)
	r := apiTestRequest(http.MethodPost, "/api/upload?dir="+url.QueryEscape(dir), body)
	r.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	http.HandlerFunc(s.handleAPI).ServeHTTP(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// TC-TFD-10 (FR-TFD-30): 중간 디렉터리가 생기고 파일이 그 안에 놓인다.
// **이것이 없으면 README 의 "하위 구조가 그대로 올라간다" 가 거짓이다.**
func TestTermUpload_RelPathCreatesDirs(t *testing.T) {
	dir := uploadRoot(t)
	srv := transferSrv(t, dir)

	code, out := termUpload(t, srv, dir, "c.txt", "top/sub/c.txt", []byte("hi\n"))
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	got := filepath.Join(dir, "top", "sub", "c.txt")
	if body := readBody(t, got); body != "hi\n" {
		t.Fatalf("내용 = %q", body)
	}
}

// TC-TFD-11: `relPath` 가 없으면 **지금까지와 같다** — 확장이지 대체가 아니다.
func TestTermUpload_WithoutRelPathUnchanged(t *testing.T) {
	dir := uploadRoot(t)
	srv := transferSrv(t, dir)

	code, _ := termUpload(t, srv, dir, "flat.txt", "", []byte("x\n"))
	if code != http.StatusOK {
		t.Fatalf("code=%d", code)
	}
	if body := readBody(t, filepath.Join(dir, "flat.txt")); body != "x\n" {
		t.Fatalf("내용 = %q", body)
	}
}

// TC-TFD-12: 충돌은 **마지막 조각에만** 개명이 걸린다 — 중간 디렉터리는 그대로
// 쓴다. 폴더까지 개명하면 한 번의 드롭이 `top` 과 `top (1)` 로 갈라진다.
func TestTermUpload_RelPathRenamesLeafOnly(t *testing.T) {
	dir := uploadRoot(t)
	srv := transferSrv(t, dir)

	if code, out := termUpload(t, srv, dir, "c.txt", "top/c.txt", []byte("first\n")); code != http.StatusOK {
		t.Fatalf("첫 업로드 code=%d body=%v", code, out)
	}
	code, out := termUpload(t, srv, dir, "c.txt", "top/c.txt", []byte("second\n"))
	if code != http.StatusOK {
		t.Fatalf("두 번째 code=%d body=%v", code, out)
	}
	// 폴더는 하나여야 한다.
	if _, err := os.Stat(filepath.Join(dir, "top (1)")); err == nil {
		t.Fatal("중간 디렉터리가 개명됐다 — 한 번의 드롭이 두 폴더로 갈라진다")
	}
	if body := readBody(t, filepath.Join(dir, "top", "c.txt")); body != "first\n" {
		t.Fatalf("첫 파일이 덮였다: %q", body)
	}
	if name, _ := out["name"].(string); name != "c (1).txt" {
		t.Fatalf("개명이 공개 계약대로가 아니다: %q", name)
	}
	if body := readBody(t, filepath.Join(dir, "top", "c (1).txt")); body != "second\n" {
		t.Fatalf("둘째 파일 내용 = %q", body)
	}
}

// TC-TFD-13: 경계는 **이 도구의 cwd** 다. `..` 는 400 이고 파일이 생기지 않는다.
func TestTermUpload_RelPathRejectsEscape(t *testing.T) {
	base := uploadRoot(t)
	dir := filepath.Join(base, "cwd")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	srv := transferSrv(t, base)

	for _, rel := range []string{"../out.txt", "a/../../out.txt", "/abs.txt"} {
		code, _ := termUpload(t, srv, dir, "out.txt", rel, []byte("nope\n"))
		if code == http.StatusOK {
			t.Fatalf("relPath=%q 가 통과했다", rel)
		}
		if _, err := os.Stat(filepath.Join(base, "out.txt")); err == nil {
			t.Fatalf("relPath=%q 로 cwd 밖에 파일이 생겼다", rel)
		}
	}
}

// TC-TFD-14: 이미 있는 중간 디렉터리는 충돌이 아니다 — 두 번째 파일이 같은
// 폴더로 들어간다. 한 폴더를 끌어다 놓으면 그 안의 파일 여럿이 순차로 온다.
func TestTermUpload_RelPathExistingDirIsFine(t *testing.T) {
	dir := uploadRoot(t)
	srv := transferSrv(t, dir)

	if code, _ := termUpload(t, srv, dir, "a.txt", "top/a.txt", []byte("a\n")); code != http.StatusOK {
		t.Fatalf("첫 업로드 실패")
	}
	if code, _ := termUpload(t, srv, dir, "b.txt", "top/b.txt", []byte("b\n")); code != http.StatusOK {
		t.Fatalf("둘째 업로드 실패")
	}
	for name, want := range map[string]string{"a.txt": "a\n", "b.txt": "b\n"} {
		if body := readBody(t, filepath.Join(dir, "top", name)); body != want {
			t.Fatalf("%s = %q", name, body)
		}
	}
}
