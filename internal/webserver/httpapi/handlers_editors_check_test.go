package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
)

// SERVER_DRIVEN_ACTIONS_SRS 묶음 F-3 (FR-SDA-55 · TC-SDA-1): 편집기 루트 추가의 답과 거절은
// 같은 판정이다.
func TestEditorAddAnswerMatchesRejection(t *testing.T) {
	s, _, _ := fsTestServer(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ path, why string }{
		{"", apierr.CodeEmptyPath},
		{"rel/dir", apierr.CodeAbsPathNeeded},
		{filepath.Join(dir, "gone"), apierr.CodeNotFound},
		{file, apierr.CodeNotADirectory},
		{testpath.Root(), apierr.CodeFilesystemRootProtected},
	}
	for _, c := range cases {
		body := `{"path":` + testpath.JSONQuote(c.path) + `}`
		code, out := fsReq(t, s, http.MethodPost, "/api/editors/validate", body)
		if code != http.StatusOK {
			t.Fatalf("validate %q: code=%d body=%v", c.path, code, out)
		}
		wantFSAnswer(t, out, action.EditorAdd, c.why)

		code, out = fsReq(t, s, http.MethodPost, "/api/editors/add", body)
		if code != apierr.FSStatus(c.why) || out["code"] != c.why {
			t.Fatalf("add %q: code=%d body=%v, want %s", c.path, code, out, c.why)
		}
		if _, has := out["message"]; has {
			t.Fatalf("add %q: 거절에 서버 문구가 실렸다: %v", c.path, out)
		}
	}

	_, out := fsReq(t, s, http.MethodPost, "/api/editors/validate", `{"path":`+testpath.JSONQuote(dir)+`}`)
	wantFSAnswer(t, out, action.EditorAdd, "")
	if code, out := fsReq(t, s, http.MethodPost, "/api/editors/add", `{"path":`+testpath.JSONQuote(dir)+`}`); code != 200 {
		t.Fatalf("add: code=%d body=%v", code, out)
	}
}

func TestEditorsValidateRouteRegistered(t *testing.T) {
	for _, rt := range apiRoutes {
		if rt.Method == http.MethodPost && rt.Match("/api/editors/validate") {
			return
		}
	}
	t.Fatal("POST /api/editors/validate 가 apiRoutes 에 없다")
}
