package runtimebin

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// 묶음 C 의 CLI 절반 (ORCHESTRATION_V2_SRS §3.3, V-CBG-*).

// V-CBG-6/7 (FR-CBG-9): succeed 는 승계 사슬·물려받은 트리·인수인계 유무를 낸다.
func TestDmctlRunSucceed_ReportsTheChainAndTheHandoff(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/succeed": `{"member":{"id":"m-2","role":"작가","toolId":"tool-c","tabId":"tab-c",` +
			`"worktree":{"path":"/tmp/wt/작가","branch":"run/x/작가"},"preamble":"..."},` +
			`"prevMemberId":"m-1","prevState":"succeeded","hasSummary":true}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	code := runDmctlRun([]string{"succeed", "--member", "m-1", "--at", "tab-c", "--timeout-ms", "1000"}, &out, io.Discard)
	if code != 0 {
		t.Fatalf("succeed exit = %d (%s)", code, out.String())
	}
	body := (*calls)[0].Body
	if body["memberId"] != "m-1" || body["at"] != "tab-c" || body["timeoutMs"].(float64) != 1000 {
		t.Fatalf("요청이 어긋난다: %+v", body)
	}
	got := out.String()
	for _, want := range []string{
		"prev=m-1", "succeeded", "member=m-2", "/tmp/wt/작가",
		"인수인계 요약 있음",
		"새로 만들지 않았다",           // FR-CBG-11 을 조정자가 화면에서 안다
		"이전 멤버의 도구는 그대로 살아 있다", // FR-CBG-12
		"dmctl run launch --member m-2",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("succeed 출력에 %q 가 없다:\n%s", want, got)
		}
	}
}

// V-CBG-7: 요약 없는 승계는 **없다고 말한다.** 침묵하면 조정자가 있지도 않은
// 맥락을 전제한 지시를 후임에게 준다.
func TestDmctlRunSucceed_SaysWhenThereIsNoSummary(t *testing.T) {
	ts, _ := runStub(t, map[string]string{
		"/api/runs/succeed": `{"member":{"id":"m-2","role":"작가","toolId":"tool-c"},` +
			`"prevMemberId":"m-1","prevState":"succeeded","hasSummary":false}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"succeed", "--member", "m-1", "--at", "tab-c"}, &out, io.Discard); code != 0 {
		t.Fatalf("succeed exit = %d", code)
	}
	if !strings.Contains(out.String(), "인수인계 요약 없음") {
		t.Fatalf("요약이 없다는 사실을 말하지 않았다:\n%s", out.String())
	}
}

// 자리 지정은 배타적이며 필수다. 조용히 한쪽으로 낮추지 않는다.
func TestDmctlRunSucceed_SeatMustBeExactlyOne(t *testing.T) {
	ts, _ := runStub(t, nil)
	pointDmctlAtServer(t, ts, "tool-a")

	for _, tc := range []struct {
		name string
		args []string
	}{
		{"멤버 없음", []string{"succeed", "--at", "tab-c"}},
		{"자리 없음", []string{"succeed", "--member", "m-1"}},
		{"둘 다", []string{"succeed", "--member", "m-1", "--at", "tab-c", "--headless"}},
		{"잘못된 시한", []string{"succeed", "--member", "m-1", "--at", "tab-c", "--timeout-ms", "곧"}},
	} {
		var errb bytes.Buffer
		if code := runDmctlRun(tc.args, io.Discard, &errb); code != 2 {
			t.Fatalf("%s: exit = %d, 사용법 오류여야 한다", tc.name, code)
		}
		if errb.Len() == 0 {
			t.Fatalf("%s: 무엇이 틀렸는지 말하지 않았다", tc.name)
		}
	}
}

// FR-CBG-9 의 1단계 응답: handoff 는 stdin 으로 여러 줄 요약을 받는다.
// --member 는 대조용이라 생략이 정상이다 — 권한은 발신 도구의 정체다.
func TestDmctlRunHandoff_ReadsSummaryFromStdin(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/handoff": `{"memberId":"m-1","len":42}`,
	})
	pointDmctlAtServer(t, ts, "tool-b")

	var out bytes.Buffer
	summary := "1장 초고까지 했다.\n2장은 개요만 있다.\n"
	code := runDmctlRunStdin(strings.NewReader(summary), []string{"handoff", "--summary", "-"}, &out, io.Discard)
	if code != 0 {
		t.Fatalf("handoff exit = %d (%s)", code, out.String())
	}
	body := (*calls)[0].Body
	if body["summary"] != strings.TrimRight(summary, "\n") {
		t.Fatalf("stdin 요약이 그대로 가지 않았다: %q", body["summary"])
	}
	if body["toolId"] != "tool-b" {
		t.Fatalf("발신자 정체가 실리지 않았다: %+v", body)
	}
	if _, ok := body["memberId"]; ok {
		t.Fatalf("지정하지 않은 memberId 를 지어냈다: %+v", body)
	}
	if !strings.Contains(out.String(), "member=m-1") {
		t.Fatalf("결과가 보이지 않는다: %s", out.String())
	}
}

// 빈 요약은 서버에 가기 전에 막는다. 후임이 먼저 읽는 것이다.
func TestDmctlRunHandoff_RefusesEmptySummary(t *testing.T) {
	ts, calls := runStub(t, nil)
	pointDmctlAtServer(t, ts, "tool-b")

	var errb bytes.Buffer
	if code := runDmctlRunStdin(strings.NewReader("   \n"), []string{"handoff", "--summary", "-"}, io.Discard, &errb); code != 2 {
		t.Fatalf("빈 요약이 통과했다")
	}
	if len(*calls) != 0 {
		t.Fatalf("빈 요약이 서버까지 갔다: %+v", *calls)
	}
	if errb.Len() == 0 {
		t.Fatal("무엇을 써야 하는지 말하지 않았다")
	}
}

// FR-CBG-13 / NFR-CBG-3: 멤버 행의 컨텍스트는 **추정임이 드러나야** 한다.
// 모르는 것은 0% 가 아니라 — 다 (FR-CBG-5).
func TestRunStatus_ContextCellShowsEstimateOrNothing(t *testing.T) {
	for _, tc := range []struct {
		name string
		m    runMember
		want string
	}{
		{"모름", runMember{}, "ctx=— (unknown)"},
		{"여유", runMember{ContextLevel: "ok", ContextRatio: 0.31}, "ctx=~31% (ok)"},
		{"경고", runMember{ContextLevel: "warn", ContextRatio: 0.72}, "ctx=~72% (warn)"},
		{"압축", runMember{ContextLevel: "critical", ContextRatio: 0.21, CompactCount: 2}, "ctx=~21% (critical) compact=2"},
	} {
		if got := tc.m.contextCell(); got != tc.want {
			t.Fatalf("%s: %q, 기대 %q", tc.name, got, tc.want)
		}
	}
}

// FR-CBG-14: warn 이상인 멤버가 있으면 머리줄에 요약이 난다. 조정자가 멤버
// 목록을 끝까지 읽지 않아도 보여야 한다. 아무도 위태롭지 않으면 조용하다.
func TestRunStatus_HeadlineOnlyWhenSomeoneIsAtRisk(t *testing.T) {
	quiet := []runMember{{Role: "작가", ContextLevel: "ok"}, {Role: "비평가"}}
	if got := contextHeadline(quiet); got != "" {
		t.Fatalf("조용해야 할 때 경고가 났다: %q", got)
	}

	risky := []runMember{
		{Role: "작가", ContextLevel: "warn"},
		{Role: "비평가", ContextLevel: "critical"},
		{Role: "편집자", ContextLevel: "ok"},
	}
	got := contextHeadline(risky)
	for _, want := range []string{"추정", "critical 1명(비평가)", "warn 1명(작가)", "dmctl run succeed"} {
		if !strings.Contains(got, want) {
			t.Fatalf("머리줄에 %q 가 없다: %q", want, got)
		}
	}
	if strings.Contains(got, "편집자") {
		t.Fatalf("위태롭지 않은 멤버가 경고에 실렸다: %q", got)
	}
}

// 머리줄과 멤버 행이 실제 status 출력에 함께 나오는지 — 조각이 아니라 결과를 본다.
func TestDmctlRunStatus_PrintsContextEndToEnd(t *testing.T) {
	ts, _ := runStub(t, map[string]string{
		"/api/runs": `{"id":"run-1","short":"run-1","objective":"팬아웃","state":"open","members":[` +
			`{"id":"m-1","role":"작가","state":"working","contextLevel":"warn","contextRatio":0.72},` +
			`{"id":"m-2","role":"비평가","state":"working","succeededFrom":"m-0"}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"status", "--run", "run-1"}, &out, io.Discard); code != 0 {
		t.Fatalf("status exit = %d", code)
	}
	got := out.String()
	for _, want := range []string{"컨텍스트 주의(추정)", "warn 1명(작가)", "ctx=~72% (warn)", "ctx=— (unknown)", "승계←m-0"} {
		if !strings.Contains(got, want) {
			t.Fatalf("status 출력에 %q 가 없다:\n%s", want, got)
		}
	}
}
