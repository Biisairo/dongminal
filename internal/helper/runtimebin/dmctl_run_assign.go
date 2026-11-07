package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// ISSUE_TREE_OPS_SRS 묶음 A — 트리 노드의 배정 (FR-ITA-1·4).

// assignOf 는 run member 의 배정 플래그를 본문으로 만든다. --issue 가 없으면 배정이
// 없다 — 배정 플래그만 주면 거절한다(어느 이슈의 배정인지 모른다).
func assignOf(f runFlags, stderr io.Writer) (map[string]any, bool) {
	if f.issue == "" {
		for _, flag := range []string{"--title", "--parent", "--goal", "--ctx"} {
			if f.given[flag] {
				fmt.Fprintf(stderr, "run member: %s 는 --issue 와 함께 쓴다\n", flag)
				return nil, false
			}
		}
		if f.parallel || f.noCommit {
			fmt.Fprintln(stderr, "run member: --parallel·--no-commit 은 --issue 와 함께 쓴다")
			return nil, false
		}
		return nil, true
	}
	a := map[string]any{"issue": f.issue}
	if f.title != "" {
		a["title"] = f.title
	}
	if f.parent != "" {
		a["parent"] = f.parent
	}
	if f.goal != "" {
		a["goal"] = f.goal
	}
	if f.parallel {
		a["parallel"] = true
	}
	if f.noCommit {
		a["noCommit"] = true
	}
	if f.given["--ctx"] {
		n, ok := ctxPctArg(f.ctx, "run member", stderr)
		if !ok {
			return nil, false
		}
		a["ctxPct"] = n
	}
	return a, true
}

func ctxPctArg(v, cmd string, stderr io.Writer) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 1 || n > 100 {
		fmt.Fprintf(stderr, "%s: --ctx 는 1~100 의 정수다: %q\n", cmd, v)
		return 0, false
	}
	return n, true
}

// runSubAssign 은 배정의 일부를 고친다. 받은 플래그만 보낸다.
func runSubAssign(f runFlags, stdout, stderr io.Writer) int {
	if f.member == "" {
		fmt.Fprintln(stderr, "run assign: --member 는 필수다")
		return 2
	}
	body := map[string]any{"memberId": f.member, "toolId": selfToolID()}
	if f.given["--title"] {
		body["title"] = f.title
	}
	if f.given["--goal"] {
		body["goal"] = f.goal
	}
	if f.parallel {
		body["parallel"] = true
	}
	if f.noCommit {
		body["noCommit"] = true
	}
	if f.given["--ctx"] {
		n, ok := ctxPctArg(f.ctx, "run assign", stderr)
		if !ok {
			return 2
		}
		body["ctxPct"] = n
	}
	raw, code := runPost("/api/runs/assign", body, stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var resp struct {
		Member struct {
			ID     string          `json:"id"`
			Assign json.RawMessage `json:"assign"`
		} `json:"member"`
	}
	_ = json.Unmarshal(raw, &resp)
	fmt.Fprintf(stdout, "assign  member=%s  %s\n", resp.Member.ID, resp.Member.Assign)
	return 0
}
