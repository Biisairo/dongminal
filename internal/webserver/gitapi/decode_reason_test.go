package gitapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// QUALITY_GO_SRS TC-QG-1: git 디코더의 답에 Go 타입 이름이 없고 필드 경로는 있다 (FR-QG-1).
// 이전: `json: cannot unmarshal number into Go struct field gitPathReq.path of type string`.
func TestGitDecodeHidesGoTypes(t *testing.T) {
	w := httptest.NewRecorder()
	gitDecodeRawPath(w, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"path":1}`)))
	body := w.Body.String()
	if w.Code != http.StatusBadRequest || w.Header().Get("X-Error-Code") != "bad_request" {
		t.Fatalf("got %d %v", w.Code, w.Header())
	}
	if strings.Contains(body, "gitPathReq") || strings.Contains(body, "Go struct") {
		t.Fatalf("본문에 Go 타입 이름이 샌다: %s", body)
	}
	want := "{\"error\":\"bad_request\",\"message\":\"본문이 JSON 이 아니다: path: number 값은 맞지 않다\"}\n"
	if body != want {
		t.Fatalf("본문 %q, want %q", body, want)
	}
}

// TC-QG-3: 핀 추가·빼기의 저장 실패는 고정 문구다 — 원인(작업 공간 파일의 해석 오류·경로)은
// 로그로만 간다. 상태와 코드는 그대로다 (FR-QG-5).
func TestGitPinSaveFailIsFixed(t *testing.T) {
	w := httptest.NewRecorder()
	(&GitServer{}).apiGitUnpin(w, httptest.NewRequest(http.MethodPost, "/api/git/repos/unpin",
		strings.NewReader(`{"path":"/nope"}`)))
	want := "{\"error\":\"git_failed\",\"message\":\"핀 목록을 저장하지 못했다\"}\n"
	if w.Code != http.StatusInternalServerError || w.Body.String() != want {
		t.Fatalf("got %d %q, want 500 %q", w.Code, w.Body.String(), want)
	}
}
