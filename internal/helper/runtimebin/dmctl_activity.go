package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"dongminal/internal/shared/agentadapter"
)

const dmctlActivityHelp = `dmctl activity <agent>
  현재 tool 에서 도는 에이전트의 "지금 무엇을 하는가"(작업 상태)를 서버에 보고한다.
  에이전트 hook 의 stdin 으로 들어온 JSON 을 파싱해 state/tool/detail 을 추출한다.
  <agent>: claude | codex. DONGMINAL_TOOL_ID 로 자신을 식별한다.
  에이전트 hook(claude PreToolUse 등)에서 호출되며, 비0 종료가 에이전트의 도구
  실행을 막지 않도록 항상 0 으로 종료한다(실패는 조용히 무시).
`

// runDmctlActivity reports the calling tool's current agent activity to the
// server. It ALWAYS exits 0: it runs as an agent hook (e.g. claude PreToolUse)
// where a non-zero exit could block the agent's tool call (NFR-AAP-5). Every
// failure path — no agent arg, unreadable stdin, unparseable event, missing
// DONGMINAL_TOOL_ID, server error — is silent.
//
// 훅 파서는 어댑터 레지스트리에서 온다 (FR-ADP-2). 예전의 `switch agent` 는
// 여기 없다.
//
// 알 수 없는 에이전트 id 는 stderr 로 **명확히** 말하되 종료 코드는 0 을 지킨다.
// FR-ADP-3(명확한 오류)과 NFR-AAP-5(훅은 비0 로 끝나지 않는다)가 만나는 자리이며,
// 후자가 이긴다 — 여기서 비0 을 내면 사용자의 에이전트가 도구 호출을 못 한다.
// 오케스트레이션 경로(`dmctl run member`·POST /api/runs/members)는 같은 입력을
// 비0/4xx 로 거부하므로, 잘못된 id 가 조용히 통과하는 경로는 없다.
func runDmctlActivity(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	for _, a := range args {
		if a == "-h" || a == "--help" {
			io.WriteString(stdout, dmctlActivityHelp)
			return 0
		}
	}
	if len(args) == 0 {
		return 0
	}
	adapter, err := agentadapter.Get(args[0])
	if err != nil {
		fmt.Fprintf(stderr, "dmctl activity: %v\n", err)
		return 0
	}
	data, err := io.ReadAll(io.LimitReader(stdin, 1<<16))
	if err != nil {
		return 0
	}
	rep, ok := adapter.HookParse(data)
	if !ok {
		return 0
	}
	toolID := selfToolID()
	if toolID == "" {
		return 0
	}
	// AGENT_EVENT_ABSTRACTION_SRS FR-AEV-10: **에이전트 id 를 함께 보낸다.**
	// 서버가 그 에이전트의 이벤트 선언(`Signals`)을 봐야 `done` 알람의 판정을
	// 옳게 할 수 있다 (FR-AEV-12) — 턴의 출처를 말할 수 없는 에이전트를 "사용자
	// 턴이 아니었다" 로 읽으면 그 에이전트는 한 번도 울지 않는다.
	body := map[string]any{"toolId": toolID, "agent": adapter.ID, "state": rep.State,
		"tool": rep.Tool, "detail": rep.Detail, "userPrompt": rep.UserPrompt}
	httpPostJSON(baseURL()+"/api/tools/activity/set", body)
	reportContext(rep, toolID)
	return 0
}

// contextObservePath 는 컨텍스트 관측의 수신 종단이다 (ORCHESTRATION_V2_SRS
// 묶음 C). activity 와 **별도 종단**인 이유는 둘의 실패가 서로를 막으면 안 되기
// 때문이다 (NFR-CBG-2) — 관측 층의 오류가 활동 보고를 삼키면 사람이 보는 패널이
// 먼저 죽는다.
const contextObservePath = "/api/runs/context"

// reportContext 는 이 훅이 실어 온 컨텍스트 신호를 서버에 넘긴다 (FR-CBG-1~4).
//
// **보내는 것은 숫자와 식별자뿐이다** — transcript 의 바이트 수, 세션 id, 그리고
// 압축이 일어났다는 사실. 파일 내용은 어떤 형태로도 이 페이로드에 들어가지 않고
// (NFR-4), 경로조차 보내지 않는다 — 서버는 그 파일을 열 이유가 없다. 그 사실은
// dmctl_activity_context_test.go 가 카나리아로 고정한다 (V-CBG-11).
//
// 신호가 하나도 없으면 아무것도 보내지 않는다. 관측하지 못한 것을 0 으로
// 보내면 서버가 그것을 값으로 읽는다 — 모르는 것은 모르는 채로 둔다 (FR-CBG-5).
func reportContext(rep agentadapter.Report, toolID string) {
	if rep.Transcript == "" && !rep.Compacted {
		return
	}
	body := map[string]any{"toolId": toolID}
	if rep.Compacted {
		body["compacted"] = true
	}
	if rep.SessionID != "" {
		body["sessionId"] = rep.SessionID
	}
	if size, ok := transcriptSize(rep.Transcript); ok {
		body["bytes"] = size
	}
	// UX_BATCH6_SRS FR-CTX-1·3: 실측 토큰과 그것을 낸 모델. **숫자와 식별자뿐**이며
	// 본문은 여기서도 빠져나가지 않는다 (NFR-4).
	if u, ok := transcriptUsage(rep.Transcript); ok {
		body["tokens"] = u.tokens
		if u.model != "" {
			body["model"] = u.model
		}
	}
	httpPostJSON(baseURL()+contextObservePath, body)
}

// usageObs 는 transcript 의 마지막 assistant 줄에서 읽은 것이다 — 그 요청이
// 실제로 모델에 보낸 컨텍스트의 크기와, 답한 모델의 이름.
type usageObs struct {
	tokens int64
	model  string
}

// usageTailMax 는 뒤에서부터 읽을 상한이다 (NFR-CBG-1 의 개정).
//
// 파일 전체를 읽지 않는다 — 훅은 에이전트의 핫패스이고 transcript 는 대화가
// 길어질수록 커진다. 마지막 assistant 줄은 파일 끝에 있으므로 꼬리만 보면 된다.
// 상한 안에 그 줄이 없으면(거대한 도구 결과 하나가 꼬리를 다 먹은 경우) **모르는
// 것으로 둔다** — 서버가 바이트 추정으로 떨어진다 (FR-CTX-4).
const usageTailMax = 256 * 1024

// transcriptUsage 는 transcript 꼬리에서 마지막 usage 를 읽는다 (FR-CTX-1·2).
//
// 세는 것은 `input + cache_creation + cache_read` 다. 이 셋의 합이 그 요청의
// 입력 컨텍스트이며, `output_tokens` 는 그 요청의 **답**이라 다음 요청의 입력에
// 들어가기 전까지는 컨텍스트가 아니다.
//
// **내용은 돌려주지 않는다.** 반환 타입이 숫자와 모델 이름뿐인 것이 NFR-4 의
// 첫 방벽이다 — `transcriptSize` 와 같은 규약이다.
func transcriptUsage(path string) (usageObs, bool) {
	if path == "" {
		return usageObs{}, false
	}
	f, err := os.Open(path)
	if err != nil {
		return usageObs{}, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() || st.Size() == 0 {
		return usageObs{}, false
	}
	off, n := int64(0), st.Size()
	if n > usageTailMax {
		off, n = st.Size()-usageTailMax, usageTailMax
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, off); err != nil && err != io.EOF {
		return usageObs{}, false
	}
	lines := strings.Split(string(buf), "\n")
	// 처음부터 읽지 않았으면 첫 조각은 잘린 줄이다 — 해석하면 오답이 아니라
	// 실패이지만, 애초에 후보에서 뺀다.
	if off > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	for i := len(lines) - 1; i >= 0; i-- {
		if u, ok := parseUsageLine(lines[i]); ok {
			return u, true
		}
	}
	return usageObs{}, false
}

// parseUsageLine 은 JSONL 한 줄에서 usage 를 뽑는다. usage 가 없으면 그 줄은
// 후보가 아니다 — 사용자 줄·요약 줄·메타 줄이 그렇다.
func parseUsageLine(line string) (usageObs, bool) {
	line = strings.TrimSpace(line)
	if line == "" || !strings.Contains(line, `"usage"`) {
		return usageObs{}, false
	}
	var rec struct {
		Message struct {
			Model string `json:"model"`
			Usage *struct {
				Input      int64 `json:"input_tokens"`
				CacheWrite int64 `json:"cache_creation_input_tokens"`
				CacheRead  int64 `json:"cache_read_input_tokens"`
			} `json:"usage"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(line), &rec); err != nil || rec.Message.Usage == nil {
		return usageObs{}, false
	}
	u := rec.Message.Usage
	total := u.Input + u.CacheWrite + u.CacheRead
	if total <= 0 {
		return usageObs{}, false
	}
	return usageObs{tokens: total, model: rec.Message.Model}, true
}

// transcriptSize 는 transcript 의 **크기만** 잰다 — stat 1회이며 파일을 열지도
// 읽지도 파싱하지도 않는다 (NFR-CBG-1). 훅은 에이전트의 핫패스이고, 대화가
// 길어질수록 커지는 파일을 매 도구 호출마다 훑는 것은 그 자리에서 감당할 수
// 없다.
//
// 내용은 호출자에게도 돌려주지 않는다. 반환 타입이 숫자뿐인 것이 NFR-4 의 첫
// 방벽이다 — 내용을 실어 나를 통로가 애초에 없어야 한다.
//
// 접근 실패는 오류가 아니라 **모름**이다 (NFR-CBG-2). ok=false 로 낼 뿐 훅을
// 실패시키지 않는다.
func transcriptSize(path string) (size int64, ok bool) {
	if path == "" {
		return 0, false
	}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		return 0, false
	}
	return st.Size(), true
}

// reportCodexActivity also reports codex turn-complete as activity (done) when
// `dmctl notify codex <json>` is invoked, so the activity panel shows codex
// state alongside the attention alarm without changing the codex wrapper
// (FR-AAP-9). Codex passes its event JSON as the final argv. Best-effort and
// silent — never affects the notify exit status.
func reportCodexActivity(label string, args []string, toolID string) {
	if label != "codex" || toolID == "" {
		return
	}
	adapter, err := agentadapter.Get(label)
	if err != nil {
		return
	}
	for _, a := range args {
		if len(a) > 0 && a[0] == '{' {
			if rep, ok := adapter.HookParse([]byte(a)); ok {
				// **`agent` 를 싣지 않는다** (FR-AEV-21). 이 경로는 `dmctl notify
				// codex` 안에서 불리므로, 알람은 그 `notify` 가 이미 낸다
				// (FR-ATN-12 — `done`·`waiting` 이 아닌 라벨은 무조건 알람).
				// 여기서 id 를 실으면 `Signals.UserTurn=false` 가 무조건 알람을
				// 한 번 더 만들어 **같은 턴이 두 번 운다.**
				httpPostJSON(baseURL()+"/api/tools/activity/set",
					map[string]any{"toolId": toolID, "state": rep.State, "tool": rep.Tool, "detail": rep.Detail})
			}
			return
		}
	}
}
