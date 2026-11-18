package httpresp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 종전 인라인(`Set Content-Type` → [WriteHeader] → `json.NewEncoder(w).Encode`)과
// 바이트가 같아야 한다 — 개행·HTML 이스케이프까지 (FR-OPT-0-3).
func TestJSON_MatchesInlineEncoder(t *testing.T) {
	v := map[string]any{"a": "<&>", "n": 1}
	old := httptest.NewRecorder()
	old.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(old).Encode(v)

	got := httptest.NewRecorder()
	JSON(got, http.StatusOK, v)
	if got.Code != old.Code || got.Body.String() != old.Body.String() ||
		got.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("got %d %q %v, want %d %q", got.Code, got.Body.String(), got.Header(), old.Code, old.Body.String())
	}
}

func TestJSON_WritesStatus(t *testing.T) {
	rec := httptest.NewRecorder()
	JSON(rec, http.StatusConflict, map[string]string{"error": "x"})
	if rec.Code != http.StatusConflict || rec.Body.String() != "{\"error\":\"x\"}\n" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}
