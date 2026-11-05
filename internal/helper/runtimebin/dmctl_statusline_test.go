package runtimebin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ISSUE_AGENT_TREE_SRS 묶음 S — statusLine 프록시 (TC-SLP-1 · 2 · 3 · 7).

// 2026-11-05 실측 입력(Claude Code 2.1.318)에 사용률·한도를 채우고 모르는 필드를 더한 표본.
const slSample = `{"session_id":"c009","transcript_path":"/Users/x/.claude/projects/p/c009.jsonl","cwd":"PROJ",
"effort":{"level":"medium"},"model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},
"workspace":{"current_dir":"PROJ","project_dir":"PROJ","added_dirs":[]},"version":"2.1.318",
"output_style":{"name":"default"},
"cost":{"total_cost_usd":0.5,"total_duration_ms":1019,"total_api_duration_ms":10,"total_lines_added":3,"total_lines_removed":1},
"context_window":{"total_input_tokens":100,"total_output_tokens":20,"context_window_size":1000000,
"current_usage":{"input_tokens":6,"output_tokens":8,"cache_creation_input_tokens":62146,"cache_read_input_tokens":0},
"used_percentage":6,"remaining_percentage":94},
"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":1793860000},"seven_day":{"used_percentage":40,"resets_at":null}},
"exceeds_200k_tokens":false,"fast_mode":false,"thinking":{"enabled":true},"secret_new_field":"leak?"}`

func TestStatuslineUsage_Allowlist(t *testing.T) {
	u := statuslineUsage([]byte(slSample))
	blob, _ := json.Marshal(u)
	s := string(blob)
	for _, banned := range []string{"transcript", "/Users/x", "PROJ", "workspace", "secret_new_field", "leak?"} {
		if strings.Contains(s, banned) {
			t.Errorf("허용 목록 밖의 값 %q 이 나갔다: %s", banned, s)
		}
	}
	cw, _ := u["contextWindow"].(map[string]any)
	if cw["usedPct"] != float64(6) || cw["windowTokens"] != float64(1000000) {
		t.Errorf("contextWindow=%v", cw)
	}
	cu, _ := cw["currentUsage"].(map[string]any)
	if cu["cacheCreationInputTokens"] != float64(62146) {
		t.Errorf("currentUsage=%v", cu)
	}
	rl, _ := u["rateLimits"].(map[string]any)
	fh, _ := rl["fiveHour"].(map[string]any)
	sd, _ := rl["sevenDay"].(map[string]any)
	if fh["usedPct"] != 12.5 || fh["resetsAt"] != float64(1793860000) {
		t.Errorf("fiveHour=%v", fh)
	}
	if _, ok := sd["resetsAt"]; ok {
		t.Errorf("null 은 싣지 않는다: %v", sd)
	}
	cost, _ := u["cost"].(map[string]any)
	if cost["totalCostUsd"] != 0.5 || u["sessionId"] != "c009" || u["version"] != "2.1.318" {
		t.Errorf("u=%s", s)
	}
	m, _ := u["model"].(map[string]any)
	if m["id"] != "claude-opus-5-5" || u["effort"] != "medium" || u["thinking"] != true {
		t.Errorf("u=%s", s)
	}
}

func TestStatuslineUsage_NullPercentNotReported(t *testing.T) {
	raw := `{"session_id":"s","context_window":{"context_window_size":1000000,"current_usage":null,"used_percentage":null}}`
	u := statuslineUsage([]byte(raw))
	cw, _ := u["contextWindow"].(map[string]any)
	if _, ok := cw["usedPct"]; ok {
		t.Errorf("null 사용률이 실렸다: %v", cw)
	}
	if _, ok := cw["currentUsage"]; ok {
		t.Errorf("null current_usage 가 실렸다: %v", cw)
	}
}

// 하위 명령 찾기: 프로젝트 local → 프로젝트 → 사용자. dongminal 자신은 건너뛴다.
func TestStatuslineDownstream_Precedence(t *testing.T) {
	home := t.TempDir()
	proj := t.TempDir()
	write := func(p, cmd string) {
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(`{"statusLine":{"type":"command","command":`+strconvQuote(cmd)+`}}`), 0o644)
	}
	user := filepath.Join(home, ".claude", "settings.json")
	write(user, "user-cmd")
	env := map[string]string{"HOME": home}
	if got := statuslineDownstream(proj, env); got != "user-cmd" {
		t.Fatalf("user: %q", got)
	}
	write(filepath.Join(proj, ".claude", "settings.json"), "proj-cmd")
	if got := statuslineDownstream(proj, env); got != "proj-cmd" {
		t.Fatalf("proj: %q", got)
	}
	write(filepath.Join(proj, ".claude", "settings.local.json"), "local-cmd")
	if got := statuslineDownstream(proj, env); got != "local-cmd" {
		t.Fatalf("local: %q", got)
	}
	// CLAUDE_CONFIG_DIR 가 있으면 사용자 설정은 그 아래다.
	cfg := t.TempDir()
	write(filepath.Join(cfg, "settings.json"), "cfg-cmd")
	if got := statuslineDownstream(t.TempDir(), map[string]string{"HOME": home, "CLAUDE_CONFIG_DIR": cfg}); got != "cfg-cmd" {
		t.Fatalf("config dir: %q", got)
	}
	// 자기 자신을 가리키면 재귀다 — 건너뛰고 다음으로 간다.
	write(filepath.Join(proj, ".claude", "settings.local.json"), "dmctl statusline")
	if got := statuslineDownstream(proj, env); got != "proj-cmd" {
		t.Fatalf("self skip: %q", got)
	}
}

func strconvQuote(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestStatuslineProxy_NoDownstreamEmpty(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) })
	defer cleanup()
	var stdout, stderr bytes.Buffer
	rc := runStatusline(strings.NewReader(`{}`), &stdout, &stderr, map[string]string{"HOME": t.TempDir()})
	if rc != 0 || stdout.Len() != 0 {
		t.Fatalf("rc=%d stdout=%q", rc, stdout.String())
	}
}
