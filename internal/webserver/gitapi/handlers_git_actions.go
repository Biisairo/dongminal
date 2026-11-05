package gitapi

import (
	"net/http"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
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
