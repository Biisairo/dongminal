package runtimebin

import (
	"fmt"
	"io"
	"os"

	"dongminal/internal/agentadapter"
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
	return 0
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
