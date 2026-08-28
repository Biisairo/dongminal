package runtimebin

import (
	"fmt"
	"io"
	"os"

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
	toolID := os.Getenv("DONGMINAL_TOOL_ID")
	if toolID == "" {
		return 0
	}
	body := map[string]any{"toolId": toolID, "state": rep.State, "tool": rep.Tool, "detail": rep.Detail}
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
	httpPostJSON(baseURL()+contextObservePath, body)
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
				httpPostJSON(baseURL()+"/api/tools/activity/set",
					map[string]any{"toolId": toolID, "state": rep.State, "tool": rep.Tool, "detail": rep.Detail})
			}
			return
		}
	}
}
