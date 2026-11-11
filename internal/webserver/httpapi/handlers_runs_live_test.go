package httpapi

import (
	"fmt"
	"net/http"
	"testing"

	"dongminal/internal/shared/testpath"
)

// RUN_VIEW_LIVE_SRS — 열린 대시보드가 새로고침 없이 따라오게 하는 신호 (TC-RLV-1~3).

func runChangedCount(fb *fakeCommandBroker) int { return len(publishedActions(fb, "run_changed")) }

// TC-RLV-1 (FR-RLV-1·2): Run 시작과 멤버 등록이 각각 run_changed 를 한 번 보낸다.
func TestRunLive_StartAndMemberAddBroadcast(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	fb := &fakeCommandBroker{}
	s.Commands = fb

	runID := startRun(t, s)
	sent := publishedActions(fb, "run_changed")
	if len(sent) != 1 {
		t.Fatalf("Run 시작 뒤 run_changed 가 한 번 나가야 한다: %d", len(sent))
	}
	if args, _ := sent[0]["args"].(map[string]any); args == nil || args["runId"] != runID {
		t.Fatalf("payload 가 runId 를 담지 않았다: %+v", sent[0])
	}

	if code, out := postRun(t, s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":"tool-b"}`); code != http.StatusOK {
		t.Fatalf("멤버 등록 실패 %d (%+v)", code, out)
	}
	if got := runChangedCount(fb); got != 2 {
		t.Fatalf("멤버 등록 뒤 run_changed 가 한 번 더 나가야 한다: %d", got)
	}
}

// TC-RLV-2 (FR-RLV-3): 승계가 run_changed 를 한 번 보낸다.
func TestRunLive_SucceedBroadcasts(t *testing.T) {
	s, _, _, _, m := ctxServer(t)
	fb := &fakeCommandBroker{}
	s.Commands = fb

	code, out := postRun(t, s, "/api/runs/succeed", fmt.Sprintf(`{"memberId":%q,"at":"tab-c","timeoutMs":1}`, m.ID))
	if code != http.StatusOK {
		t.Fatalf("succeed 실패 %d (%+v)", code, out)
	}
	if got := runChangedCount(fb); got != 1 {
		t.Fatalf("승계 뒤 run_changed 가 한 번 나가야 한다: %d", got)
	}
}

// TC-RLV-3 (FR-RLV-4): 맥락 관측은 등급이 바뀔 때만 보낸다. 조정자 관측은 보내지 않는다.
func TestRunLive_ContextBroadcastsOnLevelChangeOnly(t *testing.T) {
	s, _, _, _, _ := ctxServer(t)
	fb := &fakeCommandBroker{}
	s.Commands = fb

	steps := []struct {
		ratio float64
		want  int
	}{
		{0.20, 1}, // 등급 없음 → ok
		{0.30, 1}, // ok 그대로
		{0.75, 2}, // → warn
		{0.80, 2}, // warn 그대로
		{0.20, 3}, // → ok
	}
	for i, st := range steps {
		observe(t, s, "tool-b", bytesFor(st.ratio), false)
		if got := runChangedCount(fb); got != st.want {
			t.Fatalf("관측 %d (%.2f): run_changed %d건, 기대 %d건", i, st.ratio, got, st.want)
		}
	}

	observe(t, s, "tool-a", bytesFor(0.90), false)
	if got := runChangedCount(fb); got != 3 {
		t.Fatalf("조정자 관측이 run_changed 를 보냈다: %d건", got)
	}
}
