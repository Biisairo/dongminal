package httpapi

import (
	"net/http"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
)

// SERVER_DRIVEN_ACTIONS_SRS 묶음 R (FR-SDA-60·61 · TC-SDA-10).

func answerIn(t *testing.T, v any, id string) map[string]any {
	t.Helper()
	obj, _ := v.(map[string]any)
	acts, _ := obj["actions"].(map[string]any)
	a, _ := acts[id].(map[string]any)
	if a == nil {
		t.Fatalf("답 %s 가 없다: %v", id, obj)
	}
	return a
}

func wantAnswer(t *testing.T, v any, id, why string) {
	t.Helper()
	a := answerIn(t, v, id)
	if why == "" {
		if a["ok"] != true {
			t.Errorf("%s = %v, want ok", id, a)
		}
		return
	}
	if a["ok"] != false || a["why"] != why {
		t.Errorf("%s = %v, want why=%s", id, a, why)
	}
	if !action.Catalog.MayGive(id, why) {
		t.Errorf("%s 의 사유 %s 가 action.Catalog 에 없다", id, why)
	}
}

func memberByID(t *testing.T, run map[string]any, id string) map[string]any {
	t.Helper()
	ms, _ := run["members"].([]any)
	for _, m := range ms {
		if mm, _ := m.(map[string]any); mm["id"] == id {
			return mm
		}
	}
	t.Fatalf("멤버 %s 가 없다: %v", id, run["members"])
	return nil
}

func TestRunActionsInViews(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	_, tabbed := postRun(t, f.s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"r","agent":"claude","id":"tab-a"}`)
	tabbedID, _ := tabbed["id"].(string)
	headless := f.addHeadless(t, runID, "writer")
	headlessID, _ := headless["id"].(string)

	_, view := getRun(t, f.s, "/api/runs?id="+runID)
	wantAnswer(t, view, action.RunClose, "")
	wantAnswer(t, view, action.RunDelete, "")
	if view["unreported"] != float64(2) {
		t.Errorf("unreported = %v, want 2", view["unreported"])
	}
	wantAnswer(t, memberByID(t, view, tabbedID), action.RunMemberDetach, "")
	wantAnswer(t, memberByID(t, view, headlessID), action.RunMemberDetach, apierr.CodeMemberNotAttached)

	// 목록과 그래프도 같은 답을 싣는다.
	_, list := getRun(t, f.s, "/api/runs")
	runs, _ := list["runs"].([]any)
	if len(runs) != 1 {
		t.Fatalf("runs = %v", list)
	}
	wantAnswer(t, runs[0], action.RunClose, "")
	_, graph := getRun(t, f.s, "/api/runs/"+runID+"/graph")
	wantAnswer(t, graph, action.RunClose, "")
	wantAnswer(t, memberByID(t, graph, headlessID), action.RunMemberDetach, apierr.CodeMemberNotAttached)

	// 답이 거짓이면 실행도 같은 코드로 거절된다 (TC-SDA-1).
	if code, out := postRun(t, f.s, "/api/runs/detach", `{"memberId":`+testpath.JSONQuote(headlessID)+`}`); code != http.StatusConflict ||
		out["error"] != apierr.CodeMemberNotAttached {
		t.Fatalf("detach: code=%d out=%v", code, out)
	}

	// 끝난 Run 은 종료 답이 거짓이다.
	if _, _, err := f.store.Close(runID, true); err != nil {
		t.Fatal(err)
	}
	_, view = getRun(t, f.s, "/api/runs?id="+runID)
	wantAnswer(t, view, action.RunClose, apierr.CodeRunClosed)
	if code, out := postRun(t, f.s, "/api/runs/close", `{"runId":`+testpath.JSONQuote(runID)+`}`); code != http.StatusConflict ||
		out["error"] != apierr.CodeRunClosed {
		t.Fatalf("close: code=%d out=%v", code, out)
	}
}
