package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/run"
)

// ISSUE_AGENT_TREE_SRS 묶음 U·D — 트리 중복 방지의 응답과 트리 조회.

// treeOpenExtra 는 `tree_open` 거절에 그 Run 과 멈춤 여부를 싣는다 (FR-ITU-5).
// 열린 Run 들의 멤버 도구가 하나도 살아 있지 않으면 멈춘 트리다.
func (s *Server) treeOpenExtra(err error) map[string]any {
	var te *run.TreeOpenError
	if !errors.As(err, &te) {
		return nil
	}
	stale := true
	if rec, ok := s.Runs.Get(te.RunID); ok {
		for _, r := range s.Runs.List() {
			if r.State != run.Open || r.Tree != rec.Tree {
				continue
			}
			for _, m := range r.Members {
				if s.toolLive(m.ToolID) {
					stale = false
				}
			}
		}
	}
	return map[string]any{"runId": te.RunID, "stale": stale}
}

// treeNode 는 트리 대시보드의 노드 하나다 (FR-ITD-1~3).
type treeNode struct {
	// graphMember 다 — 대시보드 그래프와 같은 명시 선택이라 brief 같은 본문이 새지 않는다
	// (NFR-RVZ-3).
	graphMember
	RunID string `json:"runId"`
	// Parent 는 부모 노드의 역할 이름이다. 루트면 비어 있다 (FR-ITD-2).
	Parent string `json:"parent"`
	// Leaf 는 자식 노드가 없다는 뜻이다 — 지금 일하는 잎 (FR-ITD-3).
	Leaf bool `json:"leaf"`
}

// treeParent 는 사슬 이름의 부모를 고른다 (FR-ITD-2). 사슬의 가장 긴 앞부분을 가진
// 노드이고, 없으면 그 위로 오른다. 하나도 없으면 빈 문자열이다.
func treeParent(role string, exists map[string]bool) string {
	parts := strings.Split(role, treeChainSep)
	for k := len(parts) - 1; k >= 1; k-- {
		if cand := strings.Join(parts[:k], treeChainSep); exists[cand] {
			return cand
		}
	}
	return ""
}

// treeChainSep 은 사슬 이름의 구분자다 (FR-IAT-40).
const treeChainSep = "›"

// apiRunsTree implements GET /api/runs/tree?ref=<owner/repo#N> (FR-ITD-5).
func (s *Server) apiRunsTree(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	ref := strings.TrimSpace(r.URL.Query().Get("ref"))
	if ref == "" {
		httpErr(w, "ref required", http.StatusBadRequest, apierr.CodeMissingArg)
		return
	}
	type treeRun struct {
		ID         string `json:"id"`
		Short      string `json:"short"`
		WindowID   string `json:"windowId,omitempty"`
		TreeBranch bool   `json:"treeBranch,omitempty"`
	}
	var runs []treeRun
	var nodes []treeNode
	for _, rec := range s.Runs.List() {
		if rec.State != run.Open || rec.Tree != ref {
			continue
		}
		runs = append(runs, treeRun{ID: rec.ID, Short: rec.Short, WindowID: rec.WindowID, TreeBranch: rec.TreeBranch})
		for _, m := range s.graphMembers(rec) {
			switch m.State {
			case run.Done, run.Failed, run.Released, run.Succeeded:
				continue
			}
			nodes = append(nodes, treeNode{graphMember: m, RunID: rec.ID})
		}
	}
	exists := map[string]bool{}
	for _, n := range nodes {
		exists[n.Role] = true
	}
	hasChild := map[string]bool{}
	for i := range nodes {
		nodes[i].Parent = treeParent(nodes[i].Role, exists)
		hasChild[nodes[i].Parent] = true
	}
	for i := range nodes {
		nodes[i].Leaf = !hasChild[nodes[i].Role]
	}
	if runs == nil {
		runs = []treeRun{}
	}
	if nodes == nil {
		nodes = []treeNode{}
	}
	writeJSON(w, map[string]any{"tree": ref, "runs": runs, "nodes": nodes})
}
