package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"dongminal/internal/shared/dmlog"

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

// nodeTakenExtra 는 `node_taken` 거절에 그 이슈를 쥔 멤버와 상태를 싣는다
// (ISSUE_TREE_OPS_SRS FR-ITB-4). 그 멤버가 lost 면 이어받는 명령을 알린다 —
// migration 으로 옛 탭이 닫힌 노드는 승계로만 다시 맡을 수 있다.
func (s *Server) nodeTakenExtra(err error) map[string]any {
	var ne *run.NodeTakenError
	if !errors.As(err, &ne) {
		return nil
	}
	out := map[string]any{"memberId": ne.MemberID}
	if _, m, ok := s.Runs.FindMember(ne.MemberID); ok {
		st := s.deriveMemberState(m)
		out["state"] = st
		if st == run.Lost {
			out["hint"] = "dmctl run succeed --member " + ne.MemberID + " --at <새 탭 uuid> 로 이어받는다"
		}
	}
	return out
}

// notifyTreeSuccession 은 트리 멤버의 승계를 부모와 자식에게 알린다 (FR-ITB-3). 그들의
// 대화 맥락에는 옛 toolId 가 있다 — 서버가 알리지 않으면 완료·질문이 닫힌 탭으로 간다.
func (s *Server) notifyTreeSuccession(rec run.Record, next run.Member) {
	if next.Assign == nil || rec.Tree == "" {
		return
	}
	text := fmt.Sprintf("[ISSUE-TREE 승계] %s 새 toolId=%s member=%s", next.Role, next.ToolID, next.ID)
	targets := []string{s.currentToolOf(next.Assign.Parent)}
	for _, r := range s.Runs.List() {
		if r.State != run.Open || r.Tree != rec.Tree {
			continue
		}
		for _, m := range r.Members {
			if m.Assign != nil && m.Assign.Parent == next.ID && m.SucceededBy == "" && !m.Reported() {
				targets = append(targets, m.ToolID)
			}
		}
	}
	for _, to := range targets {
		if to == "" {
			continue
		}
		if err := s.deliverToTool(to, agentEnvelope(envelopeServerSender, to, text), true); err != nil {
			dmlog.Errorf(nil, "[run] 트리 승계 알림 실패 to=%s: %v", to, err)
		}
	}
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
