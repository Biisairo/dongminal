package runtimebin

import (
	"strings"
	"testing"
)

// FR-AAP-7 / TC-AAP-1: claude PreToolUse Bash → working + command detail.
func TestParseClaudeHook_PreToolUse_Bash(t *testing.T) {
	r, ok := parseClaudeHook([]byte(`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test"}}`))
	if !ok || r.State != "working" || r.Tool != "Bash" || r.Detail != "npm test" {
		t.Fatalf("got %+v ok=%v", r, ok)
	}
}

// TC-AAP-2: claude PreToolUse Edit → file_path detail.
func TestParseClaudeHook_PreToolUse_Edit(t *testing.T) {
	r, ok := parseClaudeHook([]byte(`{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{"file_path":"/x/app.js"}}`))
	if !ok || r.State != "working" || r.Tool != "Edit" || r.Detail != "/x/app.js" {
		t.Fatalf("got %+v ok=%v", r, ok)
	}
}

func TestParseClaudeHook_Grep(t *testing.T) {
	r, ok := parseClaudeHook([]byte(`{"hook_event_name":"PreToolUse","tool_name":"Grep","tool_input":{"pattern":"readPTY"}}`))
	if !ok || r.Tool != "Grep" || r.Detail != "readPTY" {
		t.Fatalf("got %+v ok=%v", r, ok)
	}
}

// TC-AAP-3: Stop → done, Notification → waiting (tool/detail empty).
func TestParseClaudeHook_StopAndNotification(t *testing.T) {
	if r, ok := parseClaudeHook([]byte(`{"hook_event_name":"Stop"}`)); !ok || r.State != "done" || r.Tool != "" || r.Detail != "" {
		t.Fatalf("Stop → done, got %+v ok=%v", r, ok)
	}
	if r, ok := parseClaudeHook([]byte(`{"hook_event_name":"Notification"}`)); !ok || r.State != "waiting" {
		t.Fatalf("Notification → waiting, got %+v ok=%v", r, ok)
	}
}

// FR-AAP-7: full lifecycle coverage — all 9 Claude hooks map to a state.
func TestParseClaudeHook_LifecycleEvents(t *testing.T) {
	cases := map[string]string{
		"SubagentStop": "working",
		"PreCompact":   "working",
		"SessionStart": "idle",
		"SessionEnd":   "ended",
	}
	for ev, want := range cases {
		r, ok := parseClaudeHook([]byte(`{"hook_event_name":"` + ev + `"}`))
		if !ok || r.State != want {
			t.Fatalf("%s → %s, got %+v ok=%v", ev, want, r, ok)
		}
	}
	// PostToolUse carries tool/detail like PreToolUse.
	if r, ok := parseClaudeHook([]byte(`{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}`)); !ok || r.State != "working" || r.Tool != "Bash" || r.Detail != "ls" {
		t.Fatalf("PostToolUse got %+v ok=%v", r, ok)
	}
	// Events carry their key field in detail.
	if r, ok := parseClaudeHook([]byte(`{"hook_event_name":"UserPromptSubmit","prompt":"fix the bug"}`)); !ok || r.State != "working" || r.Detail != "fix the bug" {
		t.Fatalf("UserPromptSubmit got %+v ok=%v", r, ok)
	}
	if r, ok := parseClaudeHook([]byte(`{"hook_event_name":"SessionStart","source":"resume"}`)); !ok || r.State != "idle" || r.Detail != "resume" {
		t.Fatalf("SessionStart got %+v ok=%v", r, ok)
	}
	if r, ok := parseClaudeHook([]byte(`{"hook_event_name":"SessionEnd","reason":"prompt_input_exit"}`)); !ok || r.State != "ended" {
		t.Fatalf("SessionEnd → ended, got %+v ok=%v", r, ok)
	}
}

func TestParseClaudeHook_UnknownEventAndBadJSON(t *testing.T) {
	if _, ok := parseClaudeHook([]byte(`{"hook_event_name":"NoSuchHook"}`)); ok {
		t.Fatalf("unknown event must not report")
	}
	if _, ok := parseClaudeHook([]byte(`not json`)); ok {
		t.Fatalf("bad json must not report")
	}
}

// TC-AAP-4: codex agent-turn-complete → done; other types ignored.
func TestParseCodexHook(t *testing.T) {
	if r, ok := parseCodexHook([]byte(`{"type":"agent-turn-complete","last-assistant-message":"done"}`)); !ok || r.State != "done" {
		t.Fatalf("turn-complete → done, got %+v ok=%v", r, ok)
	}
	if _, ok := parseCodexHook([]byte(`{"type":"other"}`)); ok {
		t.Fatalf("other type must not report")
	}
}

// FR-AAP-9: reportCodexActivity is a no-op for non-codex labels or no pane id
// (must not touch the network in those cases).
func TestReportCodexActivity_Guards(t *testing.T) {
	reportCodexActivity("done", []string{`{"type":"agent-turn-complete"}`}, "")
	reportCodexActivity("claude", []string{`{"type":"agent-turn-complete"}`}, "p1")
}

// NFR-AAP-5 / TC-AAP-10: runDmctlActivity is non-fatal — missing pane id or bad
// JSON must exit 0 (never block the agent's tool call), without POSTing.
func TestRunDmctlActivity_NonFatal(t *testing.T) {
	t.Setenv("DONGMINAL_PANE_ID", "")
	var out, errb strings.Builder
	if code := runDmctlActivity([]string{"claude"}, strings.NewReader(`{"hook_event_name":"Stop"}`), &out, &errb); code != 0 {
		t.Fatalf("missing pane id must be non-fatal, got %d", code)
	}
	if code := runDmctlActivity([]string{"claude"}, strings.NewReader(`garbage`), &out, &errb); code != 0 {
		t.Fatalf("bad json must be non-fatal, got %d", code)
	}
	if code := runDmctlActivity(nil, strings.NewReader(``), &out, &errb); code != 0 {
		t.Fatalf("no agent arg must be non-fatal, got %d", code)
	}
}
