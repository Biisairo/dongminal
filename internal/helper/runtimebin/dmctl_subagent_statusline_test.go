package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// SUBAGENT_USAGE_SRS — subagentStatusLine 프록시 (TC-SAU-3 · 4).

const sslSample = `{"session_id":"9cfd","transcript_path":"/Users/x/t.jsonl","cwd":"PROJ","columns":80,
"tasks":[{"id":"a3b7","agentType":"Explore","status":"running","label":"secret","model":"claude-haiku-5-5",
"contextWindowSize":1000000,"tokenCount":19250,"startTime":1794204238088}]}`

// TC-SAU-3: 도구 id 가 있으면 허용 목록만 /api/tools/subagents 로 보낸다 (FR-SAU-6).
func TestSubagentStatusline_Reports(t *testing.T) {
	var path string
	var body map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		blob, _ := io.ReadAll(r.Body)
		json.Unmarshal(blob, &body)
		w.Write([]byte(`{"ok":true}`))
	})
	defer cleanup()
	var stdout, stderr bytes.Buffer
	rc := runSubagentStatusline(strings.NewReader(sslSample), &stdout, &stderr,
		map[string]string{"HOME": t.TempDir(), "DONGMINAL_TOOL_ID": "p1"})
	if rc != 0 || stdout.Len() != 0 {
		t.Fatalf("rc=%d stdout=%q (하위 명령이 없으면 출력이 없다, FR-SAU-8)", rc, stdout.String())
	}
	if path != "/api/tools/subagents" || body["toolId"] != "p1" {
		t.Fatalf("path=%q body=%v", path, body)
	}
	tasks, _ := body["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("tasks=%v", body["tasks"])
	}
	blob, _ := json.Marshal(body)
	if strings.Contains(string(blob), "secret") || strings.Contains(string(blob), "/Users/x") {
		t.Errorf("허용 목록 밖의 값이 나갔다: %s", blob)
	}
}

// FR-SAU-6: 빈 tasks 도 보고한다 — 목록을 비우는 신호다.
func TestSubagentStatusline_ReportsEmpty(t *testing.T) {
	var body map[string]any
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		blob, _ := io.ReadAll(r.Body)
		json.Unmarshal(blob, &body)
	})
	defer cleanup()
	var stdout, stderr bytes.Buffer
	runSubagentStatusline(strings.NewReader(`{"tasks":[]}`), &stdout, &stderr,
		map[string]string{"HOME": t.TempDir(), "DONGMINAL_TOOL_ID": "p1"})
	tasks, ok := body["tasks"].([]any)
	if !ok || len(tasks) != 0 {
		t.Fatalf("빈 목록 보고: %v", body)
	}
}

// FR-SAU-6: 도구 id 가 없거나 tasks 가 없으면 보내지 않는다.
func TestSubagentStatusline_NoReport(t *testing.T) {
	calls := 0
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { calls++ })
	defer cleanup()
	var stdout, stderr bytes.Buffer
	runSubagentStatusline(strings.NewReader(sslSample), &stdout, &stderr, map[string]string{"HOME": t.TempDir()})
	runSubagentStatusline(strings.NewReader(`{"session_id":"x"}`), &stdout, &stderr,
		map[string]string{"HOME": t.TempDir(), "DONGMINAL_TOOL_ID": "p1"})
	if calls != 0 {
		t.Fatalf("보고 수=%d", calls)
	}
}

// TC-SAU-4: 하위 명령은 subagentStatusLine 키로 찾는다. statusLine 키는 보지 않고, 자기는 건너뛴다 (FR-SAU-7).
func TestSubagentStatuslineDownstream(t *testing.T) {
	home := t.TempDir()
	proj := t.TempDir()
	user := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(user), 0o755)
	os.WriteFile(user, []byte(`{"statusLine":{"type":"command","command":"main-cmd"},
"subagentStatusLine":{"type":"command","command":"sub-cmd"}}`), 0o644)
	env := map[string]string{"HOME": home}
	if got := statuslineDownstream(proj, env, subagentStatusLineKey); got != "sub-cmd" {
		t.Fatalf("sub: %q", got)
	}
	if got := statuslineDownstream(proj, env, statusLineKey); got != "main-cmd" {
		t.Fatalf("main 은 그대로: %q", got)
	}
	local := filepath.Join(proj, ".claude", "settings.local.json")
	os.MkdirAll(filepath.Dir(local), 0o755)
	os.WriteFile(local, []byte(`{"subagentStatusLine":{"type":"command","command":"\"/x/dmctl\" subagent-statusline"}}`), 0o644)
	if got := statuslineDownstream(proj, env, subagentStatusLineKey); got != "sub-cmd" {
		t.Fatalf("self skip: %q", got)
	}
	os.WriteFile(local, []byte(`{"disableAllHooks":true}`), 0o644)
	if got := statuslineDownstream(proj, env, subagentStatusLineKey); got != "" {
		t.Fatalf("disableAllHooks: %q", got)
	}
}
