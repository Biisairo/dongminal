package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// OBSERVABILITY_SRS §4.3 — `GET /api/diag` (TC-OBS-9~11).

func diagOf(t *testing.T, srv *Server) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.apiDiag(rec, httptest.NewRequest("GET", "/api/diag", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("JSON 이 아니다: %v\n%s", err, rec.Body.String())
	}
	return m
}

// TC-OBS-9: 표의 필드를 전부 낸다.
func TestDiagHasAllFields(t *testing.T) {
	srv := &Server{Deps: Deps{Tools: newFakePaneHub()}, cfg: Config{Version: "v-test"}}
	m := diagOf(t, srv)
	for _, k := range []string{"tools", "ws", "goroutines", "allocMB", "persistErr", "gate", "reconnects", "uptime", "version"} {
		if _, ok := m[k]; !ok {
			t.Errorf("필드 %q 가 없다: %v", k, m)
		}
	}
	gate, ok := m["gate"].(map[string]any)
	if !ok {
		t.Fatalf("gate 가 객체가 아니다: %v", m["gate"])
	}
	for _, k := range []string{"access", "request"} {
		if _, ok := gate[k]; !ok {
			t.Errorf("gate.%s 가 없다: %v", k, gate)
		}
	}
	if m["version"] != "v-test" {
		t.Errorf("version = %v", m["version"])
	}
}

// TC-OBS-10: 거절 수가 **실제 거절에 따라** 오른다.
func TestDiagGateCountersRise(t *testing.T) {
	srv := &Server{Deps: Deps{Tools: newFakePaneHub()}}
	before := diagOf(t, srv)["gate"].(map[string]any)

	gateDeny(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil),
		http.StatusForbidden, "origin", "forbidden")
	countAccessDenied()

	after := diagOf(t, srv)["gate"].(map[string]any)
	if after["request"].(float64) <= before["request"].(float64) {
		t.Errorf("출처 거절 수가 오르지 않았다: %v → %v", before["request"], after["request"])
	}
	if after["access"].(float64) <= before["access"].(float64) {
		t.Errorf("기기 거절 수가 오르지 않았다: %v → %v", before["access"], after["access"])
	}
}

// TC-OBS-11 — **개별 식별 정보를 싣지 않는다** (FR-OBS-13 / D-OBS-5).
//
// 세는 것과 기록하는 것은 다르다. 인증이 없다는 사실이 이 선을 더 굵게 만든다.
func TestDiagCarriesNoIdentifyingInfo(t *testing.T) {
	f := newFakePaneHub()
	if _, err := f.Create("/Users/secret/project", 80, 24, toolhubPlacementZero()); err != nil {
		t.Fatal(err)
	}
	srv := &Server{Deps: Deps{Tools: f}}
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/diag", nil)
	r.RemoteAddr = "192.168.7.7:5555"
	srv.apiDiag(rec, r)
	body := rec.Body.String()
	for _, leak := range []string{"192.168.7.7", "/Users/secret", "fake1", "Fake"} {
		if strings.Contains(body, leak) {
			t.Errorf("%q 가 응답에 실렸다:\n%s", leak, body)
		}
	}
}

// FR-OBS-14: 헬스와 겹치지 않는다 — 판 불일치·워크스페이스 rev 는 저쪽의 것이다.
func TestDiagDoesNotDuplicateHealth(t *testing.T) {
	srv := &Server{Deps: Deps{Tools: newFakePaneHub()}}
	m := diagOf(t, srv)
	for _, k := range []string{"daemon", "workspace", "mismatch"} {
		if _, ok := m[k]; ok {
			t.Errorf("헬스의 것이 진단에 있다: %q", k)
		}
	}
}

func toolhubPlacementZero() (p toolhub.Placement) { return }
