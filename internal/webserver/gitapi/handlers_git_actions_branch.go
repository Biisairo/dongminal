package gitapi

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
)

// 브랜치 행 메뉴의 판정 (SERVER_DRIVEN_ACTIONS_SRS GT-d·e). 메뉴의 2층 답과 실행 종단의
// 거절이 같은 함수(branchAnswer)를 부른다 (D-SDA-6). 요청의 이름은 실제 ref 에 대 본다 —
// 화면이 정한 "로컬이다/원격이다" 를 믿지 않는다.

// branchFacts 는 판정에 쓰는 저장소의 사실이다.
type branchFacts struct {
	refs []query.Ref
	st   query.Status
}

func (s *GitServer) branchFacts(ctx context.Context, root string, st query.Status) (branchFacts, error) {
	refs, err := query.Refs(s.Git.Service(), ctx, root)
	return branchFacts{refs: refs, st: st}, err
}

func (f branchFacts) find(kind, short string) (query.Ref, bool) {
	for _, r := range f.refs {
		if r.Kind == kind && r.Short == short {
			return r, true
		}
	}
	return query.Ref{}, false
}

// refOr 는 그 종류의 ref 다. 없으면 이름만 든 빈 종류의 ref 를 준다 — 판정이 "그 종류가
// 아니다" 로 답한다.
func (f branchFacts) refOr(kind, short string) query.Ref {
	if r, ok := f.find(kind, short); ok {
		return r
	}
	return query.Ref{Short: short}
}

// anyRef 는 로컬 → 원격 순으로 찾은 ref 다. 둘 다 없으면 false(oid·태그 등).
func (f branchFacts) anyRef(short string) (query.Ref, bool) {
	if r, ok := f.find(query.RefKindLocal, short); ok {
		return r, true
	}
	return f.find(query.RefKindRemote, short)
}

// branchPair 는 양쪽 삭제의 짝이다 (FR-SDA-35 · FR-BMU-16f). git 이 짝이라고 적어 둔 추적
// 관계만 짝이다 — 추적하는 로컬이 여럿이면 짝을 정하지 않는다.
func branchPair(r query.Ref, f branchFacts) (query.Ref, string, action.Answer) {
	if r.Kind == query.RefKindLocal {
		if r.Upstream == "" {
			return query.Ref{}, "", action.Deny(http.StatusConflict, apierr.CodeNoUpstream, nil)
		}
		return r, r.Upstream, action.Allow()
	}
	var hits []query.Ref
	for _, l := range f.refs {
		if l.Kind == query.RefKindLocal && l.Upstream == r.Short {
			hits = append(hits, l)
		}
	}
	switch len(hits) {
	case 0:
		return query.Ref{}, "", action.Deny(http.StatusConflict, apierr.CodeNoTrackingBranch, nil)
	case 1:
		return hits[0], r.Short, action.Allow()
	}
	return query.Ref{}, "", action.Deny(http.StatusConflict, apierr.CodeManyTrackingBranch, nil)
}

func notKind(kind string, r query.Ref) action.Answer {
	if r.Kind == kind {
		return action.Allow()
	}
	if kind == query.RefKindLocal {
		return action.Deny(http.StatusBadRequest, apierr.CodeNotLocalBranch, nil)
	}
	return action.Deny(http.StatusBadRequest, apierr.CodeNotRemoteBranch, nil)
}

var current = action.Deny(http.StatusConflict, apierr.CodeBranchCurrent, nil)

// branchAnswer 는 브랜치 동작 하나의 판정이다 — 칸은 보지 않는다 (칸은 파이프라인의
// 잠금과 branchSlots 가 본다).
func branchAnswer(id string, r query.Ref, f branchFacts) action.Answer {
	local := r.Kind == query.RefKindLocal
	switch id {
	case action.GitBranchCheckout:
		if a := notKind(query.RefKindLocal, r); !a.OK {
			return a
		}
		if r.IsHead {
			return current
		}
	case action.GitBranchCheckoutLocal, action.GitBranchFetch, action.GitBranchDeleteRemote:
		return notKind(query.RefKindRemote, r)
	case action.GitBranchRename, action.GitBranchUpstreamSet, action.GitBranchPush:
		return notKind(query.RefKindLocal, r)
	case action.GitBranchUpstreamUnset:
		if a := notKind(query.RefKindLocal, r); !a.OK {
			return a
		}
		if r.Upstream == "" {
			return action.Deny(http.StatusConflict, apierr.CodeNoUpstream, nil)
		}
	case action.GitBranchMerge, action.GitBranchRebase:
		if a := opAnswer(f.st); !a.OK {
			return a
		}
		if local && r.IsHead {
			return action.Deny(http.StatusConflict, apierr.CodeTargetIsHead, nil)
		}
	case action.GitBranchDelete:
		if a := notKind(query.RefKindLocal, r); !a.OK {
			return a
		}
		if r.IsHead {
			return current
		}
	case action.GitBranchDeleteBoth:
		loc, _, a := branchPair(r, f)
		if !a.OK {
			return a
		}
		if loc.IsHead {
			return current
		}
	}
	return action.Allow()
}

// branchSlots 는 동작이 쓰는 칸이다 — 원격으로 나가는 것은 common, 둘 다 하는 양쪽
// 삭제는 두 칸, 나머지는 index.
func branchSlots(id string) []string {
	switch id {
	case action.GitBranchPush, action.GitBranchFetch, action.GitBranchDeleteRemote:
		return []string{jobs.SlotCommon}
	case action.GitBranchDeleteBoth:
		return []string{jobs.SlotIndex, jobs.SlotCommon}
	}
	return []string{jobs.SlotIndex}
}

// branchMenuIDs 는 메뉴가 보일 수 있는 동작이다. 원격 행의 삭제는 원격 삭제다.
func branchMenuIDs(r query.Ref) []string {
	del := action.GitBranchDelete
	if r.Kind == query.RefKindRemote {
		del = action.GitBranchDeleteRemote
	}
	return []string{action.GitBranchCheckout, action.GitBranchCheckoutLocal, action.GitBranchRename,
		action.GitBranchMerge, action.GitBranchRebase, action.GitBranchUpstreamSet, action.GitBranchUpstreamUnset,
		action.GitBranchPush, action.GitBranchFetch, del, action.GitBranchDeleteBoth}
}

// gitBranchMenu 는 `kind=branch&ref=<refs/heads/…|refs/remotes/…>` 의 답이다 (GT-a).
func (s *GitServer) gitBranchMenu(w http.ResponseWriter, r *http.Request, root, requested string) {
	name := r.URL.Query().Get("ref")
	obs, _, err := s.Git.Status(r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	f, err := s.branchFacts(r.Context(), root, obs.Status)
	if err != nil {
		gitError(w, err)
		return
	}
	var target query.Ref
	found := false
	for _, x := range f.refs {
		if x.Name == name {
			target, found = x, true
			break
		}
	}
	if !found {
		gitFail(w, http.StatusNotFound, apierr.CodeNotFound, "ref not found: "+name)
		return
	}
	keys, err := s.gitKeys(r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	x := s.exclusion()
	out := map[string]action.Answer{}
	for _, id := range branchMenuIDs(target) {
		out[id] = action.First(slotsAnswer(x, keys, branchSlots(id)...), branchAnswer(id, target, f))
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"requested": map[string]any{"repo": requested, "kind": "branch", "ref": name},
		"repo":      root,
		"actions":   out,
	})
}

// judgeBranch 는 실행 종단의 판정이다. 사실을 읽지 못했거나 답이 거짓이면 응답을 쓰고
// 거짓을 준다.
func (t *gitWrite) judgeBranch(id string, pick func(branchFacts) (query.Ref, bool)) bool {
	return t.judgeFacts(func(f branchFacts) action.Answer {
		r, ok := pick(f)
		if !ok {
			return action.Allow()
		}
		return branchAnswer(id, r, f)
	})
}

// judgeFacts 는 저장소의 사실로 판정하는 실행 종단의 거절이다.
func (t *gitWrite) judgeFacts(judge func(branchFacts) action.Answer) bool {
	if t.stop() {
		return false
	}
	f, err := t.s.branchFacts(t.ctx(), t.root, t.snapshot())
	if t.stop() {
		return false
	}
	if err != nil {
		t.reject(err)
		return false
	}
	return t.judge(judge(f), nil)
}

// splitRemoteRef 는 `origin/x` 를 원격과 브랜치로 가른다. 원격 이름에 `/` 가 있을 수
// 있으므로 원격 목록에서 가장 긴 접두가 이긴다 (GT-e · G-B8).
func splitRemoteRef(remotes []string, short string) (string, string, bool) {
	sort.Slice(remotes, func(i, j int) bool { return len(remotes[i]) > len(remotes[j]) })
	for _, rm := range remotes {
		if strings.HasPrefix(short, rm+"/") && len(short) > len(rm)+1 {
			return rm, short[len(rm)+1:], true
		}
	}
	return "", "", false
}

// remoteNames 는 저장소의 원격 이름들이다 — 원격 ref 를 가르는 기준이다.
func (s *GitServer) remoteNames(ctx context.Context, root string) ([]string, error) {
	remotes, err := query.Remotes(s.Git.Service(), ctx, root)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(remotes))
	for _, rm := range remotes {
		names = append(names, rm.Name)
	}
	return names, nil
}

var notRemote = action.Deny(http.StatusBadRequest, apierr.CodeNotRemoteBranch, nil)

// remoteBranchOf 는 요청의 원격 ref 를 원격과 브랜치로 가른다 (GV-g · FR-SDA-42). ref 는
// 전체 이름(`refs/remotes/<원격>/<브랜치>`)이고, 비었으면 요청의 remote·branch 를 그대로
// 쓴다(R-3 — 스크립트 호환). 가를 수 없으면 400 not_remote_branch 로 거절하고 거짓이다.
func (t *gitWrite) remoteBranchOf(ref string, remote, branch *string) bool {
	if t.stop() || ref == "" {
		return !t.stop()
	}
	short, ok := strings.CutPrefix(ref, query.RemoteRefPrefix)
	if !ok {
		t.rejectAnswer(notRemote, nil)
		return false
	}
	names, err := t.s.remoteNames(t.ctx(), t.root)
	if err != nil {
		t.reject(err)
		return false
	}
	rm, br, ok := splitRemoteRef(names, short)
	if !ok {
		t.rejectAnswer(notRemote, nil)
		return false
	}
	*remote, *branch = rm, br
	return true
}

type gitBranchDeleteBothReq struct {
	Repo    string `json:"repo"`
	Ref     string `json:"ref"`
	Force   bool   `json:"force"`
	Confirm bool   `json:"confirm"`
}

// POST /api/git/branch/delete-both — 짝지어진 로컬과 원격을 함께 지운다 (FR-SDA-35 · GT-e).
//
// **파괴적이다.** 로컬을 먼저 지우고, 실패하면 원격을 건드리지 않는다 (FR-BMU-14). 로컬
// 삭제의 판정(현재 브랜치·미머지)은 `branch/delete` 와 같다. 응답은 원격 삭제 잡이다.
func (s *GitServer) apiGitBranchDeleteBoth(w http.ResponseWriter, r *http.Request) {
	var req gitBranchDeleteBothReq
	t := s.beginWrite(w, r, &req)
	t.requireConfirm(true, req.Confirm,
		"양쪽 삭제는 파괴적이다: confirm:true 를 요구한다 (FR-GIT-89 · FR-BMU-10)")
	t.resolve(req.Repo)
	before := t.snapshot()
	if t.stop() {
		return
	}
	f, err := s.branchFacts(t.ctx(), t.root, before)
	if err != nil {
		t.reject(err)
		return
	}
	var target query.Ref
	for _, x := range f.refs {
		if x.Name == req.Ref {
			target = x
		}
	}
	if target.Name == "" {
		t.rejectWith(http.StatusNotFound, apierr.CodeNotFound, "ref not found: "+req.Ref)
		return
	}
	// common 칸은 원격 삭제 잡이 등록될 때 launchJob 이 다시 본다 — 여기서 먼저 보는
	// 것은 로컬을 지운 뒤 원격에서 막히는 반쪽 삭제를 피하려는 것이다.
	if a := action.First(slotsAnswer(s.exclusion(), t.keys, jobs.SlotCommon),
		branchAnswer(action.GitBranchDeleteBoth, target, f)); !a.OK {
		t.rejectAnswer(a, nil)
		return
	}
	local, upstream, _ := branchPair(target, f)
	names, err := s.remoteNames(t.ctx(), t.root)
	if err != nil {
		t.reject(err)
		return
	}
	remote, branch, ok := splitRemoteRef(names, upstream)
	if !ok {
		t.rejectWith(http.StatusConflict, apierr.CodeNoUpstream, "upstream remote not found: "+upstream)
		return
	}
	opts := write.BranchDeleteOpts{Names: []string{local.Short}, Force: req.Force}
	if s.gitBranchDeleteBlocked(w, t.ctx(), req.Repo, t.root, before, opts) {
		t.done = true
		return
	}
	spec, hint, err := write.RemoteBranchDeleteSpec(s.Git.Service(), t.ctx(), t.root,
		write.RemoteBranchOpts{Remote: remote, Branch: branch})
	if err != nil {
		t.reject(err)
		return
	}
	plan := write.BranchDeletePlan{}
	t.apply(func(ctx context.Context) error {
		var err error
		_, plan, err = write.BranchDelete(s.Git.Service(), ctx, t.root, opts)
		return err
	})
	t.startHintedJob("push", spec, map[string]any{"deleted": plan}, &hint)
}
