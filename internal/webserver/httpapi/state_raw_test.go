package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-6 (HTTP-8 · IPC-21) · FR-OPT-8-5 (SHR-31) — /api/state 는
// workspace blob 을 해석하지 않고 넘긴다. 깨진 blob 은 종전처럼 null 이다. 서버가
// 설정에서 읽은 fgTabNames 를 선택 필드로 싣는다.
func stateBody(t *testing.T, s *Server) (map[string]json.RawMessage, []byte) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiStateGet(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	if rec.Code != 200 {
		t.Fatalf("code = %d", rec.Code)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("응답이 JSON 이 아니다: %v (%s)", err, rec.Body.Bytes())
	}
	return m, rec.Body.Bytes()
}

func TestState_WorkspacePassedThroughAndSettingCarried(t *testing.T) {
	ws := newFakeWorkspaceStore()
	// 저장된 그대로의 키 순서 — 해석·재직렬화하면 키가 정렬된다.
	ws.raw = []byte(`{"windows":[],"activeWindow":"w1","schemaVersion":2}`)
	ws.rev = 3
	st := &fakeSettingsStore{blob: []byte(`{"fgTabNames":false}`)}
	s := &Server{Deps: Deps{Tools: newFakePaneHub(), Work: ws, Settings: st}}

	m, raw := stateBody(t, s)
	if string(m["workspace"]) != `{"windows":[],"activeWindow":"w1","schemaVersion":2}` {
		t.Fatalf("workspace = %s — 바이트를 그대로 넘기지 않았다", m["workspace"])
	}
	if string(m["fgTabNames"]) != "false" {
		t.Fatalf("fgTabNames = %s", m["fgTabNames"])
	}
	// 기존 키의 순서는 그대로다 (FR-OPT-0-3) — 새 필드는 끝에 붙는다.
	iT, iK, iW, iF := bytes.Index(raw, []byte(`"tools"`)), bytes.Index(raw, []byte(`"toolsKnown"`)),
		bytes.Index(raw, []byte(`"workspace"`)), bytes.Index(raw, []byte(`"fgTabNames"`))
	if !(iT < iK && iK < iW && iW < iF) {
		t.Fatalf("키 순서가 바뀌었다: %s", raw)
	}

	// 설정이 없으면 기본(켬)이다 — dmctl 의 기본과 같다.
	st.Set(nil)
	if m, _ := stateBody(t, s); string(m["fgTabNames"]) != "true" {
		t.Fatalf("기본 fgTabNames = %s", m["fgTabNames"])
	}
}

func TestState_BrokenOrEmptyWorkspaceIsNull(t *testing.T) {
	ws := newFakeWorkspaceStore()
	s := &Server{Deps: Deps{Tools: newFakePaneHub(), Work: ws}}
	for _, raw := range []string{"", `{"windows":`} {
		ws.raw = []byte(raw)
		if m, _ := stateBody(t, s); string(m["workspace"]) != "null" {
			t.Fatalf("raw %q → workspace = %s, want null", raw, m["workspace"])
		}
	}
}

func BenchmarkStateGet(b *testing.B) {
	ws := newFakeWorkspaceStore()
	var buf bytes.Buffer
	buf.WriteString(`{"schemaVersion":2,"activeWindow":"w0","windows":[`)
	for i := 0; i < 20; i++ {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.WriteString(`{"id":"w","name":"창","focusedPane":"p","layout":{"type":"pane","id":"p","activeTab":"t","tabs":[{"id":"t","name":"Shell","type":"terminal","toolId":"x"},{"id":"u","name":"Shell","type":"terminal","toolId":"y"}]}}`)
	}
	buf.WriteString(`]}`)
	ws.raw = buf.Bytes()
	s := &Server{Deps: Deps{Tools: newFakePaneHub(), Work: ws}}
	r := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s.apiStateGet(httptest.NewRecorder(), r)
	}
}
