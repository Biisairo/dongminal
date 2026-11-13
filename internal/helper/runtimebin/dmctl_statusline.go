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

	"dongminal/internal/shared/agentrec"
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

// slSelf 는 dongminal 자신의 statusLine·subagentStatusLine 명령이다 — 하위 명령으로 고르면 재귀다.
var slSelf = regexp.MustCompile(`dmctl["']?\s+(subagent-)?statusline\b`)

// 하위 명령을 찾는 설정 키다 (SUBAGENT_USAGE_SRS D-SAU-5).
const (
	statusLineKey         = "statusLine"
	subagentStatusLineKey = "subagentStatusLine"
)

// statuslineDownstream 은 dongminal 이 없을 때 Claude Code 가 실행했을 key 의 명령이다
// (FR-SLP-4 · FR-SAU-7). 우선순위: 프로젝트 local → 프로젝트 → 사용자.
func statuslineDownstream(projectDir string, env map[string]string, key string) string {
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
	type slCommand struct {
		Type    string `json:"type"`
		Command string `json:"command"`
	}
	cmds := make([]slCommand, 0, len(files))
	for _, f := range files {
		blob, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var s map[string]json.RawMessage
		if json.Unmarshal(blob, &s) != nil {
			continue
		}
		// 어느 설정이든 훅을 모두 끄라고 했으면 Claude Code 가 실행하지 않았을 명령이다.
		var off bool
		if json.Unmarshal(s["disableAllHooks"], &off) == nil && off {
			return ""
		}
		var c slCommand
		if raw, ok := s[key]; ok && json.Unmarshal(raw, &c) == nil {
			cmds = append(cmds, c)
		}
	}
	for _, c := range cmds {
		cmd := strings.TrimSpace(c.Command)
		if c.Type != "command" || cmd == "" || slSelf.MatchString(cmd) {
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
			body := map[string]any{"toolId": tool, "usage": u}
			if acc := statuslineAccount(env); acc != nil {
				body["account"] = acc
			}
			_, _, _ = postReport(agentrec.MethodUsage, "/api/tools/usage", body, slReportBudget)
		}
	}
	return slPassThrough(raw, statuslineDownstream(statuslineProjectDir(raw), env, statusLineKey), stdout, stderr)
}

// runSubagentStatusline 은 `dmctl subagent-statusline` 이다 (SUBAGENT_USAGE_SRS FR-SAU-6~8).
// 하위 명령이 없으면 아무것도 출력하지 않는다 — Claude Code 는 줄이 없는 행을 기본 모양으로 그린다.
func runSubagentStatusline(stdin io.Reader, stdout, stderr io.Writer, env map[string]string) int {
	raw, _ := io.ReadAll(stdin)
	if tool := env["DONGMINAL_TOOL_ID"]; tool != "" {
		if tasks, ok := statusline.SubagentsFromInput(raw); ok {
			_, _, _ = postReport(agentrec.MethodSubagents, "/api/tools/subagents", map[string]any{"toolId": tool, "tasks": tasks}, slReportBudget)
		}
	}
	return slPassThrough(raw, statuslineDownstream(statuslineProjectDir(raw), env, subagentStatusLineKey), stdout, stderr)
}

// slPassThrough 는 하위 명령에 받은 입력을 그대로 넘기고 그 종료 코드를 돌려준다. 명령이 없으면 0 이다.
func slPassThrough(raw []byte, cmd string, stdout, stderr io.Writer) int {
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
	return runStatusline(stdin, stdout, stderr, statuslineEnv())
}

func runDmctlSubagentStatusline(stdin io.Reader, stdout, stderr io.Writer) int {
	return runSubagentStatusline(stdin, stdout, stderr, statuslineEnv())
}

// statuslineEnv 는 두 프록시가 설정을 찾고 보고 대상을 정하는 데 쓰는 환경 값이다.
func statuslineEnv() map[string]string {
	env := map[string]string{}
	for _, k := range []string{"HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "DONGMINAL_TOOL_ID"} {
		env[k] = os.Getenv(k)
	}
	if env["HOME"] == "" {
		env["HOME"] = env["USERPROFILE"]
	}
	return env
}

// statuslineAccount 는 그 세션의 설정 폴더(`CLAUDE_CONFIG_DIR`, 없으면 홈)의 `.claude.json` 에서
// 로그인한 계정을 읽는다 (CLAUDE_ACCOUNTS_SRS FR-CAC-78). 읽지 못하면 nil 이다.
func statuslineAccount(env map[string]string) *agentrec.ReportAccount {
	dir := env["CLAUDE_CONFIG_DIR"]
	if dir == "" {
		dir = env["HOME"]
	}
	if dir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(dir, ".claude.json"))
	if err != nil {
		return nil
	}
	var v struct {
		OAuthAccount struct {
			Email string `json:"emailAddress"`
			Org   string `json:"organizationUuid"`
		} `json:"oauthAccount"`
	}
	if json.Unmarshal(b, &v) != nil || v.OAuthAccount.Email == "" {
		return nil
	}
	return &agentrec.ReportAccount{Email: v.OAuthAccount.Email, OrgUUID: v.OAuthAccount.Org}
}
