package httpresp

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-2: 오류 응답의 한 문. 방언별 바이트는 종전 인라인과 같다.
func TestFail_JSONMatchesInline(t *testing.T) {
	body := map[string]any{"error": "<x>", "n": 1}
	old := httptest.NewRecorder()
	old.Header().Set("X-Error-Code", "c")
	old.Header().Set("Content-Type", "application/json")
	old.WriteHeader(http.StatusConflict)
	_ = json.NewEncoder(old).Encode(body)

	got := httptest.NewRecorder()
	Fail(got, http.StatusConflict, "c", body)
	assertSame(t, got, old)
}

// 평문 방언은 `http.Error` 와 바이트가 같다.
func TestFail_TextMatchesHTTPError(t *testing.T) {
	old := httptest.NewRecorder()
	old.Header().Set("X-Error-Code", "bad_request")
	http.Error(old, "read body", http.StatusBadRequest)

	got := httptest.NewRecorder()
	Fail(got, http.StatusBadRequest, "bad_request", Text("read body"))
	assertSame(t, got, old)
}

// 미리 직렬화한 본문은 그대로 나간다 — 끝 개행을 붙이지 않는다.
func TestFail_RawWritesBytes(t *testing.T) {
	raw := []byte(`{"code":"edge_not_edge","message":"x"}`)
	got := httptest.NewRecorder()
	Fail(got, http.StatusForbidden, "edge_not_edge", Raw(raw))
	if got.Code != http.StatusForbidden || !bytes.Equal(got.Body.Bytes(), raw) ||
		got.Header().Get(CodeHeader) != "edge_not_edge" || got.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("got %d %q %v", got.Code, got.Body.String(), got.Header())
	}
}

// `{code,message}` 방언 (FR-RDG-4).
func TestFailCode(t *testing.T) {
	got := httptest.NewRecorder()
	FailCode(got, http.StatusBadRequest, "invalid_json", "invalid json")
	if got.Code != http.StatusBadRequest || got.Body.String() != "{\"code\":\"invalid_json\",\"message\":\"invalid json\"}\n" ||
		got.Header().Get(CodeHeader) != "invalid_json" || got.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("got %d %q %v", got.Code, got.Body.String(), got.Header())
	}
}

func assertSame(t *testing.T, got, want *httptest.ResponseRecorder) {
	t.Helper()
	if got.Code != want.Code || got.Body.String() != want.Body.String() {
		t.Fatalf("got %d %q, want %d %q", got.Code, got.Body.String(), want.Code, want.Body.String())
	}
	if len(got.Header()) != len(want.Header()) {
		t.Fatalf("headers %v want %v", got.Header(), want.Header())
	}
	for k := range want.Header() {
		if got.Header().Get(k) != want.Header().Get(k) {
			t.Fatalf("header %s=%q want %q", k, got.Header().Get(k), want.Header().Get(k))
		}
	}
}

// TC-RDG-2: 헤더 이름 리터럴은 이 패키지 밖의 비시험 코드에 없다 (FR-RDG-1).
func TestCodeHeaderLiteral_OnlyHere(t *testing.T) {
	if CodeHeader != "X-Error-Code" {
		t.Fatalf("CodeHeader=%q", CodeHeader)
	}
	root := moduleRoot(t)
	self, _ := filepath.Abs(".")
	lit := []byte(`"X-Error-Code"`)
	var hits []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", ".claude", "node_modules":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") || filepath.Dir(p) == self {
			return nil
		}
		b, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		if bytes.Contains(b, lit) {
			hits = append(hits, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) > 0 {
		t.Fatalf("X-Error-Code 리터럴이 httpresp 밖에 있다: %v", hits)
	}
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	dir, _ := filepath.Abs(".")
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod 를 찾지 못했다")
		}
		dir = parent
	}
}
