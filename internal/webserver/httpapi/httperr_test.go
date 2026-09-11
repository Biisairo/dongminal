package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/apierr"
)

// ERROR_CONTRACT_SRS §4 — 코드화와 헤더 (TC-ERR-1·2).

// TC-ERR-1 — **본문이 `http.Error` 와 바이트 단위로 같다** (FR-ERR-5 / D-ERR-2).
//
// 방언을 통일하지 않는다는 결정(`architecture.md`)은 "본문은 공개 계약이다" 라는
// 뜻이다. 코드를 얻자고 그 계약을 깨면 이 작업은 리팩터가 아니라 파괴적 변경이 된다.
func TestHTTPErrBodyMatchesStdlibByteForByte(t *testing.T) {
	for _, tc := range []struct {
		msg    string
		status int
	}{
		{"bad request", http.StatusBadRequest},
		{"forbidden", http.StatusForbidden},
		{"toolId=abc 존재하지 않음", http.StatusNotFound},
		{"", http.StatusInternalServerError},
	} {
		want := httptest.NewRecorder()
		http.Error(want, tc.msg, tc.status)

		got := httptest.NewRecorder()
		httpErr(got, tc.msg, tc.status, apierr.CodeBadRequest)

		if got.Body.String() != want.Body.String() {
			t.Errorf("본문이 달라졌다\n  got:  %q\n  want: %q", got.Body.String(), want.Body.String())
		}
		if got.Code != want.Code {
			t.Errorf("상태 = %d, want %d", got.Code, want.Code)
		}
		if got.Header().Get("Content-Type") != want.Header().Get("Content-Type") {
			t.Errorf("Content-Type = %q, want %q",
				got.Header().Get("Content-Type"), want.Header().Get("Content-Type"))
		}
	}
}

// TC-ERR-2: 코드가 헤더에 실린다.
func TestHTTPErrCarriesCodeHeader(t *testing.T) {
	rec := httptest.NewRecorder()
	httpErr(rec, "not found", http.StatusNotFound, apierr.CodeNotFound)
	if got := rec.Header().Get(apierr.CodeHeader); got != apierr.CodeNotFound {
		t.Errorf("%s = %q, want %q", apierr.CodeHeader, got, apierr.CodeNotFound)
	}
}

// 코드를 주지 않으면 상태에서 고른다 — 옮기다 빠뜨린 자리가 **코드 없는 응답**이
// 되지 않게 한다. 빈 헤더는 "코드가 없다" 가 아니라 "옮기다 잊었다" 로 읽힌다.
func TestHTTPErrFallsBackToStatusCode(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   string
	}{
		{http.StatusBadRequest, apierr.CodeBadRequest},
		{http.StatusNotFound, apierr.CodeNotFound},
		{http.StatusForbidden, apierr.CodeForbidden},
		{http.StatusInternalServerError, apierr.CodeInternal},
	} {
		rec := httptest.NewRecorder()
		httpErr(rec, "x", tc.status, "")
		if got := rec.Header().Get(apierr.CodeHeader); got != tc.want {
			t.Errorf("status %d → %q, want %q", tc.status, got, tc.want)
		}
	}
}

// TC-ERR-9 — **방언마다 헤더의 값이 본문의 코드와 같다** (FR-ERR-7).
//
// 두 자리가 갈리면 헤더 쪽이 거짓말이 된다 — 그리고 거짓말하는 헤더는 없는
// 헤더보다 나쁘다.
func TestDialectHeaderMatchesBodyCode(t *testing.T) {
	// fs 방언 — `{"code": …, "message": …}`
	rec := httptest.NewRecorder()
	jsonFail(rec)(http.StatusNotFound, apierr.CodeNotFound, "없다")
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("fs 방언이 JSON 이 아니다: %v", err)
	}
	if got := rec.Header().Get(apierr.CodeHeader); got != body.Code {
		t.Errorf("fs: 헤더 %q ≠ 본문 %q", got, body.Code)
	}

	// 단문 방언 — 본문에 코드를 담을 자리가 없으므로 헤더만 본다.
	rec = httptest.NewRecorder()
	writeToolIOError(rec, http.StatusBadRequest, "나쁜 요청")
	if got := rec.Header().Get(apierr.CodeHeader); got != apierr.CodeBadRequest {
		t.Errorf("단문: 헤더 = %q", got)
	}
	if !strings.Contains(rec.Body.String(), "나쁜 요청") {
		t.Errorf("단문 방언의 본문이 바뀌었다: %s", rec.Body.String())
	}
}

// 헤더에 나가는 모든 코드는 카탈로그에 있어야 한다 (FR-ERR-2).
func TestHeaderCodesAreRegistered(t *testing.T) {
	known := map[string]bool{}
	for _, c := range apierr.AllCodes() {
		known[c] = true
	}
	for _, status := range []int{400, 403, 404, 405, 409, 413, 421, 428, 500, 503} {
		c := apierr.CodeForStatus(status)
		if !known[c] {
			t.Errorf("status %d 이 등록되지 않은 코드 %q 를 낸다", status, c)
		}
	}
}
