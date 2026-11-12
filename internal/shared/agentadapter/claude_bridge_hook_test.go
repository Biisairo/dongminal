package agentadapter

import (
	"strings"
	"testing"
)

// TELEGRAM_BRIDGE_SRS TC-TGB-70 — 브리지가 쓰는 곁들이 값 (FR-TGB-80·81).
//
// payload 는 2026-11-12 실측(§2.2)의 모양 그대로다.
func TestClaudeHook_BridgeFields(t *testing.T) {
	cases := []struct {
		name, payload string
		hook, input   string
	}{
		{"PreToolUse Bash 는 원문을 싣지 않는다",
			`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"date > out.txt"},"tool_use_id":"toolu_1"}`,
			"PreToolUse", ""},
		{"PreToolUse AskUserQuestion 은 원문을 싣는다",
			`{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"색?","options":[{"label":"red"}]}]},"tool_use_id":"toolu_2"}`,
			"PreToolUse", `{"questions":[{"question":"색?","options":[{"label":"red"}]}]}`},
		{"PermissionRequest 는 원문을 싣는다",
			`{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm x"},"permission_suggestions":[]}`,
			"PermissionRequest", `{"command":"rm x"}`},
		{"PostToolUse 는 원문을 싣지 않는다",
			`{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"toolu_3","tool_response":{"stdout":"secret"}}`,
			"PostToolUse", ""},
		{"StopFailure",
			`{"hook_event_name":"StopFailure","error":"rate_limit"}`,
			"StopFailure", ""},
		{"Stop",
			`{"hook_event_name":"Stop"}`,
			"Stop", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, ok := parseClaudeHook([]byte(tc.payload))
			if !ok {
				t.Fatalf("파싱하지 못했다")
			}
			if r.Hook != tc.hook {
				t.Fatalf("hook = %q, 기대 %q", r.Hook, tc.hook)
			}
			if string(r.Input) != tc.input {
				t.Fatalf("input = %s, 기대 %s", r.Input, tc.input)
			}
			if r.InputOver {
				t.Fatal("상한 안인데 inputOver 가 섰다")
			}
		})
	}
}

// 16KB 를 넘는 원문은 싣지 않고 표시만 단다. 잘린 JSON 은 깨진다 (FR-TGB-81).
func TestClaudeHook_BridgeInputOverCap(t *testing.T) {
	big := strings.Repeat("a", BridgeInputMax)
	payload := `{"hook_event_name":"PermissionRequest","tool_name":"Write","tool_input":{"file_path":"/x","content":"` + big + `"}}`
	r, ok := parseClaudeHook([]byte(payload))
	if !ok {
		t.Fatal("파싱하지 못했다")
	}
	if len(r.Input) != 0 || !r.InputOver {
		t.Fatalf("상한을 넘었는데 input=%d바이트 inputOver=%v", len(r.Input), r.InputOver)
	}
	if r.State != "waiting" {
		t.Fatalf("상태 해석이 바뀌었다: %q", r.State)
	}
}

// 서브에이전트의 권한 요청도 사람을 기다리게 하므로 같은 값을 싣는다.
func TestClaudeHook_BridgeFieldsSubagentPermission(t *testing.T) {
	payload := `{"hook_event_name":"PermissionRequest","agent_id":"a1","agent_type":"general","tool_name":"Bash","tool_input":{"command":"ls"}}`
	r, ok := parseClaudeHook([]byte(payload))
	if !ok {
		t.Fatal("파싱하지 못했다")
	}
	if r.Hook != "PermissionRequest" || string(r.Input) != `{"command":"ls"}` {
		t.Fatalf("hook=%q input=%s", r.Hook, r.Input)
	}
}
