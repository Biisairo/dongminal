package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
)

// SERVER_DRIVEN_ACTIONS_SRS X-c · TC-SDA-1·10 — 터미널 드롭 업로드의 답과 거절.

func TestTermUploadAnswer(t *testing.T) {
	cases := []struct {
		name, cwd, source string
		ok                bool
	}{
		{"도구의 cwd", "/w", cwdSourceTool, true},
		{"서버로 폴백한 cwd", "/w", cwdSourceServer, false},
		{"빈 cwd", "", cwdSourceTool, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := termUploadAnswer(c.cwd, c.source)
			if a.OK != c.ok {
				t.Fatalf("ok = %v, want %v", a.OK, c.ok)
			}
			if !a.OK && (a.Why != apierr.CodeUploadNoToolCwd || a.Status != http.StatusConflict) {
				t.Fatalf("answer = %+v, want 409 upload_no_tool_cwd", a)
			}
			if !a.OK && !action.Catalog.MayGive(action.TermUpload, a.Why) {
				t.Fatalf("%s 의 사유 %q 가 Catalog 에 없다", action.TermUpload, a.Why)
			}
		})
	}
}

func uploadToolSrv(t *testing.T, cwd string) *Server {
	t.Helper()
	pm := newFakePaneHub()
	pm.seed("p1", "P1")
	pm.setCwd("p1", cwd)
	pm.seed("p2", "P2") // cwd 를 모르는 도구
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

func cwdAnswer(t *testing.T, s *Server, tool string) action.Answer {
	t.Helper()
	rec := httptest.NewRecorder()
	http.HandlerFunc(s.handleAPI).ServeHTTP(rec, apiTestRequest(http.MethodGet, "/api/cwd?tool="+tool, nil))
	var body struct {
		Actions map[string]action.Answer `json:"actions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	a, ok := body.Actions[action.TermUpload]
	if !ok {
		t.Fatalf("/api/cwd 에 %s 답이 없다: %s", action.TermUpload, rec.Body.String())
	}
	return a
}

func toolUpload(t *testing.T, s *Server, query string) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := multipartBody(t, "a.txt", []byte("hi\n"))
	r := apiTestRequest(http.MethodPost, "/api/upload?"+query, body)
	r.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	http.HandlerFunc(s.handleAPI).ServeHTTP(rec, r)
	return rec
}

func TestCwdCarriesUploadAnswer(t *testing.T) {
	srv := uploadToolSrv(t, t.TempDir())
	if a := cwdAnswer(t, srv, "p1"); !a.OK {
		t.Fatalf("도구의 cwd 가 있는데 답이 거짓: %+v", a)
	}
	if a := cwdAnswer(t, srv, "p2"); a.OK || a.Why != apierr.CodeUploadNoToolCwd {
		t.Fatalf("cwd 를 모르는 도구의 답 = %+v, want upload_no_tool_cwd", a)
	}
}

// `tool` 이 있으면 서버가 그 도구의 cwd 로 받는다 — `dir` 은 보지 않는다.
func TestUploadToToolCwd(t *testing.T) {
	cwd := t.TempDir()
	other := t.TempDir()
	srv := uploadToolSrv(t, cwd)
	rec := toolUpload(t, srv, "tool=p1&dir="+url.QueryEscape(other))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(cwd, "a.txt")); err != nil {
		t.Fatalf("도구의 cwd 에 파일이 없다: %v", err)
	}
	if _, err := os.Stat(filepath.Join(other, "a.txt")); err == nil {
		t.Fatal("tool 이 있는데 dir 에 놓았다")
	}
}

// 답이 거짓이면 실행도 같은 코드로 거절되고 아무 데도 쓰지 않는다 (TC-SDA-1).
func TestUploadRejectsWithAnswer(t *testing.T) {
	other := t.TempDir()
	srv := uploadToolSrv(t, t.TempDir())
	want := cwdAnswer(t, srv, "p2")
	want.Status = termUploadAnswer("", cwdSourceServer).Status // 상태는 직렬화하지 않는다
	rec := toolUpload(t, srv, "tool=p2&dir="+url.QueryEscape(other))
	if rec.Code != want.Status || rec.Header().Get(apierr.CodeHeader) != want.Why {
		t.Fatalf("status = %d code = %q, want %d %q", rec.Code, rec.Header().Get(apierr.CodeHeader), want.Status, want.Why)
	}
	if _, err := os.Stat(filepath.Join(other, "a.txt")); err == nil {
		t.Fatal("거절했는데 dir 에 썼다")
	}
}
