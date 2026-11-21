package runtimebin

import (
	"fmt"
	"io"
	"time"

	"dongminal/internal/shared/runwait"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `dmctl_run.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **서버와의 왕복**이다 — 경로·예산·응답 판정·거절 문안. 위쪽의
// 서브커맨드들은 이 함수들만 부르며, HTTP 의 사정을 알지 않는다.

// succeedBudget 은 `--timeout-ms`(0 이면 서버 기본)에 여유를 더한 값이다.
func succeedBudget(timeoutMs int) time.Duration {
	wait := runwait.HandoffWaitDefault
	if timeoutMs > 0 {
		wait = time.Duration(timeoutMs) * time.Millisecond
	}
	return wait + clientSlack
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
	raw, code, _ := httpExit(status, raw, err, stderr, runRule(path))
	return raw, code
}

// runRule 은 runs 의 `{error,detail,…}` 방언 종단이다.
func runRule(path string) exitRule {
	return exitRule{prefix: "dmctl", refuse: refuseWith(func(w io.Writer, st int, b []byte) { printRunRefusal(w, st, path, b) })}
}

// printRunRefusal renders the enumerated reason plus any list the server
// attached (close 의 미보고 멤버 등) — 거부를 뭉뚱그리지 않는다.
func printRunRefusal(stderr io.Writer, status int, path string, raw []byte) {
	var body struct {
		Error      string
		Detail     string
		Unreported []runMember
		// ISSUE_AGENT_TREE_SRS FR-ITU-5: tree_open 의 그 Run 과 멈춤 여부.
		RunID string
		Stale *bool
		// ISSUE_TREE_OPS_SRS FR-ITB-4: node_taken 의 그 이슈를 쥔 멤버.
		MemberID string
		State    string
		Hint     string
	}
	r, ok := parseRefusal(raw)
	ok = ok && takeField(r.Error, &body.Error) && takeField(r.Detail, &body.Detail) &&
		takeField(r.Unreported, &body.Unreported) && takeField(r.RunID, &body.RunID) &&
		takeField(r.Stale, &body.Stale) && takeField(r.MemberID, &body.MemberID) &&
		takeField(r.State, &body.State) && takeField(r.Hint, &body.Hint)
	if !ok || body.Error == "" {
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
	if body.MemberID != "" {
		fmt.Fprintf(stderr, "  이 이슈를 쥔 멤버: memberId=%s  state=%s\n", body.MemberID, body.State)
	}
	if body.Hint != "" {
		fmt.Fprintf(stderr, "  %s\n", body.Hint)
	}
	if body.Stale != nil && body.RunID != "" {
		if *body.Stale {
			fmt.Fprintf(stderr, "  이 트리의 Run %s 은 멈췄다(살아 있는 멤버 없음). 정리한 뒤 다시 연다: dmctl run close --run %s --force\n", body.RunID, body.RunID)
		} else {
			fmt.Fprintf(stderr, "  이 트리는 이미 돌고 있다: Run %s (dmctl run tree 로 본다)\n", body.RunID)
		}
	}
}
