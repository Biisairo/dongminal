package httpapi

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/lsp"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-1-9 (HTTP-16) — os 오류의 전문이 응답 본문으로
// 나가지 않는다. `fail.go` 가 정찰 정보로 규정한 것을 fs·파일·LSP 표면이 여전히
// 실었다. 코드는 그대로 남는다 — 클라이언트가 분기하는 것은 그쪽이다.

const leakSecret = "/Users/someone/.ssh/secret-dir"

func TestFsFromOS_HidesPath(t *testing.T) {
	cases := []struct {
		err  error
		code string
	}{
		{&fs.PathError{Op: "open", Path: leakSecret, Err: fs.ErrNotExist}, apierr.CodeNotFound},
		{&fs.PathError{Op: "open", Path: leakSecret, Err: fs.ErrPermission}, apierr.CodePermission},
		{&fs.PathError{Op: "open", Path: leakSecret, Err: errors.New("i/o error")}, apierr.CodeIO},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		fsFailErr(rec, fsFromOS(c.err))
		if strings.Contains(rec.Body.String(), leakSecret) {
			t.Fatalf("%v: 경로가 본문에 실렸다: %q", c.err, rec.Body.String())
		}
		if got := rec.Header().Get(apierr.CodeHeader); got != c.code {
			t.Fatalf("%v: code = %q, want %q", c.err, got, c.code)
		}
	}
}

func TestFsResolveErr_HidesPath(t *testing.T) {
	for _, base := range []error{fs.ErrNotExist, fs.ErrPermission} {
		rec := httptest.NewRecorder()
		fsFailErr(rec, fsResolveErr(&fs.PathError{Op: "lstat", Path: leakSecret, Err: base}))
		if strings.Contains(rec.Body.String(), leakSecret) {
			t.Fatalf("%v: 경로가 본문에 실렸다: %q", base, rec.Body.String())
		}
	}
}

// 분류되지 않은 오류가 fsFailErr 에 곧장 와도 전문은 로그로만 간다.
func TestFsFailErr_FallbackHidesDetail(t *testing.T) {
	rec := httptest.NewRecorder()
	fsFailErr(rec, errors.New(leakSecret+": boom"))
	if strings.Contains(rec.Body.String(), leakSecret) {
		t.Fatalf("전문이 본문에 실렸다: %q", rec.Body.String())
	}
	if got := rec.Header().Get(apierr.CodeHeader); got != apierr.CodeIO {
		t.Fatalf("code = %q, want %q", got, apierr.CodeIO)
	}
}

func TestLSPPathsPut_SaveFailureHidesDetail(t *testing.T) {
	f := &fakeLSP{setErr: fmt.Errorf("%w: open %s/lsp.json: permission denied", lsp.ErrPathsSave, leakSecret)}
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{LSP: f})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, apiTestRequest(http.MethodPut, "/api/lsp/paths", strings.NewReader(`{"paths":{"x":"y"}}`)))
	if rec.Code != http.StatusInternalServerError || rec.Header().Get(apierr.CodeHeader) != apierr.CodeSaveFailed {
		t.Fatalf("= %d %s", rec.Code, rec.Header().Get(apierr.CodeHeader))
	}
	if strings.Contains(rec.Body.String(), leakSecret) {
		t.Fatalf("전문이 본문에 실렸다: %q", rec.Body.String())
	}
}

func TestFileWrite_FailureHidesPath(t *testing.T) {
	// 읽기 전용 디렉터리로 쓰기 실패를 만든다 (FR-WTP-31 과 같은 근거).
	if !testpath.PermChecked() {
		t.Skip("유닉스 권한 비트가 없는 OS 다 — 거부 상황을 만들 수 없다")
	}
	if os.Geteuid() == 0 {
		t.Skip("root 로는 권한 거부를 만들 수 없다")
	}
	e := newFileBoundaryEnv(t)
	dir := filepath.Join(e.root, "ro")
	if err := os.Mkdir(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o755) })

	code, body := writeStamped(t, e, filepath.Join(dir, "a.txt"), "x", "")
	if code != http.StatusInternalServerError {
		t.Fatalf("status = %d body=%q", code, body)
	}
	if strings.Contains(body, dir) {
		t.Fatalf("경로가 본문에 실렸다: %q", body)
	}
}
