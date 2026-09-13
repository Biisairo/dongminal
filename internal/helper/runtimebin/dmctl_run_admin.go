package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"time"
)

// `run delete` · `run graph` — 웹 UI 에는 있고 CLI 에는 없던 둘 (M8_UNIFIED_SRS D-A-6,
// 10-func-backend FBE-15). 각각 API 한 번이다.

// runSubDelete implements `dmctl run delete --run <uuid>` → `DELETE /api/runs/{id}`.
//
// close 와 다르다 — 미보고 검사 없이 레코드를 지운다 (FR-DEL-8~11). 잔여물은 보고한다.
func runSubDelete(f runFlags, stdout, stderr io.Writer) int {
	if f.run == "" {
		fmt.Fprintln(stderr, "run delete: --run 은 필수다")
		return 2
	}
	raw, code := runDelete("/api/runs/"+url.PathEscape(f.run), stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var rec struct {
		ID        string        `json:"id"`
		Short     string        `json:"short"`
		State     string        `json:"state"`
		Worktrees []runWorktree `json:"worktrees"`
		Residue   int           `json:"residue"`
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid delete response: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "deleted  run=%s  short=%s  state=%s\n", rec.ID, rec.Short, rec.State)
	if rec.Residue > 0 {
		fmt.Fprintf(stdout, "잔여물 %d건 (지우지 않았다 — 레코드도 남는다):\n", rec.Residue)
		for _, wt := range rec.Worktrees {
			if wt.Removed {
				continue
			}
			line := fmt.Sprintf("  %s  branch=%s  사유=%s", wt.Path, wt.Branch, wt.Residue)
			if wt.Detail != "" {
				line += "  (" + wt.Detail + ")"
			}
			fmt.Fprintln(stdout, line)
		}
	}
	return 0
}

// runSubGraph implements `dmctl run graph --run <uuid>` → `GET /api/runs/{id}/graph`.
func runSubGraph(f runFlags, stdout, stderr io.Writer) int {
	if f.run == "" {
		fmt.Fprintln(stderr, "run graph: --run 은 필수다")
		return 2
	}
	raw, code := runGet("/api/runs/"+url.PathEscape(f.run)+"/graph", stderr)
	if code != 0 {
		return code
	}
	if f.jsonOut {
		writeRawJSON(stdout, raw)
		return 0
	}
	var g struct {
		RunID     string `json:"runId"`
		Short     string `json:"short"`
		Objective string `json:"objective"`
		State     string `json:"state"`
		Isolation string `json:"isolation"`
		Members   []struct {
			ID      string `json:"id"`
			Role    string `json:"role"`
			Agent   string `json:"agent"`
			ToolID  string `json:"toolId"`
			TabID   string `json:"tabId"`
			State   string `json:"state"`
			Outcome string `json:"outcome"`
		} `json:"members"`
		Edges []struct {
			From   string `json:"from"`
			To     string `json:"to"`
			Count  int    `json:"count"`
			LastAt int64  `json:"lastAt"`
		} `json:"edges"`
		Timeline []struct {
			At       int64  `json:"at"`
			Kind     string `json:"kind"`
			MemberID string `json:"memberId"`
		} `json:"timeline"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		fmt.Fprintf(stderr, "dmctl: invalid graph response: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "run=%s  short=%s  state=%s  isolation=%s  objective=%s\n",
		g.RunID, g.Short, g.State, g.Isolation, g.Objective)
	fmt.Fprintf(stdout, "멤버 %d:\n", len(g.Members))
	for _, m := range g.Members {
		line := fmt.Sprintf("  %s  role=%s  agent=%s  state=%s  toolId=%s", m.ID, m.Role, m.Agent, m.State, m.ToolID)
		if m.TabID != "" {
			line += "  tabId=" + m.TabID
		}
		if m.Outcome != "" {
			line += "  outcome=" + m.Outcome
		}
		fmt.Fprintln(stdout, line)
	}
	fmt.Fprintf(stdout, "간선 %d (msg):\n", len(g.Edges))
	for _, e := range g.Edges {
		fmt.Fprintf(stdout, "  %s -> %s  count=%d  last=%s\n", e.From, e.To, e.Count, graphTime(e.LastAt))
	}
	fmt.Fprintf(stdout, "타임라인 %d:\n", len(g.Timeline))
	for _, ev := range g.Timeline {
		line := fmt.Sprintf("  %s  %s", graphTime(ev.At), ev.Kind)
		if ev.MemberID != "" {
			line += "  member=" + ev.MemberID
		}
		fmt.Fprintln(stdout, line)
	}
	return 0
}

// graphTime 은 서버의 밀리초 시각을 사람이 읽을 시각으로 낸다. 0 은 "없다" 다.
func graphTime(ms int64) string {
	if ms <= 0 {
		return "-"
	}
	return time.UnixMilli(ms).Format("15:04:05")
}
