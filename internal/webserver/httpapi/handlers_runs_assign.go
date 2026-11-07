package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/webserver/domain/run"
)

// ISSUE_TREE_OPS_SRS 묶음 A — 배정과 트리 프리앰블의 HTTP 쪽.

// issueTreeCtxDefault 는 맥락 기준의 기본값이다 (FR-ITM-3).
const issueTreeCtxDefault = 50

// memberPreamble 은 멤버에게 맞는 프리앰블을 고른다 (FR-ITA-10). 배정이 있는 트리
// 멤버만 트리 프리앰블을 받고, 나머지는 종전 그대로다.
func (s *Server) memberPreamble(rec run.Record, m run.Member) string {
	if m.Assign == nil {
		return run.Preamble(rec, m)
	}
	return run.TreePreamble(rec, m, s.treeContext(rec, m))
}

// treeContext 는 프리앰블을 만드는 **순간**의 값을 모은다 (FR-ITA-12). 부모가
// 승계됐으면 승계 사슬의 끝을 따라가 지금 일하는 도구를 준다.
func (s *Server) treeContext(rec run.Record, m run.Member) run.TreeContext {
	tc := run.TreeContext{
		ParentToolID: s.currentToolOf(m.Assign.Parent),
		GroupID:      s.treeGroupID(rec.Tree),
		DocPath:      issueTreeDocPath(),
		CtxPct:       issueTreeCtxDefault,
	}
	if m.Assign.CtxPct > 0 {
		tc.CtxPct = m.Assign.CtxPct
	}
	return tc
}

// currentToolOf 는 멤버의 승계 사슬 끝의 도구다. 멤버가 없으면 빈 값이다.
func (s *Server) currentToolOf(memberID string) string {
	seen := map[string]bool{}
	for memberID != "" && !seen[memberID] {
		seen[memberID] = true
		_, m, ok := s.Runs.FindMember(memberID)
		if !ok {
			return ""
		}
		if m.SucceededBy == "" {
			return m.ToolID
		}
		memberID = m.SucceededBy
	}
	return ""
}

// treeGroupID 는 트리 표지(`owner/repo#N`)가 같은 window 그룹의 uuid 다 (FR-WGR-8).
// 워크스페이스에 없으면 빈 값이다 — 프리앰블은 「없음」 으로 적는다.
func (s *Server) treeGroupID(tree string) string {
	if s.Work == nil || tree == "" {
		return ""
	}
	i := strings.LastIndex(tree, "#")
	if i < 0 {
		return ""
	}
	repo, root := tree[:i], tree[i+1:]
	var ws struct {
		WindowGroups []struct {
			ID   string `json:"id"`
			Tree *struct {
				Repo string          `json:"repo"`
				Root json.RawMessage `json:"root"`
			} `json:"tree"`
		} `json:"windowGroups"`
	}
	if json.Unmarshal(s.Work.Raw(), &ws) != nil {
		return ""
	}
	for _, g := range ws.WindowGroups {
		if g.Tree == nil || g.Tree.Repo != repo {
			continue
		}
		// root 는 화면이 숫자로도 문자열로도 쓸 수 있다.
		if strings.Trim(string(g.Tree.Root), `"`) == root {
			return g.ID
		}
	}
	return ""
}

// issueTreeDocPath 는 설치된 issue-tree 명령 문서의 절대 경로다 (FR-ITA-13). 홈을
// 모르면 빈 값이다 — `toolhub.toolBinDir` 과 같은 규칙으로 상대경로를 만들지 않는다.
func issueTreeDocPath() string {
	home := os.Getenv(dmenv.EnvHome)
	if home == "" {
		return ""
	}
	return filepath.Join(home, dmenv.BinDir, "agent-plugin", "commands", "issue-tree.md")
}

// apiRunAssign implements POST /api/runs/assign (FR-ITA-4).
func (s *Server) apiRunAssign(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	var body struct {
		MemberID string  `json:"memberId"`
		Title    *string `json:"title"`
		Goal     *string `json:"goal"`
		Parallel *bool   `json:"parallel"`
		CtxPct   *int    `json:"ctxPct"`
		NoCommit *bool   `json:"noCommit"`
		ToolID   string  `json:"toolId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.MemberID) == "" {
		writeRunError(w, fmt.Errorf("%w: --member 는 필수다", run.ErrInvalidArgument), nil)
		return
	}
	m, err := s.Runs.UpdateAssign(s.callerToolID(r, body.ToolID), body.MemberID, run.AssignPatch{
		Title: body.Title, Goal: body.Goal, Parallel: body.Parallel, CtxPct: body.CtxPct, NoCommit: body.NoCommit,
	})
	if err != nil {
		writeRunError(w, err, nil)
		return
	}
	if rec, ok := s.Runs.Get(m.RunID); ok {
		s.broadcastRunChanged(rec)
	}
	writeJSON(w, map[string]any{"member": memberView{Member: m, State: s.deriveMemberState(m)}})
}
