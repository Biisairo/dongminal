package httpapi

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
)

// UX_BATCH6_SRS — 백그라운드 방송(묶음 B)과 Run 정리·승계(묶음 N)의 서버 절반.

// ── 묶음 B ──────────────────────────────────────────

// V-BGP-2 (FR-BGP-2): `background/set` 이 방송한다.
//
// 이 자리인 이유는 **두 모드가 공유하는 유일한 자리**이기 때문이다 — 데몬 모드에서
// `SetBackground` 는 웹서버가 아니라 데몬 프로세스에서 돌아 알릴 구독자가 없다.
func TestBackgroundSet_Broadcasts(t *testing.T) {
	f := newHeadlessFixture(t)
	f.resetActions()
	code, _ := postRun(t, f.s, "/api/tools/background/set", `{"toolId":"tool-a","background":true}`)
	if code != http.StatusOK {
		t.Fatalf("background/set want 200, got %d", code)
	}
	f.waitAction(t, "tools_background_changed")
}

// 되돌림도 같은 사건이다 — 배지의 수가 줄어드는 쪽도 다른 브라우저에 닿아야 한다.
func TestBackgroundRestore_Broadcasts(t *testing.T) {
	f := newHeadlessFixture(t)
	postRun(t, f.s, "/api/tools/background/set", `{"toolId":"tool-a","background":true}`)
	f.resetActions()
	code, _ := postRun(t, f.s, "/api/tools/background/set", `{"toolId":"tool-a","background":false}`)
	if code != http.StatusOK {
		t.Fatalf("background/set(false) want 200, got %d", code)
	}
	f.waitAction(t, "tools_background_changed")
}

// V-BGP-3 (FR-BGP-3): 헤드리스 생성이 명령을 받아 넘긴다.
func TestToolsHeadless_PassesCommand(t *testing.T) {
	f := newHeadlessFixture(t)
	code, out := postRun(t, f.s, "/api/tools/headless", `{"cwd":`+qRepo+`,"command":"echo hi"}`)
	if code != http.StatusOK {
		t.Fatalf("headless want 200, got %d (%+v)", code, out)
	}
	if out["command"] != "echo hi" {
		t.Fatalf("응답이 명령을 되돌려주지 않았다: %+v", out)
	}
	if got := f.hub.lastPlacement().Command; got != "echo hi" {
		t.Fatalf("도구 생성에 명령이 실리지 않았다: %q", got)
	}
}

// 명령을 주지 않으면 종전대로다 (FR-BGP-5) — Run 의 멤버 기동이 그 길을 쓴다.
func TestToolsHeadless_NoCommandIsShell(t *testing.T) {
	f := newHeadlessFixture(t)
	code, _ := postRun(t, f.s, "/api/tools/headless", `{"cwd":`+qRepo+`}`)
	if code != http.StatusOK {
		t.Fatalf("headless want 200, got %d", code)
	}
	if got := f.hub.lastPlacement().Command; got != "" {
		t.Fatalf("명령을 주지 않았는데 실렸다: %q", got)
	}
}

// ── 묶음 N — 승계 ────────────────────────────────────

// V-RUN-2 (FR-RUN-4·5): **늦게 온 인수인계도 후임에게 닿는다.**
//
// 승계가 요약 없이 끝나면 전임자에게 "청했으나 아직" 표식이 남고, 후임의
// 프리앰블을 만드는 종단이 그것을 기다린다. 종전에는 시한을 넘긴 요약이 전임자
// 레코드에만 남아 버려졌다 (접수 ⑫).
func TestPreamble_WaitsForLateHandoff(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	// 전임자는 탭에 붙어 있고 살아 있다 — 청할 상대가 있다는 뜻이다.
	code, prev := postRun(t, f.s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":"tab-a"}`)
	if code != http.StatusOK {
		t.Fatalf("멤버 등록 want 200, got %d (%+v)", code, prev)
	}
	prevID, _ := prev["id"].(string)

	// 시한을 0 에 가깝게 주어 "요약 없는 승계" 를 만든다.
	code, out := postRun(t, f.s, "/api/runs/succeed",
		`{"memberId":`+testpath.JSONQuote(prevID)+`,"headless":true,"timeoutMs":1}`)
	if code != http.StatusOK {
		t.Fatalf("succeed want 200, got %d (%+v)", code, out)
	}
	if out["hasSummary"] != false {
		t.Fatalf("전제가 깨졌다 — 시한 안에 요약이 왔다: %+v", out)
	}
	next, _ := out["member"].(map[string]any)
	nextID, _ := next["memberId"].(string)
	if nextID == "" {
		if m, ok := next["id"].(string); ok {
			nextID = m
		}
	}
	if nextID == "" {
		t.Fatalf("후임 uuid 를 읽지 못했다: %+v", next)
	}

	// 전임자가 뒤늦게 요약을 남긴다 — 프리앰블이 기다리는 동안이다.
	go func() {
		time.Sleep(200 * time.Millisecond)
		postRun(t, f.s, "/api/runs/handoff",
			`{"toolId":"tool-a","summary":"1장까지 했다. 2장은 개요만 있다."}`)
	}()

	_, got := getRun(t, f.s, "/api/runs/preamble?member="+nextID)
	pre, _ := got["preamble"].(string)
	if !strings.Contains(pre, "1장까지 했다") {
		t.Fatalf("늦게 온 인수인계가 프리앰블에 실리지 않았다:\n%s", pre)
	}
}

// FR-RUN-5: 오지 않으면 기다림을 접고 요약 없이 낸다 — 없는 것은 없다고 말한다.
func TestPreamble_NoWaitWhenNothingWasAsked(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t)
	m := f.addHeadless(t, runID, "작가")
	id, _ := m["id"].(string)
	done := make(chan struct{})
	go func() {
		getRun(t, f.s, "/api/runs/preamble?member="+id)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("청한 적도 없는 인수인계를 기다렸다")
	}
}

// ── 묶음 N — 정리 ────────────────────────────────────

// V-RUN-3 (FR-RUN-6·7·9): close 가 멤버 탭과 전용 창의 빈 탭을 닫는다.
func TestRunClose_ClosesMemberAndEmptyTabs(t *testing.T) {
	f := newHeadlessFixture(t)
	// 전용 창의 Run 이어야 빈 탭까지 거둔다 (FR-RUN-7 의 소유권 근거).
	code, out := postRun(t, f.s, "/api/runs",
		`{"objective":"정리","projection":"dedicated-window","isolation":"none","windowId":"win-1"}`)
	if code != http.StatusOK {
		t.Fatalf("run start want 200, got %d (%+v)", code, out)
	}
	runID, _ := out["id"].(string)
	// 멤버 탭 하나 + 아무도 앉지 않은 빈 탭 하나가 같은 창에 있다.
	f.wi.setWindow("tab-a", "win-1")
	f.hub.seed("tool-idle")
	f.io.setHas("tool-idle", true)
	f.wi.bind("tool-idle", "tab-idle")
	f.wi.setWindow("tab-idle", "win-1")

	code, m := postRun(t, f.s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":"tab-a"}`)
	if code != http.StatusOK {
		t.Fatalf("멤버 등록 want 200, got %d (%+v)", code, m)
	}
	postRun(t, f.s, "/api/runs/report", `{"toolId":"tool-a","outcome":"succeeded","summary":"끝"}`)

	f.resetActions()
	code, closed := postRun(t, f.s, "/api/runs/close", `{"runId":`+testpath.JSONQuote(runID)+`}`)
	if code != http.StatusOK {
		t.Fatalf("close want 200, got %d (%+v)", code, closed)
	}
	tabs, _ := closed["closedTabs"].([]any)
	if len(tabs) != 2 {
		t.Fatalf("닫은 탭 = %d개, want 2 (멤버 탭 + 빈 탭): %+v", len(tabs), closed["closedTabs"])
	}
	var member, empty bool
	for _, raw := range tabs {
		c, _ := raw.(map[string]any)
		if c["tabId"] == "tab-a" {
			member = true
		}
		if c["tabId"] == "tab-idle" && c["empty"] == true {
			empty = true
		}
	}
	if !member || !empty {
		t.Fatalf("멤버 탭·빈 탭이 모두 닫히지 않았다: %+v", closed["closedTabs"])
	}
	f.waitAction(t, "closeTab")
}

// FR-RUN-8: `--keep-tools` 는 아무것도 닫지 않는다 — 종전 규약이 그대로 남는다.
func TestRunClose_KeepToolsClosesNothing(t *testing.T) {
	f := newHeadlessFixture(t)
	code, out := postRun(t, f.s, "/api/runs",
		`{"objective":"보존","projection":"dedicated-window","isolation":"none","windowId":"win-1"}`)
	if code != http.StatusOK {
		t.Fatalf("run start want 200, got %d", code)
	}
	runID, _ := out["id"].(string)
	f.wi.setWindow("tab-a", "win-1")
	postRun(t, f.s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":"tab-a"}`)
	postRun(t, f.s, "/api/runs/report", `{"toolId":"tool-a","outcome":"succeeded","summary":"끝"}`)

	code, closed := postRun(t, f.s, "/api/runs/close",
		`{"runId":`+testpath.JSONQuote(runID)+`,"keepTools":true}`)
	if code != http.StatusOK {
		t.Fatalf("close want 200, got %d", code)
	}
	if tabs, _ := closed["closedTabs"].([]any); len(tabs) != 0 {
		t.Fatalf("--keep-tools 인데 탭을 닫았다: %+v", tabs)
	}
}

// 인라인 Run(사용자의 창을 나눠 쓰는 것)의 비-멤버 탭은 **사용자의 것**이다.
// 남의 자리를 서버가 닫지 않는다 (FR-RUN-7 의 소유권 근거).
func TestRunClose_LeavesForeignTabsInInlineRun(t *testing.T) {
	f := newHeadlessFixture(t)
	runID := f.startRun(t) // projection=inline, windowId 없음
	postRun(t, f.s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":"tab-a"}`)
	postRun(t, f.s, "/api/runs/report", `{"toolId":"tool-a","outcome":"succeeded","summary":"끝"}`)
	f.hub.seed("tool-mine")
	f.wi.bind("tool-mine", "tab-mine")

	_, closed := postRun(t, f.s, "/api/runs/close", `{"runId":`+testpath.JSONQuote(runID)+`}`)
	for _, raw := range asList(closed["closedTabs"]) {
		c, _ := raw.(map[string]any)
		if c["tabId"] == "tab-mine" {
			t.Fatalf("사용자의 탭을 닫았다: %+v", closed["closedTabs"])
		}
	}
}

func asList(v any) []any {
	out, _ := v.([]any)
	return out
}
