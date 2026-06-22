package runtimebin

import (
	"encoding/json"
	"io"
	"os"
)

const dmctlActivityHelp = `dmctl activity <agent>
  현재 pane 에서 도는 에이전트의 "지금 무엇을 하는가"(작업 상태)를 서버에 보고한다.
  에이전트 hook 의 stdin 으로 들어온 JSON 을 파싱해 state/tool/detail 을 추출한다.
  <agent>: claude | codex. DONGMINAL_PANE_ID 로 자신을 식별한다.
  에이전트 hook(claude PreToolUse 등)에서 호출되며, 비0 종료가 에이전트의 도구
  실행을 막지 않도록 항상 0 으로 종료한다(실패는 조용히 무시).
`

// activityReport is the parsed result of an agent hook event.
type activityReport struct {
	State  string
	Tool   string
	Detail string
}

// runDmctlActivity reports the calling pane's current agent activity to the
// server. It ALWAYS exits 0: it runs as an agent hook (e.g. claude PreToolUse)
// where a non-zero exit could block the agent's tool call (NFR-AAP-5). Every
// failure path — no agent arg, unreadable stdin, unparseable event, missing
// DONGMINAL_PANE_ID, server error — is silent.
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
	agent := args[0]
	data, err := io.ReadAll(io.LimitReader(stdin, 1<<16))
	if err != nil {
		return 0
	}
	var rep activityReport
	var ok bool
	switch agent {
	case "claude":
		rep, ok = parseClaudeHook(data)
	case "codex":
		rep, ok = parseCodexHook(data)
	}
	if !ok {
		return 0
	}
	paneID := os.Getenv("DONGMINAL_PANE_ID")
	if paneID == "" {
		return 0
	}
	body := map[string]any{"paneId": paneID, "state": rep.State, "tool": rep.Tool, "detail": rep.Detail}
	httpPostJSON(baseURL()+"/api/panes/activity/set", body)
	return 0
}

// parseClaudeHook maps a Claude Code hook event (stdin JSON) to an activity
// report. Covers all lifecycle hooks (FR-AAP-7): PreToolUse/PostToolUse →
// working (+tool/detail), UserPromptSubmit → working (+prompt), SubagentStop/
// PreCompact → working, Notification → waiting, Stop → done, SessionEnd →
// ended (removes the card), SessionStart → idle (+source). Unknown ignored.
func parseClaudeHook(data []byte) (activityReport, bool) {
	var ev struct {
		Event     string          `json:"hook_event_name"`
		ToolName  string          `json:"tool_name"`
		ToolInput json.RawMessage `json:"tool_input"`
		Prompt    string          `json:"prompt"`
		Source    string          `json:"source"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return activityReport{}, false
	}
	switch ev.Event {
	case "PreToolUse", "PostToolUse":
		return activityReport{State: "working", Tool: ev.ToolName, Detail: claudeToolDetail(ev.ToolName, ev.ToolInput)}, true
	case "UserPromptSubmit":
		return activityReport{State: "working", Detail: ev.Prompt}, true
	case "SubagentStop", "PreCompact":
		return activityReport{State: "working"}, true
	case "Notification":
		return activityReport{State: "waiting"}, true
	case "Stop":
		return activityReport{State: "done"}, true
	case "SessionEnd":
		return activityReport{State: "ended"}, true
	case "SessionStart":
		return activityReport{State: "idle", Detail: ev.Source}, true
	}
	return activityReport{}, false
}

// claudeToolDetail pulls the most informative argument out of a tool_input for
// display (FR-AAP-7). Unknown tools yield an empty detail.
func claudeToolDetail(tool string, input json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(input, &m); err != nil {
		return ""
	}
	pick := func(k string) string {
		if v, ok := m[k].(string); ok {
			return v
		}
		return ""
	}
	switch tool {
	case "Bash":
		return pick("command")
	case "Edit", "Write", "Read", "NotebookEdit":
		return pick("file_path")
	case "Grep", "Glob":
		return pick("pattern")
	}
	return ""
}

// reportCodexActivity also reports codex turn-complete as activity (done) when
// `dmctl notify codex <json>` is invoked, so the activity panel shows codex
// state alongside the attention alarm without changing the codex wrapper
// (FR-AAP-9). Codex passes its event JSON as the final argv. Best-effort and
// silent — never affects the notify exit status.
func reportCodexActivity(label string, args []string, paneID string) {
	if label != "codex" || paneID == "" {
		return
	}
	for _, a := range args {
		if len(a) > 0 && a[0] == '{' {
			if rep, ok := parseCodexHook([]byte(a)); ok {
				httpPostJSON(baseURL()+"/api/panes/activity/set",
					map[string]any{"paneId": paneID, "state": rep.State, "tool": rep.Tool, "detail": rep.Detail})
			}
			return
		}
	}
}

// parseCodexHook maps a Codex notify event to an activity report. Codex's
// standard notify emits only agent-turn-complete → done; it has no pre-tool
// event, so tool/detail stay empty (FR-AAP-9 / AAP-2).
func parseCodexHook(data []byte) (activityReport, bool) {
	var ev struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return activityReport{}, false
	}
	if ev.Type == "agent-turn-complete" {
		return activityReport{State: "done"}, true
	}
	return activityReport{}, false
}
