package runtimebin

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/runwait"
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

// V-CTX-5 (UX_BATCH6_SRS FR-CTX-8): 멤버 행이 **분자와 분모**를 함께 낸다.
//
// 비율만 보이면 "1M 을 쓰는데 왜 70% 인가" 를 CLI 에서 물을 수 없다 — 접수 ⑨의
// 절반이 그 물음이었다.
func TestContextCell_ShowsTokensAndLimit(t *testing.T) {
	m := runMember{
		ContextLevel: "ok", ContextRatio: 0.2,
		ContextTokens: 202185, ContextLimit: 1000000,
	}
	got := m.contextCell()
	for _, want := range []string{"ctx=~20%", "202k", "1.0M"} {
		if !strings.Contains(got, want) {
			t.Errorf("%q 가 없다: %s", want, got)
		}
	}
}

// 실측 토큰이 없으면 종전대로 비율만이다 — 그때의 비율은 파일 크기 추정이며
// 없는 분모를 지어내지 않는다 (FR-CTX-4).
func TestContextCell_OmitsUnknownTokens(t *testing.T) {
	m := runMember{ContextLevel: "warn", ContextRatio: 0.75}
	if got := m.contextCell(); strings.Contains(got, "[") {
		t.Errorf("모르는 값을 지어냈다: %s", got)
	}
}

// 관측이 없으면 0% 가 아니라 — 다 (FR-CBG-5 의 규약은 그대로다).
func TestContextCell_UnknownStaysUnknown(t *testing.T) {
	if got := (runMember{}).contextCell(); got != "ctx=— (unknown)" {
		t.Errorf("모름의 표기가 바뀌었다: %s", got)
	}
}

// M8_UNIFIED_SRS D-A-1 (FBE-01 클라이언트 절반): 오래 붙잡히는 종단은 서버 상한 + 여유의
// 예산으로 부른다. 종전에는 전 서브커맨드가 10초 공용 클라이언트였고, 승계는 정상
// 경로(요약에 수십 초)에서 늘 "실패" 로 보고된 뒤 서버 쪽에서 성공해 있었다.
func TestRunBudget_SucceedFollowsTimeout(t *testing.T) {
	if got, want := succeedBudget(0), runwait.HandoffWaitDefault+runClientSlack; got != want {
		t.Fatalf("기본 예산 = %s, want %s (서버 기본 + 여유)", got, want)
	}
	if got, want := succeedBudget(60_000), 60*time.Second+runClientSlack; got != want {
		t.Fatalf("--timeout-ms 60000 → %s, want %s", got, want)
	}
	if preambleBudget <= runwait.PreambleWait {
		t.Fatalf("preamble 예산 %s 은 서버 상한 %s 보다 커야 한다", preambleBudget, runwait.PreambleWait)
	}
	if closeBudget <= runwait.ExitSettle {
		t.Fatalf("close 예산 %s 은 서버 상한 %s 보다 커야 한다", closeBudget, runwait.ExitSettle)
	}
}

// 예산은 실제로 전송에 쓰인다 — 짧으면 끊기고 길면 잇는다. 60초를 자는 대신 같은
// 사실을 밀리초로 잰다.
func TestRunPostWithin_UsesBudget(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer ts.Close()
	pointDmctlAtServer(t, ts, "tool-a")

	var errb bytes.Buffer
	if _, code := runPostWithin("/api/runs/succeed", map[string]any{}, 50*time.Millisecond, &errb); code == 0 {
		t.Fatal("50ms 예산인데 300ms 응답을 기다렸다")
	}
	errb.Reset()
	if _, code := runPostWithin("/api/runs/succeed", map[string]any{}, 5*time.Second, &errb); code != 0 {
		t.Fatalf("5초 예산인데 끊겼다: %s", errb.String())
	}
}

// succeed 가 그 예산으로 부르는지는 기록된 예산으로 본다.
func TestDmctlRunSucceed_UsesLongBudget(t *testing.T) {
	blob := `{"member":{"id":"m-2","role":"writer","toolId":"tool-c","tabId":"tab-c"},"prevMemberId":"m-1","prevState":"succeeded","hasSummary":true}`
	ts, _ := runStub(t, map[string]string{"/api/runs/succeed": blob})
	pointDmctlAtServer(t, ts, "tool-a")
	var seen []time.Duration
	restore := recordBudgets(&seen)
	defer restore()

	var out bytes.Buffer
	if code := runDmctlRun([]string{"succeed", "--member", "m-1", "--at", "tab-c", "--timeout-ms", "60000"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if len(seen) != 1 || seen[0] != 60*time.Second+runClientSlack {
		t.Fatalf("succeed 의 예산 = %v, want %s", seen, 60*time.Second+runClientSlack)
	}
}

// launch 와 --member 해석은 preamble 종단을 부르고, 그 종단은 늦은 요약을 90초까지
// 기다린다 — 10초 클라이언트로는 정상 경로가 끊긴다.
func TestDmctlRunLaunch_UsesPreambleBudget(t *testing.T) {
	preambleStub(t, "claude")
	var seen []time.Duration
	restore := recordBudgets(&seen)
	defer restore()

	if code := runDmctlRun([]string{"launch", "--member", "m-1"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if len(seen) != 1 || seen[0] != preambleBudget {
		t.Fatalf("launch 의 예산 = %v, want %s", seen, preambleBudget)
	}
}

func TestDmctlRunClose_UsesCloseBudget(t *testing.T) {
	ts, _ := runStub(t, map[string]string{"/api/runs/close": `{"id":"r","state":"closed"}`})
	pointDmctlAtServer(t, ts, "tool-a")
	var seen []time.Duration
	restore := recordBudgets(&seen)
	defer restore()

	if code := runDmctlRun([]string{"close", "--run", "r"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if len(seen) != 1 || seen[0] != closeBudget {
		t.Fatalf("close 의 예산 = %v, want %s", seen, closeBudget)
	}
}

// recordBudgets 는 예산 클라이언트가 만들어질 때의 예산을 적는다.
func recordBudgets(seen *[]time.Duration) (restore func()) {
	prev := clientWithin
	clientWithin = func(d time.Duration) *http.Client {
		*seen = append(*seen, d)
		return prev(d)
	}
	return func() { clientWithin = prev }
}

// M8 D-A-24: `wait` 의 기본 예산은 서버 기본(`runwait.ActivityWaitDefault`) + 여유다 —
// 사본이 아니다. 시한을 주면 그 시한 + 여유다.
func TestRunBudget_WaitFollowsRunwait(t *testing.T) {
	if got := waitBudget(0); got != runwait.ActivityWaitDefault+waitClientSlack {
		t.Fatalf("기본 예산 %v, want %v", got, runwait.ActivityWaitDefault+waitClientSlack)
	}
	if got := waitBudget(60_000); got != 60*time.Second+waitClientSlack {
		t.Fatalf("60초 시한의 예산 %v", got)
	}
}
