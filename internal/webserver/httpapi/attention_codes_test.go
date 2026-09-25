package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/apierr"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-1-9 (HTTP-17) — attention 계열은 해석 실패와
// 필수 인자 누락을 다른 코드로 답한다. 둘의 복구 안내(`codes_doc.go`)가 다르다.
// 본문은 바꾸지 않는다 — 코드는 헤더로만 갈린다 (ERROR_CONTRACT FR-ERR-5).
func TestAttentionFamily_BadRequestCodes(t *testing.T) {
	s := &Server{}
	handlers := map[string]http.HandlerFunc{
		"attention/set":   s.apiToolAttentionSet,
		"attention/clear": s.apiToolAttentionClear,
		"activity/set":    s.apiToolActivitySet,
		"background/set":  s.apiToolBackgroundSet,
	}
	for name, h := range handlers {
		for _, c := range []struct {
			body, code string
		}{
			{`{"toolId":`, apierr.CodeInvalidJSON},
			{`{"state":"working"}`, apierr.CodeMissingArg},
		} {
			rec := httptest.NewRecorder()
			h(rec, apiTestRequest(http.MethodPost, "/api/tools/"+name, strings.NewReader(c.body)))
			if rec.Code != http.StatusBadRequest || rec.Header().Get(apierr.CodeHeader) != c.code {
				t.Errorf("%s %s = %d %q, want 400 %q", name, c.body, rec.Code, rec.Header().Get(apierr.CodeHeader), c.code)
			}
		}
	}

	for _, c := range []struct {
		body, code string
	}{
		{`{"toolId":"1"}`, apierr.CodeMissingArg},
		{`{"toolId":"1","state":"sleeping"}`, apierr.CodeBadRequest},
	} {
		rec := httptest.NewRecorder()
		s.apiToolActivitySet(rec, apiTestRequest(http.MethodPost, "/api/tools/activity/set", strings.NewReader(c.body)))
		if rec.Code != http.StatusBadRequest || rec.Header().Get(apierr.CodeHeader) != c.code {
			t.Errorf("activity/set %s = %d %q, want 400 %q", c.body, rec.Code, rec.Header().Get(apierr.CodeHeader), c.code)
		}
		if rec.Body.String() != "bad request\n" {
			t.Errorf("activity/set %s: 본문 %q — 본문은 바뀌지 않아야 한다", c.body, rec.Body.String())
		}
	}
}
