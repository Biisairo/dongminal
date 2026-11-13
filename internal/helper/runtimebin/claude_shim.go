package runtimebin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"dongminal/internal/shared/dmenv"
)

// CLAUDE_ACCOUNTS_SRS FR-CAC-83 — claude shim. 셸 훅이 `agent-shims` 를 PATH 맨 앞에 두므로 탭에서
// `claude` 를 치면 이것이 먼저 돈다. 훅 인자와 계정 프로필을 넣고 진짜 claude 를 실행한다.

const claudeConfigDirEnv = "CLAUDE_CONFIG_DIR"

// shimBudget 은 실행 준비 API 의 예산이다. 변수인 것은 시험이 시간 초과를 재기 위해서다.
var shimBudget = 3 * time.Second

// shimExec 는 진짜 claude 를 실행하고 종료 코드를 돌려준다. POSIX 는 돌아오지 않는다.
var shimExec = execShim

// runAgentShim 은 cmd 이름으로 선 shim 이다. 계정 지정(CLAUDE_CONFIG_DIR)은 Claude Code 의 규약이다 —
// shim 을 선언한 에이전트는 claude 하나다.
func runAgentShim(cmd string, args []string, _, stderr io.Writer) int {
	home := os.Getenv(dmenv.EnvHome)
	real := findRealCommand(cmd, os.Getenv("PATH"), shimDirOf(home))
	if real == "" {
		fmt.Fprintf(stderr, "%s 를 찾을 수 없습니다\n", cmd)
		return 127
	}
	argv := append([]string{real}, shimHookArgs(cmd, home)...)
	argv = append(argv, args...)
	env := os.Environ()
	if os.Getenv(claudeConfigDirEnv) == "" {
		dir, reason := claudeLaunchDir()
		if reason != "" {
			fmt.Fprintf(stderr, "dongminal: Claude 계정 지정을 적용하지 못했습니다 (%s)\n", reason)
			return 1
		}
		if dir != "" {
			env = append(env, claudeConfigDirEnv+"="+dir)
		}
	}
	return shimExec(real, argv, env)
}

func shimDirOf(home string) string {
	if home == "" {
		return ""
	}
	return dmenv.AgentShimsDirIn(filepath.Join(home, "bin"))
}

// shimHookArgs 는 기존 셸 래퍼와 같은 규칙으로, 있을 때만 붙이는 훅 인자다.
func shimHookArgs(cmd, home string) []string {
	if home == "" {
		return nil
	}
	bin := filepath.Join(home, "bin")
	settings := filepath.Join(dmenv.AgentHooksDirIn(bin), cmd+".json")
	var out []string
	if st, err := os.Stat(settings); err == nil && st.Mode().IsRegular() {
		out = append(out, "--settings", settings)
	}
	if st, err := os.Stat(filepath.Join(bin, "agent-plugin")); err == nil && st.IsDir() {
		out = append(out, "--plugin-dir", filepath.Join(bin, "agent-plugin"))
	}
	return out
}

// claudeLaunchDir 는 서버에 이 실행의 계정을 묻는다. 서버가 꺼져 있으면(연결 거부) 기본 계정이다.
// reason 이 비지 않으면 실행하지 않는다 (D-CAC-25).
func claudeLaunchDir() (dir, reason string) {
	body := map[string]any{}
	if id := selfToolID(); id != "" {
		body["toolId"] = id
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", "현재 폴더를 알 수 없음"
	}
	body["cwd"] = cwd
	status, b, err := httpJSONWithin(http.MethodPost, baseURL()+"/api/claude-accounts/launch", body, shimBudget)
	if err != nil {
		if connRefused(err) {
			return "", ""
		}
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return "", "서버가 제때 답하지 않음"
		}
		return "", "서버에 연결하지 못함"
	}
	if status != http.StatusOK {
		var e struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(b, &e)
		return "", strings.TrimSpace(fmt.Sprintf("HTTP %d %s", status, e.Code))
	}
	var res struct {
		ConfigDir string `json:"configDir"`
	}
	if err := json.Unmarshal(b, &res); err != nil {
		return "", "서버 응답을 읽을 수 없음"
	}
	return res.ConfigDir, ""
}

// findRealCommand 는 PATH 에서 shim 폴더와, shim 자신과 같은 파일을 빼고 진짜 명령을 찾는다.
func findRealCommand(cmd, pathEnv, shimDir string) string {
	var self os.FileInfo
	if exe, err := os.Executable(); err == nil {
		self, _ = os.Stat(exe)
	}
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" || samePathDir(dir, shimDir) {
			continue
		}
		for _, c := range commandCandidates(dir, cmd) {
			st, err := os.Stat(c)
			if err != nil || !st.Mode().IsRegular() || !isExecutable(st) {
				continue
			}
			if self != nil && os.SameFile(self, st) {
				continue
			}
			return c
		}
	}
	return ""
}

func samePathDir(a, b string) bool {
	if b == "" {
		return false
	}
	a, b = filepath.Clean(a), filepath.Clean(b)
	if pathFoldCase {
		return strings.EqualFold(a, b)
	}
	return a == b
}
