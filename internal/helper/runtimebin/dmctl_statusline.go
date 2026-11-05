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
	"dongminal/internal/shared/statusline"
)

// ISSUE_AGENT_TREE_SRS 묶음 S — statusLine 프록시 (FR-SLP-1~8).
//
// Claude Code 는 statusLine 명령을 실행하며 stdin JSON 으로 공식 사용량
// (`context_window.used_percentage` 등)을 넘긴다. 이 명령은 그 자리에 서서 값을 서버에
// 남기고, 같은 입력을 원래 등록된 statusLine 명령(하위 명령)에 그대로 넘긴다. 하위
// 명령이 무엇이든 그 코드와 설정은 고치지 않는다.

// slReportBudget 은 서버 보고의 시한이다 (NFR-SLP-1). 넘기면 버리고 표시로 간다.
const slReportBudget = 100 * time.Millisecond

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
	type slSettings struct {
		DisableAllHooks bool `json:"disableAllHooks"`
		StatusLine      *struct {
			Type    string `json:"type"`
			Command string `json:"command"`
		} `json:"statusLine"`
	}
	parsed := make([]slSettings, 0, len(files))
	for _, f := range files {
		blob, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var s slSettings
		if json.Unmarshal(blob, &s) != nil {
			continue
		}
		// 어느 설정이든 훅을 모두 끄라고 했으면 Claude Code 가 실행하지 않았을 명령이다.
		if s.DisableAllHooks {
			return ""
		}
		parsed = append(parsed, s)
	}
	for _, s := range parsed {
		if s.StatusLine == nil {
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

// statuslineProjectDir 는 프로젝트 설정을 찾는 기준이다. Claude Code 가 말한
// `workspace.project_dir` 만 쓴다 — 세션의 `cwd` 는 프로젝트가 아닐 수 있다. 없으면
// 이 프로세스의 작업 폴더다(Claude Code 가 statusLine 을 프로젝트 폴더에서 실행한다, TC-SLP-5).
func statuslineProjectDir(raw []byte) string {
	var in struct {
		Workspace struct {
			ProjectDir string `json:"project_dir"`
		} `json:"workspace"`
	}
	if json.Unmarshal(raw, &in) == nil && in.Workspace.ProjectDir != "" {
		return in.Workspace.ProjectDir
	}
	wd, _ := os.Getwd()
	return wd
}

// runStatusline 은 `dmctl statusline` 이다. env 는 설정 파일을 찾고 보고 대상을 정하는
// 데만 쓴다 — 하위 명령은 이 프로세스의 환경을 그대로 물려받는다.
func runStatusline(stdin io.Reader, stdout, stderr io.Writer, env map[string]string) int {
	raw, _ := io.ReadAll(stdin)
	if tool := env["DONGMINAL_TOOL_ID"]; tool != "" {
		if u := statusline.FromInput(raw); u != nil {
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
