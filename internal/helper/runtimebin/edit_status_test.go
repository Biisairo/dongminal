package runtimebin

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// REFACTOR3_DEFECTS_SRS TC-RD3-60: 서버가 4xx·5xx 를 주면 dmctl edit 은 1 이다.
// 이전에는 상태를 버려 본문을 stdout 에 찍고 0 을 돌려주었다.
func TestEdit_ServerErrorExitsOne(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"bad"}`)
	}))
	defer srv.Close()
	setTestServer(t, srv)
	f := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out, errb bytes.Buffer
	if rc := runEdit([]string{f}, &out, &errb); rc != 1 {
		t.Fatalf("rc=%d want 1 (stdout=%q)", rc, out.String())
	}
	if out.Len() != 0 || errb.Len() == 0 {
		t.Fatalf("오류는 stderr 로 간다: stdout=%q stderr=%q", out.String(), errb.String())
	}
}

// 2xx 는 종전과 같다 — 본문을 stdout 에 찍고 0.
func TestEdit_OKEchoes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer srv.Close()
	setTestServer(t, srv)
	f := filepath.Join(t.TempDir(), "a.txt")
	_ = os.WriteFile(f, []byte("x"), 0o644)
	var out, errb bytes.Buffer
	if rc := runEdit([]string{f}, &out, &errb); rc != 0 || out.String() != "{\"ok\":true}\n" {
		t.Fatalf("rc=%d stdout=%q", rc, out.String())
	}
}
