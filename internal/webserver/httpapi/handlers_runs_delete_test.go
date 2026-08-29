package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"dongminal/internal/webserver/domain/run"

	"dongminal/internal/shared/testpath"
)

// 묶음 D — Run 수명 (UX_REVISION_SRS §3.1, V-DEL-1~7).

func deleteRun(t *testing.T, s *Server, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, path, nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func startRunFor(t *testing.T, store *run.Store, objective, coordinator string) run.Record {
	t.Helper()
	rec, err := store.Start(run.StartOptions{
		Objective: objective, Projection: run.DedicatedWindow,
		Isolation: run.IsolationNone, CoordinatorToolID: coordinator,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	return rec
}

// V-DEL-1 (FR-DEL-5/7): DELETE 종단이 레코드를 지운다.
func TestApiRunDelete_RemovesRecord(t *testing.T) {
	s, _, store, _ := runsServer(t, "tool-a")
	rec := startRunFor(t, store, "지울 것", "tool-a")

	code, out := deleteRun(t, s, "/api/runs/"+rec.ID)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d (%+v)", code, out)
	}
	if out["id"] != rec.ID {
		t.Fatalf("지운 Run 의 id 를 돌려줘야 한다: %+v", out)
	}
	if _, ok := store.Get(rec.ID); ok {
		t.Fatal("레코드가 남아 있다")
	}
	code, list := getRun(t, s, "/api/runs")
	if code != http.StatusOK {
		t.Fatalf("목록 조회 실패: %d", code)
	}
	runs, _ := list["runs"].([]any)
	if len(runs) != 0 {
		t.Fatalf("목록에 남아 있다: %+v", runs)
	}
}

// FR-DEL-5: 없는 Run 의 삭제는 404 이며 사유를 뭉뚱그리지 않는다.
func TestApiRunDelete_UnknownIs404(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	code, out := deleteRun(t, s, "/api/runs/없는-run")
	if code != http.StatusNotFound {
		t.Fatalf("want 404, got %d (%+v)", code, out)
	}
	if out["error"] != "unknown_run" {
		t.Fatalf("사유가 없다: %+v", out)
	}
}

// V-DEL-4 (FR-DEL-12): close 가 성공하면 그 레코드도 사라진다.
func TestApiRunClose_DeletesRecord(t *testing.T) {
	s, _, store, _ := runsServer(t, "tool-a")
	rec := startRunFor(t, store, "닫고 지운다", "tool-a")

	code, out := postRun(t, s, "/api/runs/close", `{"runId":`+testpath.JSONQuote(rec.ID)+`,"force":true}`)
	if code != http.StatusOK {
		t.Fatalf("close 실패 %d: %+v", code, out)
	}
	// 응답은 close 의 것을 그대로 유지한다 — 조정자가 cleanup 목록으로 탭을 닫는다.
	if out["cleanup"] == nil {
		t.Fatalf("close 응답 계약이 깨졌다: %+v", out)
	}
	if _, ok := store.Get(rec.ID); ok {
		t.Fatal("close 뒤에도 레코드가 남아 있다 (FR-DEL-12)")
	}
}

// V-DEL-5/6 (FR-DEL-13/15): 수거는 조정자가 죽은 열린 Run 과 이미 끝난 Run 을 지우고,
// 조정자를 모르는 Run 과 살아 있는 Run 은 건드리지 않는다.
func TestReapRuns(t *testing.T) {
	s, _, store, _ := runsServer(t, "tool-a")
	live := startRunFor(t, store, "살아 있다", "tool-a") // runsServer 가 live 로 등록한 도구
	dead := startRunFor(t, store, "조정자 죽음", "tool-gone")
	anon := startRunFor(t, store, "조정자 모름", "")

	n := s.reapRuns()
	if n != 2 {
		// dead 하나 + (아직 없음) — anon·live 는 대상이 아니다.
		if n != 1 {
			t.Fatalf("수거 건수가 예상 밖이다: %d", n)
		}
	}
	if _, ok := store.Get(dead.ID); ok {
		t.Fatal("조정자가 죽은 Run 이 남아 있다")
	}
	if _, ok := store.Get(live.ID); !ok {
		t.Fatal("조정자가 살아 있는 Run 을 지웠다")
	}
	if _, ok := store.Get(anon.ID); !ok {
		t.Fatal("조정자를 모르는 Run 을 지웠다 (FR-DEL-15)")
	}
}
