package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// QUALITY_GO_SRS TC-QG-11: 나쁜 `customTheme` 의 PUT 은 400 `bad_request` 로 거절되고
// 저장되지 않는다. 정상 블롭은 종전대로 200 (FR-QG-11).
//
// 이전: 서버는 JSON 인지만 보고 그대로 저장했다 — 따옴표가 든 색 값이 다른 기기로
// 방송됐다(PROD3 FC-F1). 화면만 막았다(REFACTOR3_DEFECTS_SRS D-RD3-1).
func TestSettingsPutRejectsBadTheme(t *testing.T) {
	p := filepath.Join(t.TempDir(), "settings.json")
	s := &Server{Deps: Deps{Settings: newSettingsStore(p)}}
	put := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.apiSettingsPut(rec, apiTestRequest(http.MethodPut, "/api/settings", strings.NewReader(body)))
		return rec
	}

	rec := put(`{"customTheme":{"ui":{"bg":"red\"><img src=x onerror=alert(1)>"}}}`)
	if rec.Code != http.StatusBadRequest || rec.Header().Get("X-Error-Code") != "bad_request" {
		t.Fatalf("got %d %q, want 400 bad_request", rec.Code, rec.Header().Get("X-Error-Code"))
	}
	if !strings.Contains(rec.Body.String(), "customTheme.ui.bg") {
		t.Fatalf("본문이 어긴 자리를 말하지 않는다: %q", rec.Body.String())
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("거절했는데 저장했다: %v", err)
	}

	ok := `{"customTheme":{"mode":"light","ui":{"bg":"#ffffff"},"terminal":{"red":"#ff000080"}}}`
	if rec := put(ok); rec.Code != http.StatusOK {
		t.Fatalf("정상 블롭 %d", rec.Code)
	}
}
