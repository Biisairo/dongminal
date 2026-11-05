package gitapi

import (
	"context"
	"net/http"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
)

// GET /api/git/actions?repo=&action=<id>[&<입력>] — 동작의 답
// (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-5 · M-5).
//
// **답이 거짓이어도 200 이다.** 이 종단은 "할 수 있는가" 를 묻는 자리다 — 거짓을
// 요청 실패로 답하면 화면은 "못 한다" 와 "묻지 못했다" 를 가르지 못한다. 거절은
// 실행 종단의 몫이고, 그것은 같은 판정 함수를 부른다 (D-SDA-6).
func (s *GitServer) apiGitActions(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	id := q.Get("action")
	var a action.Answer
	switch id {
	case action.GitStashCreate:
		// 실행 종단(stash/push)이 판정에 쓰는 것과 같은 관측이다.
		obs, _, err := s.Git.Status(r.Context(), root)
		if err != nil {
			gitError(w, err)
			return
		}
		a = stashCreateAnswer(obs.Status, q.Get("includeUntracked") == "1")
	default:
		gitFail(w, http.StatusBadRequest, apierr.CodeBadRequest, "unknown action: "+id)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"requested": map[string]any{"repo": requested, "action": id},
		"repo":      root,
		"actions":   map[string]action.Answer{id: a},
	})
}

// stashCreateAnswer 는 stash 만들기의 판정이다 (FR-SDA-24 · FR-GIT-167). 답 종단과
// `stash/push` 의 거절이 이 함수 하나를 부른다.
//
// untracked 뿐인데 옵션이 꺼져 있으면 사유를 가른다 — 옵션을 켜면 담기므로 사용자가
// 할 일이 "변경 없음" 과 다르다.
func stashCreateAnswer(st query.Status, includeUntracked bool) action.Answer {
	if write.StashableCount(st, includeUntracked) > 0 {
		return action.Allow()
	}
	if !includeUntracked && len(st.Untracked) > 0 {
		return action.Deny(http.StatusConflict, apierr.CodeUntrackedOnly, map[string]any{"count": len(st.Untracked)})
	}
	return action.Deny(http.StatusConflict, apierr.CodeNothingToStash, nil)
}

// slotReader 는 칸을 쥔 잡을 묻는 자리다 — jobs.Exclusion 이 답한다.
type slotReader interface {
	IndexBusy(top string) (string, bool)
	CommonBusy(common string) (string, bool)
}

// slotsAnswer 는 작업 칸의 판정이다 (GR-1a). 칸 중 하나라도 잡이 쥐면 409 job_busy.
// 1층 답과, 동기 쓰기·잡 시작·lock 지우기·worktree 만들기의 거절이 이 함수 하나를
// 부른다 (D-SDA-6). 잡 등록의 원자적 차지는 여전히 Exclusion.claim 이 진다 — 이
// 판정과 차지 사이에 다른 잡이 끼면 claim 이 같은 코드로 거절한다.
func slotsAnswer(x slotReader, k jobs.Keys, slots ...string) action.Answer {
	for _, slot := range slots {
		var id string
		var busy bool
		if slot == jobs.SlotIndex {
			id, busy = x.IndexBusy(k.Top)
		} else {
			id, busy = x.CommonBusy(k.Common)
		}
		if busy {
			return action.Deny(http.StatusConflict, apierr.CodeJobBusy, map[string]any{"job": id})
		}
	}
	return action.Allow()
}

// repoSlotActions 는 1층에 싣는 작업 칸 동작과 그 칸이다 (GR-1b). 잡을 시작하는
// 동작은 그 kind 의 칸을 jobs.SlotsOf 에서 받는다 — 칸 규칙은 서버에 한 벌이다.
var repoSlotActions = []struct {
	id    string
	slots []string
}{
	{action.GitFetch, jobs.SlotsOf("fetch")},
	{action.GitPull, jobs.SlotsOf("pull")},
	{action.GitPush, jobs.SlotsOf("push")},
	{action.GitBranchPush, jobs.SlotsOf("push")},
	{action.GitBranchFetch, jobs.SlotsOf("fetch")},
	{action.GitBranchDeleteRemote, jobs.SlotsOf("push")},
	{action.GitTagPush, jobs.SlotsOf("push")},
	{action.GitTagDeleteRemote, jobs.SlotsOf("push")},
	{action.GitWrite, []string{jobs.SlotIndex}},
	{action.GitCommit, jobs.SlotsOf("commit")},
	{action.GitLockRemove, []string{jobs.SlotIndex, jobs.SlotCommon}},
	{action.GitWorktreeCreate, []string{jobs.SlotCommon}},
	{action.GitSubmoduleUpdate, jobs.SlotsOf("submodule")},
}

// repoActions 는 저장소 하나의 1층 답이다 (FR-SDA-4·20). 칸 상태는 요청마다 읽는다 —
// 관측 캐시(mark) 밖의 사실이다.
func (s *GitServer) repoActions(ctx context.Context, root string) (map[string]action.Answer, error) {
	keys, err := s.gitKeys(ctx, root)
	if err != nil {
		return nil, err
	}
	x := s.exclusion()
	out := make(map[string]action.Answer, len(repoSlotActions))
	for _, a := range repoSlotActions {
		out[a.id] = slotsAnswer(x, keys, a.slots...)
	}
	return out, nil
}

// worktreeRemoveAnswer 는 worktree 하나를 지울 수 있는가다 (GR-1h). 다른 worktree 작업이
// common 칸을 쥐었거나, **대상** worktree 의 index 칸을 잡이 쥐었으면 409 job_busy.
// 목록의 행 답과 `worktrees/remove` 의 거절이 이 함수를 부른다 (D-SDA-6).
func worktreeRemoveAnswer(x slotReader, common string, jobKind func(id string) string, target string) action.Answer {
	if id, busy := x.CommonBusy(common); busy && jobKind(id) == "worktree" {
		return action.Deny(http.StatusConflict, apierr.CodeJobBusy, map[string]any{"job": id})
	}
	return slotsAnswer(x, jobs.Keys{Top: core.ExclusionKey(target)}, jobs.SlotIndex)
}
