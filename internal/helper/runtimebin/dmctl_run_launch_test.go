package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"dongminal/internal/shared/agentadapter"
)

// 묶음 P 의 CLI 절반 — 프리앰블 전달 (RUN_ORCHESTRATION_SRS FR-PRE-1/8).

const stubPreamble = "너는 dongminal Run 의 멤버다.\n" +
	"# 보고는 정확히 한 번.\n" +
	"dmctl run report --run run-1 --member m-1 --outcome succeeded --summary \"...\"\n"

func preambleStub(t *testing.T, agent string) (*[]runCall, func()) {
	t.Helper()
	blob, err := json.Marshal(map[string]any{
		"runId": "run-1", "memberId": "m-1", "role": "writer", "agent": agent,
		"tabId": "tab-b", "toolId": "tool-b", "runState": "open",
		"preamble": stubPreamble,
	})
	if err != nil {
		t.Fatal(err)
	}
	ts, calls := runStub(t, map[string]string{"/api/runs/preamble": string(blob)})
	pointDmctlAtServer(t, ts, "tool-a")
	return calls, func() {}
}

// FR-PRE-1: 기본 출력은 도구의 셸에 그대로 타이핑할 기동 명령줄이다. 조정자가
// send-input 으로 파이프하는 것이 이 명령의 쓰임이다.
func TestDmctlRunLaunch_PrintsRunnableLaunchLine(t *testing.T) {
	calls, _ := preambleStub(t, "claude")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"launch", "--member", "m-1", "--model", "sonnet"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if q := (*calls)[0].Query; !strings.Contains(q, "member=m-1") {
		t.Fatalf("멤버를 지목하지 않았다: %q", q)
	}
	line := out.String()
	if !strings.HasPrefix(line, "claude --model sonnet '") {
		t.Fatalf("기동줄이 아니다: %q", line)
	}
	if !strings.Contains(line, "dmctl run report --run run-1 --member m-1") {
		t.Fatalf("프리앰블이 실리지 않았다: %q", line)
	}
	// 셸에 붙일 한 덩어리여야 한다 — 개행으로 끝나되 명령이 둘로 쪼개지면 안 된다.
	if strings.Count(line, "claude ") != 1 {
		t.Fatalf("기동줄이 여러 개다: %q", line)
	}
}

// --text 는 프리앰블 본문만 낸다. promptInjection=stdin-after-start 인 에이전트나
// 디버깅에서 쓴다.
func TestDmctlRunLaunch_TextPrintsPreambleOnly(t *testing.T) {
	preambleStub(t, "claude")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"launch", "--member", "m-1", "--text"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if strings.Contains(out.String(), "claude --model") {
		t.Fatalf("--text 인데 기동줄이 섞였다: %q", out.String())
	}
	if !strings.Contains(out.String(), "dmctl run report") {
		t.Fatalf("프리앰블 본문이 없다: %q", out.String())
	}
}

// FR-ADP-1: 주입 방식은 `--json` 에 노출된다 — 호출자가 두 단계로 나눠 보낼지 여기서
// 안다. codex 는 D-A-4 로 argv 가 됐으므로 이 테스트의 표본은 어댑터 값이 아니라
// 노출 여부다.
func TestDmctlRunLaunch_JSONExposesPromptInjectionMode(t *testing.T) {
	preambleStub(t, "codex")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"launch", "--member", "m-1", "--json"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	var got struct {
		Agent           string `json:"agent"`
		PromptInjection string `json:"promptInjection"`
		Launch          string `json:"launch"`
		Preamble        string `json:"preamble"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("JSON 이 아니다: %v (%s)", err, out.String())
	}
	if got.PromptInjection != string(agentadapter.PromptArgv) {
		t.Fatalf("주입 방식이 노출되지 않았다: %+v", got)
	}
	if !strings.Contains(got.Launch, "dmctl run report") {
		t.Fatalf("argv 인데 기동줄에 프롬프트가 없다: %q", got.Launch)
	}
	if !strings.Contains(got.Preamble, "dmctl run report") {
		t.Fatalf("프리앰블이 따로 제공되지 않았다: %+v", got)
	}
}

// FR-ADP-3: 알 수 없는 에이전트 id 는 명확한 오류다. 서버가 그런 값을 돌려주면
// (구 기록 등) 기본 에이전트로 폴백하지 말고 멈춘다.
func TestDmctlRunLaunch_UnknownAgentFails(t *testing.T) {
	preambleStub(t, "gpt-9")

	var out, errb bytes.Buffer
	code := runDmctlRun([]string{"launch", "--member", "m-1"}, &out, &errb)
	if code == 0 {
		t.Fatalf("알 수 없는 에이전트로 성공했다: %q", out.String())
	}
	if !strings.Contains(errb.String(), "gpt-9") {
		t.Fatalf("무엇이 틀렸는지 말하지 않는다: %q", errb.String())
	}
}

func TestDmctlRunLaunch_RequiresMember(t *testing.T) {
	var out, errb bytes.Buffer
	if code := runDmctlRun([]string{"launch"}, &out, &errb); code != 2 {
		t.Fatalf("사용법 오류는 rc=2 여야 한다: %d", code)
	}
	if !strings.Contains(errb.String(), "--member") {
		t.Fatalf("무엇이 빠졌는지 말하지 않는다: %q", errb.String())
	}
}

// FR-PRE-1: brief 는 역할 본문이며 기록에 남아야 프리앰블을 다시 만들 수 있다.
func TestDmctlRunMember_SendsBrief(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/members": `{"id":"m-1","role":"writer","agent":"claude","toolId":"tool-b","tabId":"tab-b","state":"starting","preamble":"P"}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	code := runDmctlRun([]string{"member", "--run", "run-1", "--role", "writer",
		"--agent", "claude", "--at", "tab-b", "--brief", "초안을 쓴다"}, &out, io.Discard)
	if code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if got := (*calls)[0].Body["brief"]; got != "초안을 쓴다" {
		t.Fatalf("brief 가 전달되지 않았다: %+v", (*calls)[0].Body)
	}
}

// FR-PRE-8: Kickoff 는 준비완료 확인 뒤에만 보낸다. 그 확인 수단이 무엇인지
// 도움말이 말해야 한다 — 화면 fingerprint 로 되돌아가는 것을 막는 유일한 지점이다.
func TestDmctlRunHelp_PointsKickoffAtWait(t *testing.T) {
	var out bytes.Buffer
	if code := runDmctlRun([]string{"--help"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	h := out.String()
	if !strings.Contains(h, "run launch") {
		t.Fatalf("launch 가 도움말에 없다:\n%s", h)
	}
	if !strings.Contains(h, "dmctl wait") || !strings.Contains(h, "--for ready") {
		t.Fatalf("Kickoff 전 준비완료 확인이 도움말에 없다 (FR-PRE-8):\n%s", h)
	}
	// 화면 모양으로 준비완료를 판정하는 길로 되돌아가지 않도록 못박는다.
	for _, banned := range []string{"Thinking...", "╭─", "[대기]"} {
		if strings.Contains(h, banned) {
			t.Fatalf("도움말에 화면 fingerprint 가 있다: %q", banned)
		}
	}
}

// FR-PRE-1: brief 는 여러 줄인 것이 보통이다. argv 로만 받으면 조정자가 다시
// 셸 따옴표와 씨름하게 되는데, 그 부담을 없애는 것이 이 묶음의 목적이다.
// `-` = stdin 은 send-input·msg 가 이미 쓰는 규약이다 (FR-DMA-4/5).
func TestDmctlRunMember_BriefFromStdin(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/members": `{"id":"m-1","role":"writer","agent":"claude","toolId":"tool-b","tabId":"tab-b","state":"starting"}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	body := "여러 줄 지시\n둘째 줄에 \"따옴표\" 와 $HOME 이 있다\n"
	var out bytes.Buffer
	code := runDmctlRunStdin(strings.NewReader(body),
		[]string{"member", "--run", "run-1", "--role", "writer",
			"--agent", "claude", "--at", "tab-b", "--brief", "-"}, &out, io.Discard)
	if code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if got := (*calls)[0].Body["brief"]; got != strings.TrimRight(body, "\n") {
		t.Fatalf("stdin brief 가 그대로 전달되지 않았다: %q", got)
	}
}

// stdin 을 지목하지 않았으면 stdin 을 읽지 않아야 한다 — 읽으면 파이프가 없는
// 호출에서 멈춘다.
func TestDmctlRunMember_DoesNotReadStdinUnlessAsked(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/members": `{"id":"m-1","role":"writer","agent":"claude","toolId":"tool-b","tabId":"tab-b"}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	code := runDmctlRunStdin(&blockingReader{t: t},
		[]string{"member", "--run", "run-1", "--role", "writer",
			"--agent", "claude", "--at", "tab-b", "--brief", "인라인"}, &out, io.Discard)
	if code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if got := (*calls)[0].Body["brief"]; got != "인라인" {
		t.Fatalf("인라인 brief 가 어긋났다: %q", got)
	}
}

// blockingReader fails the test if anything reads from it.
type blockingReader struct{ t *testing.T }

func (b *blockingReader) Read([]byte) (int, error) {
	b.t.Fatal("stdin 을 지목하지 않았는데 읽었다")
	return 0, io.EOF
}

// ── M8_UNIFIED_SRS D-A-4 (FBE-06·14) ──
//
// codex 의 터미널 표면이 실측(0.154.0 `--help`: `codex [OPTIONS] [PROMPT]` · `-m, --model`)으로
// argv·`--model` 이 됐다. 기동줄은 claude 와 같은 한 줄이고, stderr 에 안내가 없다.
func TestDmctlRunLaunch_CodexCarriesPreambleAndModel(t *testing.T) {
	preambleStub(t, "codex")

	var out, errb bytes.Buffer
	if code := runDmctlRun([]string{"launch", "--member", "m-1", "--model", "o3"}, &out, &errb); code != 0 {
		t.Fatalf("exit = %d (%s)", code, errb.String())
	}
	line := out.String()
	if !strings.HasPrefix(line, "codex --model o3 '") {
		t.Fatalf("기동줄이 아니다: %q", line)
	}
	if !strings.Contains(line, "dmctl run report --run run-1 --member m-1") {
		t.Fatalf("프리앰블이 실리지 않았다: %q", line)
	}
	if errb.Len() != 0 {
		t.Fatalf("argv 주입인데 안내가 나갔다: %q", errb.String())
	}
}

// 어댑터 계약의 다른 값은 남는다 — 그 값을 든 에이전트에서는 호출자에게 **말한다**.
// `adapter.go` 의 "호출자가 준비완료를 기다렸다가 별도로 붙여넣어야 한다" 의 그 호출자가
// 이 명령이며, 종전에는 아무 신호도 없었다. 종료 코드는 0 — 기동줄은 유효하다.
func TestLaunchNotes_StdinAfterStartAndUnknownModel(t *testing.T) {
	a := agentadapter.Adapter{ID: "x", PromptInjection: agentadapter.PromptStdinAfterStart}
	notes := launchNotes(a, "m-1", "tab-b", "sonnet")
	if len(notes) != 2 {
		t.Fatalf("안내 = %d건, want 2 (프리앰블 · 모델): %q", len(notes), notes)
	}
	for _, want := range []string{"wait --at tab-b --for ready", "run launch --member m-1 --text", "send-input --at tab-b --execute -"} {
		if !strings.Contains(notes[0], want) {
			t.Fatalf("프리앰블 안내에 %q 가 없다: %q", want, notes[0])
		}
	}
	if !strings.Contains(notes[1], "sonnet") || !strings.Contains(notes[1], "생략") {
		t.Fatalf("모델 안내가 어긋난다: %q", notes[1])
	}

	argv := agentadapter.Adapter{ID: "y", PromptInjection: agentadapter.PromptArgv, ModelFlag: "--model"}
	if got := launchNotes(argv, "m-1", "tab-b", "sonnet"); len(got) != 0 {
		t.Fatalf("argv·모델 플래그가 있는데 안내가 나갔다: %q", got)
	}
	if got := launchNotes(argv, "m-1", "tab-b", ""); len(got) != 0 {
		t.Fatalf("모델을 주지 않았는데 안내가 나갔다: %q", got)
	}
}

func TestDmctlRunHelp_ExplainsStdinAfterStartBranch(t *testing.T) {
	if !strings.Contains(dmctlRunHelp, "stdin-after-start") || !strings.Contains(dmctlRunHelp, "--text") {
		t.Fatal("헬프의 3단계 절차에 argv 가 아닌 에이전트의 분기가 없다")
	}
}
