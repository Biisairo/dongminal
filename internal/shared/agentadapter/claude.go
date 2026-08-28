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
	ArgvSeparator:   "--",
	// 멤버가 보고·질문을 할 수 있게 dmctl 만 사전 허용한다. 그 외 명령은
	// 그대로 승인을 받는다 — 멤버에게 사용자가 주지 않은 권한을 주지 않는다.
	MemberArgs: []string{"--allowedTools", "Bash(dmctl:*)"},
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
//
// 묶음 C 가 더한 것은 **상태 매핑이 아니라 곁들이 값**이다 (FR-CBG-1):
// session_id·transcript_path 는 모든 이벤트에서 그대로 실리고, PreCompact 는
// working 을 유지한 채 Compacted 를 세운다. 활동 상태 어휘는 한 글자도 바뀌지
// 않는다 — 컨텍스트 관측이 activity 패널의 동작을 바꾸면 안 된다 (NFR-CBG-2).
func parseClaudeHook(data []byte) (Report, bool) {
	var ev struct {
		Event      string          `json:"hook_event_name"`
		ToolName   string          `json:"tool_name"`
		ToolInput  json.RawMessage `json:"tool_input"`
		Prompt     string          `json:"prompt"`
		Source     string          `json:"source"`
		SessionID  string          `json:"session_id"`
		Transcript string          `json:"transcript_path"`
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return Report{}, false
	}
	var rep Report
	switch ev.Event {
	case "PreToolUse", "PostToolUse":
		rep = Report{State: "working", Tool: ev.ToolName, Detail: claudeToolDetail(ev.ToolName, ev.ToolInput)}
	case "SubagentStop":
		rep = Report{State: "working"}
	case "PreCompact":
		// 압축은 추정이 아니라 확정이다. 크기가 작아 보여도 정보는 이미
		// 유실됐으므로 소비자는 이 신호를 크기보다 우선한다 (FR-CBG-1).
		rep = Report{State: "working", Compacted: true}
	case "UserPromptSubmit":
		rep = Report{State: "working", Detail: ev.Prompt}
	case "Notification":
		rep = Report{State: "waiting"}
	case "Stop":
		rep = Report{State: "done"}
	case "SessionEnd":
		rep = Report{State: "ended"}
	case "SessionStart":
		rep = Report{State: "idle", Detail: ev.Source}
	default:
		return Report{}, false
	}
	rep.SessionID = ev.SessionID
	rep.Transcript = ev.Transcript
	return rep, true
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
