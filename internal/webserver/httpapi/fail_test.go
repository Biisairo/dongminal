package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/httpreq"
)

// 04-secops `SEC-17` · 01-go-arch `GO-11` — **내부 사정이 응답 본문으로 나가지
// 않는다.**
//
// 종전에는 아홉 자리가 오류의 전문을 그대로 실었다. 그 안에는 절대경로·명령줄·
// git 인자가 들어 있고, 브라우저 매개 공격자에게 그것은 곧 정찰 정보다.

func TestFail_HidesInternalDetail(t *testing.T) {
	secret := "/Users/someone/.ssh/id_ed25519: permission denied"
	rec := httptest.NewRecorder()
	fail(rec, http.StatusInternalServerError, "샌드박스 정의를 읽지 못했습니다", errors.New(secret))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, secret) {
		t.Fatalf("오류 전문이 본문에 실렸다: %q", body)
	}
	if !strings.Contains(body, "샌드박스 정의를 읽지 못했습니다") {
		t.Fatalf("호출자가 정한 문구가 없다: %q", body)
	}
}

// 사용자에게 하려고 쓴 말은 그대로 나간다 — 감추면 사용자가 고칠 수 없다.
func TestFail_ShowsUserFacingMessage(t *testing.T) {
	rec := httptest.NewRecorder()
	fail(rec, http.StatusBadRequest, `entries[2]: "10.0.0.300" 는 IP·CIDR·호스트명 중 어느 것도 아니다`, nil)
	if !strings.Contains(rec.Body.String(), "10.0.0.300") {
		t.Fatalf("사유가 사라졌다: %q", rec.Body.String())
	}
}

// 상한 초과는 사유가 보이고, 그 밖의 읽기 실패는 감춘다.
func TestFailRead_Classifies(t *testing.T) {
	rec := httptest.NewRecorder()
	failRead(rec, httpreq.ErrTooLarge)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code = %d, want 413", rec.Code)
	}

	rec2 := httptest.NewRecorder()
	failRead(rec2, errors.New("read tcp 127.0.0.1:58146->127.0.0.1:1234: i/o timeout"))
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec2.Code)
	}
	if strings.Contains(rec2.Body.String(), "127.0.0.1") {
		t.Fatalf("연결 사정이 본문에 실렸다: %q", rec2.Body.String())
	}
}
