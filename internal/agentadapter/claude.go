package agentadapter

import "encoding/json"

// claudeAdapter 는 Claude Code 선언이다. **이것이 검증 대상이다** (D-D).
//
// 전 생명주기 훅을 주므로 준비완료를 화면에서 추론할 필요가 없다 —
// SessionStart → idle 이 사다리 1단계를 그 자리에서 성립시킨다.
var claudeAdapter = Adapter{
	ID:              "claude",
	DetectCmd:       "claude",
	Launch:          []string{"claude"},
	ModelFlag:       "--model",
	PromptInjection: PromptArgv, // claude [options] [command] [prompt]
	PolicyInjection: PolicyInjection{
		// 알림 훅은 --settings, 오케스트레이션 스킬은 --plugin-dir 로 붙는다.
		// 둘 다 per-invocation 이라 사용자의 ~/.claude 를 건드리지 않는다.
		Flags:         []string{"--settings", "--plugin-dir"},
		SessionScoped: true,
	},
	HookParse: parseClaudeHook,
	Readiness: Readiness{Hooks: true},
	// /exit 은 대화를 저장하고 정상 종료한다. SIGKILL 로 끊으면 이력이 남지 않는다.
	ExitCommand: "/exit",
}

// parseClaudeHook maps a Claude Code hook event (stdin JSON) to an activity
// report. Covers all lifecycle hooks (FR-AAP-7): PreToolUse/PostToolUse →
// working (+tool/detail), UserPromptSubmit → working (+prompt), SubagentStop/
// PreCompact → working, Notification → waiting, Stop → done, SessionEnd →
// ended (removes the card), SessionStart → idle (+source). Unknown ignored.
//
// 이 함수는 dmctl_activity.go 에서 여기로 **무동작 이동**했다 (FR-ADP-2).
// 매핑을 "개선"하지 않는다 — 회귀 검출기는 runtimebin/dmctl_activity_test.go 다.
func parseClaudeHook(data []byte) (Report, bool) {
	var ev struct {
		Event     string          `json:"hook_event_name"`
		ToolName  string          `json:"tool_name"`
		ToolInput json.RawMessage `json:"tool_input"`
		Prompt    string          `json:"prompt"`
		Source    string          `json:"source"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return Report{}, false
	}
	switch ev.Event {
	case "PreToolUse", "PostToolUse":
		return Report{State: "working", Tool: ev.ToolName, Detail: claudeToolDetail(ev.ToolName, ev.ToolInput)}, true
	case "UserPromptSubmit":
		return Report{State: "working", Detail: ev.Prompt}, true
	case "SubagentStop", "PreCompact":
		return Report{State: "working"}, true
	case "Notification":
		return Report{State: "waiting"}, true
	case "Stop":
		return Report{State: "done"}, true
	case "SessionEnd":
		return Report{State: "ended"}, true
	case "SessionStart":
		return Report{State: "idle", Detail: ev.Source}, true
	}
	return Report{}, false
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
