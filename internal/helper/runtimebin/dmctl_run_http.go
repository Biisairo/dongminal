package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"time"

	"dongminal/internal/shared/runwait"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `dmctl_run.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **서버와의 왕복**이다 — 경로·예산·응답 판정·거절 문안. 위쪽의
// 서브커맨드들은 이 함수들만 부르며, HTTP 의 사정을 알지 않는다.

const (
	runClientSlack  = 10 * time.Second
	preambleBudget  = runwait.PreambleWait + runClientSlack
	closeClientRoom = 40 * time.Second // /exit 대기 뒤의 헤드리스 종료 유예·worktree 정리
	closeBudget     = runwait.ExitSettle + closeClientRoom
)

// succeedBudget 은 `--timeout-ms`(0 이면 서버 기본)에 여유를 더한 값이다.
func succeedBudget(timeoutMs int) time.Duration {
	wait := runwait.HandoffWaitDefault
	if timeoutMs > 0 {
		wait = time.Duration(timeoutMs) * time.Millisecond
	}
	return wait + runClientSlack
}

// runPost/runGet share the error rendering: an enumerated refusal reason is
// surfaced as-is so the caller can act on it (FR-PRE-6).
func runPost(path string, body map[string]any, stderr io.Writer) ([]byte, int) {
	return runPostWithin(path, body, 0, stderr)
}

func runGet(path string, stderr io.Writer) ([]byte, int) {
	return runGetWithin(path, 0, stderr)
}

func runPostWithin(path string, body map[string]any, budget time.Duration, stderr io.Writer) ([]byte, int) {
	status, raw, err := httpPostJSONWithin(baseURL()+path, body, budget)
	return runResult(path, status, raw, err, stderr)
}

func runGetWithin(path string, budget time.Duration, stderr io.Writer) ([]byte, int) {
	status, raw, err := httpGetWithin(baseURL()+path, budget)
	return runResult(path, status, raw, err, stderr)
}

func runDelete(path string, stderr io.Writer) ([]byte, int) {
	status, raw, err := httpDelete(baseURL() + path)
	return runResult(path, status, raw, err, stderr)
}

func runResult(path string, status int, raw []byte, err error, stderr io.Writer) ([]byte, int) {
	if err != nil {
		fmt.Fprintf(stderr, "dmctl: %v\n", err)
		return nil, 1
	}
	if status < 200 || status >= 300 {
		printRunRefusal(stderr, status, path, raw)
		return nil, 1
	}
	return raw, 0
}

// printRunRefusal renders the enumerated reason plus any list the server
// attached (close 의 미보고 멤버 등) — 거부를 뭉뚱그리지 않는다.
func printRunRefusal(stderr io.Writer, status int, path string, raw []byte) {
	var body struct {
		Error      string      `json:"error"`
		Detail     string      `json:"detail"`
		Unreported []runMember `json:"unreported"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.Error == "" {
		printAPIError(stderr, status, path, raw)
		return
	}
	fmt.Fprintf(stderr, "dmctl run: %s (%d)\n", body.Error, status)
	if body.Detail != "" && body.Detail != body.Error {
		fmt.Fprintf(stderr, "  %s\n", body.Detail)
	}
	for _, m := range body.Unreported {
		fmt.Fprintf(stderr, "  미보고: role=%s  state=%s  memberId=%s\n", m.Role, m.State, m.ID)
	}
}
