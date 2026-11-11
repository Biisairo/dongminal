package agentadapter

import "testing"

// ACTIVITY_STATE_SUBAGENT_SRS 묶음 H — 훅 해석 (TC-ASV-2·3·4).

// TC-ASV-2: main 훅의 해석표 (FR-ASV-4). want 가 빈 상태면 main 보고가 없다.
func TestClaudeHook_MainTable(t *testing.T) {
	cases := []struct {
		name, payload, state, tool, detail string
	}{
		{"UserPromptSubmit", `{"hook_event_name":"UserPromptSubmit","prompt":"고쳐줘"}`, "working", "", "고쳐줘"},
		{"PreToolUse", `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}`, "working", "Bash", "ls"},
		{"PostToolUse", `{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/a.go"}}`, "working", "Read", "/a.go"},
		{"PostToolUseFailure", `{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"make"},"error":"exit 2"}`, "working", "Bash", "make"},
		{"PermissionRequest", `{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm x"}}`, "waiting", "Bash", "rm x"},
		{"Notification permission_prompt", `{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"needs permission"}`, "waiting", "", "needs permission"},
		{"Notification elicitation_dialog", `{"hook_event_name":"Notification","notification_type":"elicitation_dialog","message":"m"}`, "waiting", "", "m"},
		{"Notification elicitation_url_dialog", `{"hook_event_name":"Notification","notification_type":"elicitation_url_dialog","message":"m"}`, "waiting", "", "m"},
		{"Notification agent_needs_input", `{"hook_event_name":"Notification","notification_type":"agent_needs_input","message":"m"}`, "waiting", "", "m"},
		{"Notification idle_prompt", `{"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"}`, "", "", ""},
		{"Notification auth_success", `{"hook_event_name":"Notification","notification_type":"auth_success"}`, "", "", ""},
		{"Notification 종류 없음", `{"hook_event_name":"Notification","message":"m"}`, "", "", ""},
		{"PreCompact", `{"hook_event_name":"PreCompact","trigger":"auto"}`, "working", "", ""},
		{"PostCompact manual", `{"hook_event_name":"PostCompact","trigger":"manual"}`, "idle", "", ""},
		{"PostCompact auto", `{"hook_event_name":"PostCompact","trigger":"auto"}`, "", "", ""},
		{"Stop", `{"hook_event_name":"Stop","background_tasks":[{"id":"a1","status":"running"}]}`, "done", "", ""},
		{"StopFailure", `{"hook_event_name":"StopFailure","error":"rate_limit"}`, "done", "", "rate_limit"},
		{"SessionStart startup", `{"hook_event_name":"SessionStart","source":"startup"}`, "idle", "", "startup"},
		{"SessionStart compact", `{"hook_event_name":"SessionStart","source":"compact"}`, "", "", ""},
		{"SessionEnd", `{"hook_event_name":"SessionEnd"}`, "ended", "", ""},
		// main 에서 온 SubagentStart·SubagentStop 은 없다 — 와도 main 을 건드리지 않는다.
		{"SubagentStop agent_id 없음", `{"hook_event_name":"SubagentStop"}`, "", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, ok := parseClaudeHook([]byte(tc.payload))
			if !ok {
				t.Fatalf("파싱하지 못했다: %s", tc.payload)
			}
			if r.State != tc.state || r.Tool != tc.tool || r.Detail != tc.detail {
				t.Fatalf("got state=%q tool=%q detail=%q, want %q %q %q", r.State, r.Tool, r.Detail, tc.state, tc.tool, tc.detail)
			}
			if r.Sub != nil {
				t.Fatalf("main 훅이 서브에이전트 보고를 냈다: %+v", r.Sub)
			}
		})
	}
}

// TC-ASV-2: 내부 에이전트 훅(agent_type 빔)은 아무것도 보고하지 않는다 (FR-ASV-3, §2.2 ③).
func TestClaudeHook_InternalAgentIsDropped(t *testing.T) {
	for _, p := range []string{
		`{"hook_event_name":"SubagentStop","agent_id":"a5b478e531a856437","agent_type":""}`,
		`{"hook_event_name":"SubagentStop","agent_id":"a5b478e531a856437"}`,
		`{"hook_event_name":"PreToolUse","agent_id":"a5b4","agent_type":"","tool_name":"Read"}`,
	} {
		if r, ok := parseClaudeHook([]byte(p)); ok {
			t.Fatalf("내부 에이전트 훅이 보고됐다: %s → %+v", p, r)
		}
	}
}

// TC-ASV-3: 서브에이전트 훅의 해석표 (FR-ASV-5).
func TestClaudeHook_SubagentTable(t *testing.T) {
	const id, typ = "a92250a6023d34136", "Explore"
	sub := func(ev, extra string) string {
		return `{"hook_event_name":"` + ev + `","agent_id":"` + id + `","agent_type":"` + typ + `"` + extra + `}`
	}
	cases := []struct {
		name, payload         string
		state, tool, detail   string
		mainState, mainDetail string
	}{
		{"SubagentStart", sub("SubagentStart", ""), "working", "", "", "", ""},
		{"PreToolUse", sub("PreToolUse", `,"tool_name":"Grep","tool_input":{"pattern":"parse"}`), "working", "Grep", "parse", "", ""},
		{"PostToolUse", sub("PostToolUse", `,"tool_name":"Bash","tool_input":{"command":"ls"}`), "working", "Bash", "ls", "", ""},
		{"PostToolUseFailure", sub("PostToolUseFailure", `,"tool_name":"Bash","tool_input":{"command":"x"}`), "working", "Bash", "x", "", ""},
		{"PermissionRequest", sub("PermissionRequest", `,"tool_name":"Bash","tool_input":{"command":"rm"}`), "waiting", "Bash", "rm", "waiting", "rm"},
		{"Notification waiting", sub("Notification", `,"notification_type":"permission_prompt","message":"m"`), "waiting", "", "m", "waiting", "m"},
		{"SubagentStop", sub("SubagentStop", ""), "done", "", "", "", ""},
		// TC-ASV-17 (C-10, D-ASV-13): SubagentHandback 은 서브에이전트의 마지막 일이라 done 이다.
		{"PreToolUse SubagentHandback", sub("PreToolUse", `,"tool_name":"SubagentHandback","tool_input":{"message":"report"}`), "done", "SubagentHandback", "", "", ""},
		{"PostToolUse SubagentHandback", sub("PostToolUse", `,"tool_name":"SubagentHandback","tool_input":{"message":"report"}`), "done", "SubagentHandback", "", "", ""},
		{"PostToolUseFailure SubagentHandback", sub("PostToolUseFailure", `,"tool_name":"SubagentHandback","tool_input":{"message":"report"}`), "done", "SubagentHandback", "", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, ok := parseClaudeHook([]byte(tc.payload))
			if !ok || r.Sub == nil {
				t.Fatalf("서브에이전트 보고가 없다: %+v ok=%v", r, ok)
			}
			s := r.Sub
			if s.AgentID != id || s.AgentType != typ || s.State != tc.state || s.Tool != tc.tool || s.Detail != tc.detail {
				t.Fatalf("sub=%+v, want %s %s %q %q %q", s, id, typ, tc.state, tc.tool, tc.detail)
			}
			if r.State != tc.mainState || (tc.mainState != "" && r.Detail != tc.mainDetail) {
				t.Fatalf("main state=%q detail=%q, want %q %q", r.State, r.Detail, tc.mainState, tc.mainDetail)
			}
			if r.UserPrompt {
				t.Fatal("서브에이전트 훅이 사용자 턴 표시를 세웠다")
			}
		})
	}
	// 그 밖의 훅은 서브에이전트 활동도 main 도 건드리지 않는다.
	r, ok := parseClaudeHook([]byte(sub("Notification", `,"notification_type":"idle_prompt"`)))
	if !ok || r.Sub != nil || r.State != "" {
		t.Fatalf("idle_prompt 가 무언가를 보고했다: %+v ok=%v", r, ok)
	}
}

// TC-ASV-4: 백그라운드 서브에이전트의 보고는 사용자 턴이 아니다 (FR-ASV-6, C-8).
func TestClaudeHook_AgentMessagePromptIsBackground(t *testing.T) {
	r, ok := parseClaudeHook([]byte(`{"hook_event_name":"UserPromptSubmit","prompt":"<agent-message from=\"a922\">\n[Subagent hand-back] ..."}`))
	if !ok || r.State != "working" {
		t.Fatalf("got %+v ok=%v", r, ok)
	}
	if r.UserPrompt {
		t.Fatal("서브에이전트 보고가 사용자 턴으로 읽혔다")
	}
}

// TC-ASV-10 (FR-ASV-20): 계정 한도의 임자는 선언으로 찾는다 — claude 다.
func TestStatusLineReporter_IsClaude(t *testing.T) {
	if id, ok := StatusLineReporter(); !ok || id != claudeID {
		t.Fatalf("id=%q ok=%v", id, ok)
	}
}
