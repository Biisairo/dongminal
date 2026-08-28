package runtimebin

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// 묶음 H — 헤드리스 멤버의 CLI 절반 (ORCHESTRATION_V2_SRS §3.2).
//
// 여기서 고정하는 것은 **사용자가 실제로 칠 수 있는가**다. 서버가 완성돼 있어도
// CLI 가 그 값을 싣지 않거나 응답을 렌더하지 않으면 기능은 없는 것과 같다 —
// 서버 테스트로는 잡히지 않는 종류의 결함이다.

// ── FR-HLM-1: --at 과 --headless 는 배타이며 정확히 하나 (V-HLM-8) ──

func TestDmctlRun_MemberRequiresExactlyOneTarget(t *testing.T) {
	base := []string{"member", "--run", "r-1", "--role", "작가", "--agent", "claude"}

	for _, tc := range []struct {
		name string
		args []string
	}{
		{"둘 다 없음", base},
		{"둘 다 있음", append(append([]string{}, base...), "--at", "tab-1", "--headless")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts, calls := runStub(t, nil)
			pointDmctlAtServer(t, ts, "tool-a")

			var errBuf bytes.Buffer
			if code := runDmctlRun(tc.args, io.Discard, &errBuf); code != 2 {
				t.Fatalf("exit = %d, want 2", code)
			}
			// 서버에 가지 않는다 — 왕복 전에 걸러 준다.
			if len(*calls) != 0 {
				t.Fatalf("거부 전에 서버를 불렀다: %+v", *calls)
			}
			// 안내가 무엇을 줘야 하는지 말한다 (FR-HLM-1).
			msg := errBuf.String()
			if !strings.Contains(msg, "--at") || !strings.Contains(msg, "--headless") {
				t.Fatalf("거부가 무엇을 줘야 하는지 안내하지 않는다: %q", msg)
			}
		})
	}
}

// ── FR-HLM-2: --headless 는 headless·cwd 를 싣는다 ──

func TestDmctlRun_MemberHeadlessSendsFlagAndCwd(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/members": `{"id":"m-1","role":"수집","agent":"claude",
		  "toolId":"tool-h","tabId":"","state":"starting","headless":true}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	code := runDmctlRun([]string{
		"member", "--run", "r-1", "--role", "수집", "--agent", "claude", "--headless",
	}, &out, io.Discard)
	if code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if len(*calls) != 1 {
		t.Fatalf("요청 수 = %d, want 1", len(*calls))
	}
	body := (*calls)[0].Body
	if body["headless"] != true {
		t.Fatalf("headless 를 싣지 않았다: %+v", body)
	}
	// cwd 는 서버가 확정하지만, 비격리 Run 에서 그 값은 조정자의 cwd 다 —
	// 서버는 조정자가 어디서 일하는지 알 방법이 없으므로 CLI 가 실어야 한다.
	if cwd, _ := body["cwd"].(string); cwd == "" {
		t.Fatalf("조정자 cwd 를 싣지 않았다: %+v", body)
	}
	// 출력이 헤드리스임을 말한다 — tabId 가 빈 것만으로는 "없다" 와 "아직
	// 모른다" 가 구분되지 않는다.
	if !strings.Contains(out.String(), "headless=true") {
		t.Fatalf("출력이 헤드리스를 말하지 않는다: %q", out.String())
	}
}

// --at 경로는 헤드리스 필드를 싣지 않는다 — 기존 동작이 그대로여야 한다.
func TestDmctlRun_MemberWithTabDoesNotSendHeadless(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/members": `{"id":"m-1","role":"작가","toolId":"tool-b","tabId":"tab-b","state":"starting"}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{
		"member", "--run", "r-1", "--role", "작가", "--agent", "claude", "--at", "tab-b",
	}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	body := (*calls)[0].Body
	if _, present := body["headless"]; present {
		t.Fatalf("--at 경로가 headless 를 실었다: %+v", body)
	}
	if _, present := body["cwd"]; present {
		t.Fatalf("--at 경로가 cwd 를 실었다: %+v", body)
	}
	if strings.Contains(out.String(), "headless") {
		t.Fatalf("--at 멤버 출력에 headless 가 있다: %q", out.String())
	}
}

// ── FR-HLM-4: --keep-tools ──

func TestDmctlRun_CloseKeepToolsIsAcceptedAndSent(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/close": `{"id":"r-1","state":"closed","cleanup":[],"worktrees":[],
		  "keptTools":[{"memberId":"m-1","role":"수집","toolId":"tool-h"}],
		  "orphans":[{"memberId":"m-1","role":"수집","toolId":"tool-h"}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"close", "--run", "r-1", "--force", "--keep-tools"},
		&out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if (*calls)[0].Body["keepTools"] != true {
		t.Fatalf("keepTools 를 싣지 않았다: %+v", (*calls)[0].Body)
	}
	// 보존도 보고된다 — 조용히 남는 자원이 없어야 한다.
	text := out.String()
	if !strings.Contains(text, "보존") || !strings.Contains(text, "tool-h") {
		t.Fatalf("보존을 보고하지 않았다: %q", text)
	}
	// 그리고 그 결과가 고아라는 것도 함께 말한다 (FR-HLM-5).
	if !strings.Contains(text, "고아") {
		t.Fatalf("고아를 보고하지 않았다: %q", text)
	}
}

// close 의 "정리 대상" 은 탭이 있는 멤버만이다 — 헤드리스는 close 가 이미
// 처리했으므로 섞이면 조정자가 없는 탭을 닫으러 간다.
func TestDmctlRun_CloseCleanupSkipsTablessMembers(t *testing.T) {
	ts, _ := runStub(t, map[string]string{
		"/api/runs/close": `{"id":"r-1","state":"closed","worktrees":[],"cleanup":[
		  {"role":"작가","toolId":"tool-b","tabId":"tab-b","live":true},
		  {"role":"수집","toolId":"tool-h","tabId":"","live":false}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"close", "--run", "r-1", "--force"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	text := out.String()
	if !strings.Contains(text, "tool-b") {
		t.Fatalf("탭 부착 멤버가 정리 대상에 없다: %q", text)
	}
	if strings.Contains(text, "tool-h") {
		t.Fatalf("탭 없는 멤버가 close-tab 대상으로 나왔다: %q", text)
	}
}

// ── FR-HLM-5: run status 가 고아를 렌더한다 (V-HLM-7) ──

func TestDmctlRun_StatusRendersOrphans(t *testing.T) {
	ts, _ := runStub(t, map[string]string{
		"/api/runs": `{"id":"r-1","short":"r1","state":"closed","projection":"inline",
		  "isolation":"none","members":[
		    {"role":"수집","state":"lost","agent":"claude","toolId":"tool-h","tabId":"","headless":true}],
		  "orphans":[{"memberId":"m-1","role":"수집","toolId":"tool-h"}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"status", "--run", "r-1"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	text := out.String()
	// 고아 목록이 실제로 찍힌다 — 서버가 실어 보내도 렌더하지 않으면 없는 것이다.
	if !strings.Contains(text, "고아") || !strings.Contains(text, "tool-h") ||
		!strings.Contains(text, "m-1") {
		t.Fatalf("고아 목록이 렌더되지 않았다: %q", text)
	}
	// 거두는 길을 함께 말한다 — 알려 주고 끝내지 않는다.
	if !strings.Contains(text, "--force") {
		t.Fatalf("거두는 방법을 안내하지 않는다: %q", text)
	}
	// 멤버 줄이 헤드리스임을 말한다.
	if !strings.Contains(text, "headless=true") {
		t.Fatalf("헤드리스 멤버가 그렇게 표시되지 않았다: %q", text)
	}
}

// 고아가 없으면 아무것도 찍지 않는다 — 조용할 때 조용한 것이 목록을 목록답게 만든다.
func TestDmctlRun_StatusStaysQuietWithoutOrphans(t *testing.T) {
	ts, _ := runStub(t, map[string]string{
		"/api/runs": `{"id":"r-1","short":"r1","state":"open","projection":"inline",
		  "isolation":"none","members":[
		    {"role":"작가","state":"working","agent":"claude","toolId":"tool-b","tabId":"tab-b"}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"status", "--run", "r-1"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if strings.Contains(out.String(), "고아") {
		t.Fatalf("고아가 없는데 목록을 찍었다: %q", out.String())
	}
}

// ── FR-HLM-6/7: attach / detach ──

func TestDmctlRun_AttachSendsMemberAndOptionalLocation(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/attach": `{"id":"m-1","role":"수집","toolId":"tool-h","tabId":"tab-new","state":"ready"}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"attach", "--member", "m-1", "--at", "tab-x"},
		&out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	body := (*calls)[0].Body
	if body["memberId"] != "m-1" || body["location"] != "tab-x" {
		t.Fatalf("부착 본문이 어긋난다: %+v", body)
	}
	// 부착 직후 조정자가 쓸 값이 한 줄에 있어야 한다.
	if !strings.Contains(out.String(), "tabId=tab-new") {
		t.Fatalf("부착이 탭을 알려 주지 않는다: %q", out.String())
	}
}

// --at 이 없으면 location 을 싣지 않는다 — 브라우저의 현재 포커스가 대상이다.
func TestDmctlRun_AttachWithoutAtOmitsLocation(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/attach": `{"id":"m-1","toolId":"tool-h","tabId":"tab-new","state":"ready"}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	if code := runDmctlRun([]string{"attach", "--member", "m-1"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if _, present := (*calls)[0].Body["location"]; present {
		t.Fatalf("--at 없이 location 을 실었다: %+v", (*calls)[0].Body)
	}
}

func TestDmctlRun_DetachRejectsAt(t *testing.T) {
	ts, calls := runStub(t, nil)
	pointDmctlAtServer(t, ts, "tool-a")

	var errBuf bytes.Buffer
	if code := runDmctlRun([]string{"detach", "--member", "m-1", "--at", "tab-x"},
		io.Discard, &errBuf); code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if len(*calls) != 0 {
		t.Fatalf("거부 전에 서버를 불렀다: %+v", *calls)
	}
	if !strings.Contains(errBuf.String(), "--at") {
		t.Fatalf("무엇이 문제인지 말하지 않는다: %q", errBuf.String())
	}
}

func TestDmctlRun_AttachDetachRequireMember(t *testing.T) {
	for _, sub := range []string{"attach", "detach"} {
		ts, _ := runStub(t, nil)
		pointDmctlAtServer(t, ts, "tool-a")
		var errBuf bytes.Buffer
		if code := runDmctlRun([]string{sub}, io.Discard, &errBuf); code != 2 {
			t.Fatalf("%s: exit = %d, want 2", sub, code)
		}
		if !strings.Contains(errBuf.String(), "--member") {
			t.Fatalf("%s: --member 를 요구하지 않는다: %q", sub, errBuf.String())
		}
	}
}

// ── FR-HLM-11: wait --member (V-HLM-2) ──

func TestDmctlWait_MemberResolvesToToolID(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/preamble":       `{"runId":"r-1","memberId":"m-1","role":"수집","toolId":"tool-h"}`,
		"/api/tools/activity/wait": `{"toolId":"tool-h","status":"ready","state":"idle","waitedMs":12}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlWait([]string{"--member", "m-1", "--for", "ready"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if len(*calls) != 2 {
		t.Fatalf("요청 수 = %d, want 2 (해석 + 대기): %+v", len(*calls), *calls)
	}
	// 1) 멤버 uuid 로 해석한다.
	if (*calls)[0].Path != "/api/runs/preamble" || !strings.Contains((*calls)[0].Query, "member=m-1") {
		t.Fatalf("멤버 해석 요청이 어긋난다: %+v", (*calls)[0])
	}
	// 2) 접합면에는 **toolId 만** 간다. 멤버 uuid 가 id 에 섞이면 안 된다.
	wait := (*calls)[1]
	if wait.Path != "/api/tools/activity/wait" {
		t.Fatalf("대기 경로가 어긋난다: %+v", wait)
	}
	if !strings.Contains(wait.Query, "id=tool-h") {
		t.Fatalf("toolId 로 대기하지 않는다: %q", wait.Query)
	}
	if strings.Contains(wait.Query, "m-1") || strings.Contains(wait.Query, "member") {
		t.Fatalf("멤버 uuid 가 접합면에 샜다: %q", wait.Query)
	}
}

func TestDmctlWait_MemberAndAtAreExclusive(t *testing.T) {
	ts, calls := runStub(t, nil)
	pointDmctlAtServer(t, ts, "tool-a")

	var errBuf bytes.Buffer
	if code := runDmctlWait([]string{"--member", "m-1", "--at", "tab-x", "--for", "ready"},
		io.Discard, &errBuf); code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if len(*calls) != 0 {
		t.Fatalf("거부 전에 서버를 불렀다: %+v", *calls)
	}
	if !strings.Contains(errBuf.String(), "--member") {
		t.Fatalf("배타임을 말하지 않는다: %q", errBuf.String())
	}
}

// 도구 없는 멤버는 기다릴 대상이 없다 — 조용히 현재 셸로 떨어지면 엉뚱한 도구의
// 상태를 그 멤버의 것으로 읽는다.
func TestDmctlWait_MemberWithoutToolFails(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/preamble": `{"runId":"r-1","memberId":"m-1","role":"수집","toolId":""}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var errBuf bytes.Buffer
	if code := runDmctlWait([]string{"--member", "m-1", "--for", "ready"},
		io.Discard, &errBuf); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	// 대기까지 가지 않는다.
	for _, c := range *calls {
		if c.Path == "/api/tools/activity/wait" {
			t.Fatalf("도구 없는 멤버로 대기를 걸었다: %+v", c)
		}
	}
	if !strings.Contains(errBuf.String(), "m-1") {
		t.Fatalf("어느 멤버인지 말하지 않는다: %q", errBuf.String())
	}
}

// status 는 --member 를 받지 않는다 — SRS §4.1 이 wait 에만 연다. 조용히 무시하지
// 않고 사용법 오류로 가른다.
func TestDmctlStatus_DoesNotAcceptMember(t *testing.T) {
	ts, _ := runStub(t, nil)
	pointDmctlAtServer(t, ts, "tool-a")

	var errBuf bytes.Buffer
	if code := runDmctlStatus([]string{"--member", "m-1"}, io.Discard, &errBuf); code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if !strings.Contains(errBuf.String(), "unknown argument") {
		t.Fatalf("알 수 없는 인자로 가르지 않았다: %q", errBuf.String())
	}
}

// ── 도움말이 실제 표면을 말한다 ──
//
// 도움말과 구현이 어긋나면 조정자가 없는 명령을 친다. 다섯 서브커맨드가 오래
// 빠져 있었으므로 목록을 고정한다.
func TestDmctlRunHelp_ListsEverySubcommand(t *testing.T) {
	var out bytes.Buffer
	if code := runDmctlRun([]string{"--help"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	text := out.String()
	for _, sub := range []string{
		"run start", "run member", "run launch", "run report", "run status",
		"run close", "run list", "run attach", "run detach", "run peers",
		"run succeed", "run handoff",
	} {
		if !strings.Contains(text, sub) {
			t.Fatalf("도움말에 %q 가 없다", sub)
		}
	}
	for _, flag := range []string{"--headless", "--keep-tools"} {
		if !strings.Contains(text, flag) {
			t.Fatalf("도움말에 %q 가 없다", flag)
		}
	}
}

func TestDmctlWaitHelp_DocumentsMember(t *testing.T) {
	var out bytes.Buffer
	if code := runDmctlWait([]string{"--help"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(out.String(), "--member") {
		t.Fatalf("wait 도움말이 --member 를 말하지 않는다: %q", out.String())
	}
}

// 디스패치가 살아 있는지 — 스텁 시절의 rc 2 가 남아 있지 않아야 한다.
func TestDmctlRun_AttachDetachAreNotStubs(t *testing.T) {
	ts, _ := runStub(t, map[string]string{
		"/api/runs/attach": `{"id":"m-1","toolId":"t","tabId":"tab","state":"ready"}`,
		"/api/runs/detach": `{"id":"m-1","toolId":"t","tabId":"","state":"ready"}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	for _, sub := range []string{"attach", "detach"} {
		var errBuf bytes.Buffer
		if code := runDmctlRun([]string{sub, "--member", "m-1"}, io.Discard, &errBuf); code != 0 {
			t.Fatalf("%s: exit = %d (%s)", sub, code, errBuf.String())
		}
		if strings.Contains(errBuf.String(), "구현되지 않았다") {
			t.Fatalf("%s 가 아직 스텁이다", sub)
		}
	}
}
