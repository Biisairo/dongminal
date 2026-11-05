package runtimebin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"dongminal/internal/shared/platform"
)

// ISSUE_AGENT_TREE_SRS 묶음 S — statusLine 프록시 (FR-SLP-1~8).
//
// Claude Code 는 statusLine 명령을 실행하며 stdin JSON 으로 공식 사용량
// (`context_window.used_percentage` 등)을 넘긴다. 이 명령은 그 자리에 서서 값을 서버에
// 남기고, 같은 입력을 원래 등록된 statusLine 명령(하위 명령)에 그대로 넘긴다. 하위
// 명령이 무엇이든 그 코드와 설정은 고치지 않는다.

// slReportBudget 은 서버 보고의 시한이다 (NFR-SLP-1). 넘기면 버리고 표시로 간다.
const slReportBudget = 100 * time.Millisecond

// slField 는 허용 목록 한 줄이다: 입력의 경로 → 내보낼 경로 (FR-SLP-2·2a).
type slField struct{ src, dst string }

var slFields = []slField{
	{"session_id", "sessionId"},
	{"version", "version"},
	{"model.id", "model.id"},
	{"model.display_name", "model.displayName"},
	{"effort.level", "effort"},
	{"thinking.enabled", "thinking"},
	{"fast_mode", "fastMode"},
	{"output_style.name", "outputStyle"},
	{"exceeds_200k_tokens", "exceeds200k"},
	{"cost.total_cost_usd", "cost.totalCostUsd"},
	{"cost.total_duration_ms", "cost.totalDurationMs"},
	{"cost.total_api_duration_ms", "cost.totalApiDurationMs"},
	{"cost.total_lines_added", "cost.totalLinesAdded"},
	{"cost.total_lines_removed", "cost.totalLinesRemoved"},
	{"context_window.total_input_tokens", "contextWindow.totalInputTokens"},
	{"context_window.total_output_tokens", "contextWindow.totalOutputTokens"},
	{"context_window.context_window_size", "contextWindow.windowTokens"},
	{"context_window.used_percentage", "contextWindow.usedPct"},
	{"context_window.remaining_percentage", "contextWindow.remainingPct"},
	{"context_window.current_usage.input_tokens", "contextWindow.currentUsage.inputTokens"},
	{"context_window.current_usage.output_tokens", "contextWindow.currentUsage.outputTokens"},
	{"context_window.current_usage.cache_creation_input_tokens", "contextWindow.currentUsage.cacheCreationInputTokens"},
	{"context_window.current_usage.cache_read_input_tokens", "contextWindow.currentUsage.cacheReadInputTokens"},
}

// 한도 창의 이름은 판마다 늘 수 있다(`five_hour`·`seven_day`…). 이름 모양만 거르고 값은 둘만 싣는다.
var slRateName = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

var slRateFields = []slField{{"used_percentage", "usedPct"}, {"resets_at", "resetsAt"}}

// statuslineUsage 는 입력에서 허용 목록의 값만 꺼낸다. 값이 null·객체·배열이면 싣지 않는다.
func statuslineUsage(raw []byte) map[string]any {
	var in map[string]any
	if json.Unmarshal(raw, &in) != nil {
		return nil
	}
	out := map[string]any{}
	for _, f := range slFields {
		if v, ok := slScalar(in, f.src); ok {
			slSet(out, f.dst, v)
		}
	}
	if rl, ok := in["rate_limits"].(map[string]any); ok {
		for name, w := range rl {
			wm, ok := w.(map[string]any)
			if !ok || !slRateName.MatchString(name) {
				continue
			}
			for _, f := range slRateFields {
				if v, ok := slScalar(wm, f.src); ok {
					slSet(out, "rateLimits."+slCamel(name)+"."+f.dst, v)
				}
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func slScalar(m map[string]any, path string) (any, bool) {
	var cur any = m
	for _, k := range strings.Split(path, ".") {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		cur = mm[k]
	}
	switch cur.(type) {
	case float64, bool, string:
		return cur, true
	}
	return nil, false
}

func slSet(m map[string]any, path string, v any) {
	keys := strings.Split(path, ".")
	for _, k := range keys[:len(keys)-1] {
		next, ok := m[k].(map[string]any)
		if !ok {
			next = map[string]any{}
			m[k] = next
		}
		m = next
	}
	m[keys[len(keys)-1]] = v
}

func slCamel(s string) string {
	parts := strings.Split(s, "_")
	for i := 1; i < len(parts); i++ {
		if parts[i] != "" {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}

// slSelf 는 dongminal 자신의 statusLine 명령이다 — 하위 명령으로 고르면 재귀다.
var slSelf = regexp.MustCompile(`dmctl["']?\s+statusline\b`)

// statuslineDownstream 은 dongminal 이 없을 때 Claude Code 가 실행했을 statusLine 명령이다
// (FR-SLP-4). 우선순위: 프로젝트 local → 프로젝트 → 사용자.
func statuslineDownstream(projectDir string, env map[string]string) string {
	userDir := env["CLAUDE_CONFIG_DIR"]
	if userDir == "" {
		userDir = filepath.Join(env["HOME"], ".claude")
	}
	var files []string
	if projectDir != "" {
		files = append(files,
			filepath.Join(projectDir, ".claude", "settings.local.json"),
			filepath.Join(projectDir, ".claude", "settings.json"))
	}
	files = append(files, filepath.Join(userDir, "settings.json"))
	for _, f := range files {
		blob, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var s struct {
			StatusLine *struct {
				Type    string `json:"type"`
				Command string `json:"command"`
			} `json:"statusLine"`
		}
		if json.Unmarshal(blob, &s) != nil || s.StatusLine == nil {
			continue
		}
		cmd := strings.TrimSpace(s.StatusLine.Command)
		if s.StatusLine.Type != "command" || cmd == "" || slSelf.MatchString(cmd) {
			continue
		}
		return cmd
	}
	return ""
}

func statuslineProjectDir(raw []byte) string {
	var in struct {
		Cwd       string `json:"cwd"`
		Workspace struct {
			ProjectDir string `json:"project_dir"`
		} `json:"workspace"`
	}
	if json.Unmarshal(raw, &in) == nil {
		if in.Workspace.ProjectDir != "" {
			return in.Workspace.ProjectDir
		}
		if in.Cwd != "" {
			return in.Cwd
		}
	}
	wd, _ := os.Getwd()
	return wd
}

// runStatusline 은 `dmctl statusline` 이다. env 는 설정 파일을 찾고 보고 대상을 정하는
// 데만 쓴다 — 하위 명령은 이 프로세스의 환경을 그대로 물려받는다.
func runStatusline(stdin io.Reader, stdout, stderr io.Writer, env map[string]string) int {
	raw, _ := io.ReadAll(stdin)
	if tool := env["DONGMINAL_TOOL_ID"]; tool != "" {
		if u := statuslineUsage(raw); u != nil {
			_, _, _ = httpPostJSONWithin(baseURL()+"/api/tools/usage", map[string]any{"toolId": tool, "usage": u}, slReportBudget)
		}
	}
	cmd := statuslineDownstream(statuslineProjectDir(raw), env)
	if cmd == "" {
		return 0
	}
	c := slShell(cmd)
	c.Stdin = bytes.NewReader(raw)
	c.Stdout = stdout
	c.Stderr = stderr
	err := c.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	if err != nil {
		return 1
	}
	return 0
}

// slShell 은 그 명령을 이 호스트의 셸 문법으로 실행한다 (FR-SLP-8, TC-SLP-6).
// 셸 고르기는 platform 이 진다 — 도구 실행(`toolhub`)과 같은 규칙이다.
func slShell(cmd string) *exec.Cmd {
	argv := platform.Current().Shell.RunCommand(cmd)
	return exec.Command(argv[0], argv[1:]...)
}

func runDmctlStatusline(stdin io.Reader, stdout, stderr io.Writer) int {
	env := map[string]string{}
	for _, k := range []string{"HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "DONGMINAL_TOOL_ID"} {
		env[k] = os.Getenv(k)
	}
	if env["HOME"] == "" {
		env["HOME"] = env["USERPROFILE"]
	}
	return runStatusline(stdin, stdout, stderr, env)
}
