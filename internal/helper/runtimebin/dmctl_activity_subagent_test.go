package runtimebin

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

// ACTIVITY_STATE_SUBAGENT_SRS TC-ASV-5 — `dmctl activity` 가 보내는 것 (FR-ASV-2·3·7, NFR-ASV-1).

func runActivityHook(t *testing.T, payload string) (stdout string, code int) {
	t.Helper()
	var out, errb bytes.Buffer
	code = runDmctlActivity([]string{"claude"}, strings.NewReader(payload), &out, &errb)
	return out.String(), code
}

func decodeBodies(t *testing.T, raws []string) []map[string]any {
	t.Helper()
	out := make([]map[string]any, 0, len(raws))
	for _, r := range raws {
		var m map[string]any
		if err := json.Unmarshal([]byte(r), &m); err != nil {
			t.Fatalf("본문이 JSON 이 아니다: %v", err)
		}
		out = append(out, m)
	}
	return out
}

// 서브에이전트의 도구 훅은 agentId·agentType 을 실은 보고 하나다. main 보고는 없다.
func TestDmctlActivity_SubagentToolHookSendsOneSubReport(t *testing.T) {
	cap := startCapture(t, "tool-sub")
	out, code := runActivityHook(t, `{"hook_event_name":"PreToolUse","agent_id":"a922","agent_type":"Explore","tool_name":"Grep","tool_input":{"pattern":"parse"}}`)
	if code != 0 || out != "" {
		t.Fatalf("code=%d stdout=%q", code, out)
	}
	got := decodeBodies(t, cap.activitySnapshot())
	if len(got) != 1 {
		t.Fatalf("보고 수=%d: %v", len(got), got)
	}
	b := got[0]
	if b["toolId"] != "tool-sub" || b["agentId"] != "a922" || b["agentType"] != "Explore" ||
		b["state"] != "working" || b["tool"] != "Grep" || b["detail"] != "parse" {
		t.Fatalf("body=%v", b)
	}
}

// 서브에이전트의 PermissionRequest 는 main 보고와 서브에이전트 보고 둘이다 (FR-ASV-5).
func TestDmctlActivity_SubagentPermissionSendsBoth(t *testing.T) {
	cap := startCapture(t, "tool-sub")
	if _, code := runActivityHook(t, `{"hook_event_name":"PermissionRequest","agent_id":"a922","agent_type":"Explore","tool_name":"Bash","tool_input":{"command":"rm x"}}`); code != 0 {
		t.Fatalf("code=%d", code)
	}
	got := decodeBodies(t, cap.activitySnapshot())
	if len(got) != 2 {
		t.Fatalf("보고 수=%d: %v", len(got), got)
	}
	var main, sub map[string]any
	for _, b := range got {
		if _, ok := b["agentId"]; ok {
			sub = b
		} else {
			main = b
		}
	}
	if main == nil || main["state"] != "waiting" || sub == nil || sub["state"] != "waiting" {
		t.Fatalf("main=%v sub=%v", main, sub)
	}
}

// 내부 에이전트 훅과 main 상태를 내지 않는 훅은 활동 보고가 없다 (FR-ASV-3·4).
func TestDmctlActivity_IgnoredHooksSendNoActivity(t *testing.T) {
	cap := startCapture(t, "tool-sub")
	for _, p := range []string{
		`{"hook_event_name":"SubagentStop","agent_id":"a5b4","agent_type":""}`,
		`{"hook_event_name":"Notification","notification_type":"idle_prompt"}`,
		`{"hook_event_name":"SessionStart","source":"compact"}`,
	} {
		if out, code := runActivityHook(t, p); code != 0 || out != "" {
			t.Fatalf("%s: code=%d stdout=%q", p, code, out)
		}
	}
	if got := cap.activitySnapshot(); len(got) != 0 {
		t.Fatalf("보고가 갔다: %v", got)
	}
}

// main 훅은 종전처럼 보고 하나이고 agentId 를 싣지 않는다.
func TestDmctlActivity_MainHookHasNoAgentID(t *testing.T) {
	cap := startCapture(t, "tool-sub")
	runActivityHook(t, `{"hook_event_name":"Stop"}`)
	got := decodeBodies(t, cap.activitySnapshot())
	if len(got) != 1 || got[0]["state"] != "done" {
		t.Fatalf("got=%v", got)
	}
	if _, ok := got[0]["agentId"]; ok {
		t.Fatalf("main 보고에 agentId 가 실렸다: %v", got[0])
	}
}
