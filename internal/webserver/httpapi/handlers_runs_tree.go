package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
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

// treeNode 는 트리 대시보드의 노드 하나다 (FR-ITD-1~3, ISSUE_TREE_OPS_SRS FR-ITC-1~3).
type treeNode struct {
	// graphMember 다 — 대시보드 그래프와 같은 명시 선택이라 brief 같은 본문이 새지 않는다
	// (NFR-RVZ-3).
	graphMember
	RunID string `json:"runId"`
	// Parent 는 부모 노드의 역할 이름이다. 루트면 비어 있다 (FR-ITD-2).
	Parent string `json:"parent"`
	// Leaf 는 열린 자식 노드가 없는 열린 노드다 — 지금 일하는 잎 (FR-ITD-3).
	Leaf bool `json:"leaf"`
	// FR-ITC-3: 배정의 이슈·제목과 끝난 시각(보고). 끝난 노드도 흔적으로 남는다.
	Issue   string `json:"issue,omitempty"`
	Title   string `json:"title,omitempty"`
	EndedAt int64  `json:"endedAt,omitempty"`

	parentID  string // 배정 부모(승계 사슬 끝으로 옮긴 뒤)
	createdAt int64
	seq       int // 기록 안에서 사슬 첫 멤버의 자리 — 같은 초에 선 형제의 순서
}

// treeParent 는 사슬 이름의 부모를 고른다 (FR-ITD-2). 배정 부모가 없는 노드에만 쓴다
// (FR-ITC-1). 사슬의 가장 긴 앞부분을 가진 노드이고, 없으면 그 위로 오른다.
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

// treeEnded 는 흔적으로만 남는 노드의 상태다.
func treeEnded(st run.MemberState) bool {
	return st == run.Done || st == run.Failed || st == run.Released
}

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
	// successor 는 승계 사슬을 끝으로 잇는다 — 사슬은 한 노드다 (FR-ITC-2).
	successor := map[string]string{}
	for _, rec := range s.Runs.List() {
		if rec.State != run.Open || rec.Tree != ref {
			continue
		}
		runs = append(runs, treeRun{ID: rec.ID, Short: rec.Short, WindowID: rec.WindowID, TreeBranch: rec.TreeBranch})
		raw := map[string]run.Member{}
		// started 는 노드가 선 시각이다 — 승계자는 사슬 첫 멤버의 시각을 잇는다(전임자가
		// 기록에서 앞에 있다). 그래야 승계가 형제 순서를 바꾸지 않는다.
		started := map[string]int64{}
		seq := map[string]int{}
		for i, m := range rec.Members {
			raw[m.ID] = m
			started[m.ID], seq[m.ID] = m.CreatedAt, i
			if at, ok := started[m.SucceededFrom]; ok {
				started[m.ID], seq[m.ID] = at, seq[m.SucceededFrom]
			}
			if m.SucceededBy != "" {
				successor[m.ID] = m.SucceededBy
			}
		}
		for _, gm := range s.graphMembers(rec) {
			m := raw[gm.ID]
			if m.SucceededBy != "" {
				continue
			}
			n := treeNode{graphMember: gm, RunID: rec.ID, EndedAt: m.ReportedAt, createdAt: started[m.ID], seq: seq[m.ID]}
			if a := m.Assign; a != nil {
				n.Issue, n.Title, n.parentID = a.Issue, a.Title, a.Parent
			}
			nodes = append(nodes, n)
		}
	}
	end := func(id string) string {
		for seen := map[string]bool{}; successor[id] != "" && !seen[id]; id = successor[id] {
			seen[id] = true
		}
		return id
	}
	roleOf := map[string]string{}
	active := map[string]bool{}
	for _, n := range nodes {
		roleOf[n.ID] = n.Role
		if !treeEnded(n.State) {
			active[n.Role] = true
		}
	}
	for i := range nodes {
		if nodes[i].parentID != "" {
			nodes[i].Parent = roleOf[end(nodes[i].parentID)]
		} else {
			nodes[i].Parent = treeParent(nodes[i].Role, active)
		}
	}
	hasOpenChild := map[string]bool{}
	for _, n := range nodes {
		if !treeEnded(n.State) {
			hasOpenChild[n.Parent] = true
		}
	}
	for i := range nodes {
		nodes[i].Leaf = !treeEnded(nodes[i].State) && !hasOpenChild[nodes[i].Role]
	}
	nodes = treeDepthFirst(nodes)
	if runs == nil {
		runs = []treeRun{}
	}
	writeJSON(w, map[string]any{"tree": ref, "runs": runs, "nodes": nodes})
}

// treeDepthFirst 는 노드를 깊이 우선으로 늘어놓는다. 같은 부모의 자식은 등록 순서다
// (FR-ITC-3·8). 부모가 목록에 없는 노드는 뿌리로 선다.
func treeDepthFirst(nodes []treeNode) []treeNode {
	sort.SliceStable(nodes, func(i, j int) bool {
		if nodes[i].createdAt != nodes[j].createdAt {
			return nodes[i].createdAt < nodes[j].createdAt
		}
		return nodes[i].seq < nodes[j].seq
	})
	present := map[string]bool{}
	for _, n := range nodes {
		present[n.Role] = true
	}
	kids := map[string][]int{}
	var roots []int
	for i, n := range nodes {
		if n.Parent == "" || !present[n.Parent] {
			roots = append(roots, i)
			continue
		}
		kids[n.Parent] = append(kids[n.Parent], i)
	}
	out := make([]treeNode, 0, len(nodes))
	seen := map[int]bool{}
	var walk func(i int)
	walk = func(i int) {
		if seen[i] {
			return
		}
		seen[i] = true
		out = append(out, nodes[i])
		for _, k := range kids[nodes[i].Role] {
			walk(k)
		}
	}
	for _, i := range roots {
		walk(i)
	}
	return out
}
