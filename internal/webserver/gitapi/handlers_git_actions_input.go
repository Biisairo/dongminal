package gitapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
	"dongminal/internal/webserver/domain/worktree"
)

// 대화상자 입력의 판정 (SERVER_DRIVEN_ACTIONS_SRS 묶음 GV). 대화상자는 입력이 바뀌면
// `GET /api/git/actions?action=<id>&<입력>` 으로 묻고, 실행 종단은 같은 함수의 답으로
// 거절한다 (D-SDA-6).

// errAnswer 는 도메인 검사의 오류를 답으로 옮긴다 (GV-b). 코드는 실행 거절과 같은
// apierr.Git 표에서 온다 — 표에 없는 오류는 입력의 문제로 읽지 않는다.
func errAnswer(err error) action.Answer {
	if err == nil {
		return action.Allow()
	}
	status, code, ok := apierr.Git.Lookup(err)
	if !ok {
		return action.Deny(http.StatusBadRequest, apierr.CodeBadRequest, nil)
	}
	return action.Deny(status, code, nil)
}

func blank(s string) bool { return strings.TrimSpace(s) == "" }

// gitInputAnswer 는 입력을 받는 동작의 답이다. 그런 동작이 아니면 false 다.
func (s *GitServer) gitInputAnswer(ctx context.Context, root, id string, q url.Values) (action.Answer, bool, error) {
	switch id {
	case action.GitTagCreate:
		return errAnswer(write.CheckTagMessage(q.Get("tagKind"), q.Get("message"))), true, nil
	case action.GitBranchUpstreamSet:
		f, err := s.branchFacts(ctx, root, query.Status{})
		if err != nil {
			return action.Answer{}, true, err
		}
		return upstreamAnswer(f, q.Get("branch"), q.Get("upstream")), true, nil
	case action.GitStashBranch:
		a, err := s.stashBranchAnswer(ctx, root, q.Get("name"))
		return a, true, err
	case action.GitWorktreeCreate:
		a, err := s.worktreeCreateAnswer(ctx, root, q.Get("name"), q.Get("ref"), q.Get("newBranch") == "1")
		return a, true, err
	case action.GitRemoteAdd:
		a, err := s.remoteAddAnswer(ctx, root, q.Get("name"), q.Get("url"))
		return a, true, err
	case action.GitCompare:
		return compareAnswer(q.Get("rev"), q.Get("path")), true, nil
	}
	return action.Answer{}, false, nil
}

// upstreamAnswer 는 upstream 설정의 판정이다 (GV-f · FR-SDA-41). 브랜치는 로컬이어야
// 하고(GT-d), upstream 은 이 저장소가 아는 원격 ref 여야 한다.
func upstreamAnswer(f branchFacts, branch, upstream string) action.Answer {
	if a := branchAnswer(action.GitBranchUpstreamSet, f.refOr(query.RefKindLocal, branch), f); !a.OK {
		return a
	}
	if blank(upstream) {
		return action.Deny(http.StatusBadRequest, apierr.CodeEmptyRef, nil)
	}
	if _, ok := f.find(query.RefKindRemote, upstream); !ok {
		return action.Deny(http.StatusBadRequest, apierr.CodeUpstreamUnknown, nil)
	}
	return action.Allow()
}

// stashBranchAnswer 는 stash 에서 만들 브랜치 이름의 판정이다 (GV-c · G-B5). 이름 규칙은
// git 에 묻는다 — 규칙의 문제가 아닌 실패(저장소·git)는 답이 아니라 오류다.
func (s *GitServer) stashBranchAnswer(ctx context.Context, root, name string) (action.Answer, error) {
	if blank(name) {
		return action.Deny(http.StatusBadRequest, apierr.CodeEmptyName, nil), nil
	}
	if err := query.ValidBranchName(s.Git.Service(), ctx, root, name); err != nil {
		if !errors.Is(err, core.ErrRefName) {
			return action.Answer{}, err
		}
		return errAnswer(err), nil
	}
	exists, err := query.LocalBranchExists(s.Git.Service(), ctx, root, name)
	if err != nil {
		return action.Answer{}, err
	}
	if exists {
		return action.Deny(http.StatusConflict, apierr.CodeBranchExists, map[string]any{"branch": name}), nil
	}
	return action.Allow(), nil
}

// judge 는 실행 종단이 답으로 거절하는 자리다. 답이 거짓이면 응답을 쓰고 거짓을 준다.
func (t *gitWrite) judge(a action.Answer, err error) bool {
	if t.stop() {
		return false
	}
	if err != nil {
		t.reject(err)
		return false
	}
	if !a.OK {
		t.rejectAnswer(a, nil)
		return false
	}
	return true
}

// worktreeInputAnswer 는 worktree 만들기의 입력 판정이다 (GV-c · G-B3). 이름은 worktree 의
// 경로와 새 브랜치 이름이 되므로 worktree.CheckName 의 규칙을 따른다.
func worktreeInputAnswer(name, ref string) action.Answer {
	if blank(name) {
		return action.Deny(http.StatusBadRequest, apierr.CodeEmptyName, nil)
	}
	if err := worktree.CheckName(name); err != nil {
		return errAnswer(err)
	}
	if blank(ref) {
		return action.Deny(http.StatusBadRequest, apierr.CodeEmptyRef, nil)
	}
	return action.Allow()
}

// worktreePlaceAnswer 는 그 자리가 비었는가다 — 조용히 다른 경로를 고르지 않는다. 새
// 브랜치를 만들면 그 이름의 로컬 브랜치도 없어야 한다.
func (s *GitServer) worktreePlaceAnswer(ctx context.Context, root, path, name string, newBranch bool) action.Answer {
	if _, err := os.Stat(path); err == nil {
		return action.Deny(http.StatusConflict, apierr.CodeWorktreeExists, map[string]any{"path": path})
	}
	if newBranch && s.UserWorktrees.BranchExists(ctx, root, name) {
		return action.Deny(http.StatusConflict, apierr.CodeBranchExists, map[string]any{"branch": name})
	}
	return action.Allow()
}

// worktreeCreateAnswer 는 대화상자의 답이다. 실행 종단과 같은 순서다: 입력 → common 칸
// → 자리 (실행은 자리를 repoLock 안에서 다시 본다).
func (s *GitServer) worktreeCreateAnswer(ctx context.Context, root, name, ref string, newBranch bool) (action.Answer, error) {
	if a := worktreeInputAnswer(name, ref); !a.OK {
		return a, nil
	}
	keys, err := s.jobKeys(ctx, root)
	if err != nil {
		return action.Answer{}, err
	}
	if a := slotsAnswer(s.exclusion(), keys, jobs.SlotCommon); !a.OK {
		return a, nil
	}
	path := s.UserWorktrees.Path(worktree.RepoBucket(root), name)
	return s.worktreePlaceAnswer(ctx, root, path, name, newBranch), nil
}

// remoteAddAnswer 는 원격 추가의 판정이다 (GV-c · G-B4). 규칙은 write 의 검사 함수다 —
// 실행(`write.RemoteAdd`)도 그것을 지난다.
func (s *GitServer) remoteAddAnswer(ctx context.Context, root, name, u string) (action.Answer, error) {
	if blank(name) {
		return action.Deny(http.StatusBadRequest, apierr.CodeEmptyName, nil), nil
	}
	if err := write.CheckRemoteName(name); err != nil {
		return errAnswer(err), nil
	}
	if blank(u) {
		return action.Deny(http.StatusBadRequest, apierr.CodeEmptyURL, nil), nil
	}
	if err := write.CheckRemoteURL(u); err != nil {
		return errAnswer(err), nil
	}
	list, err := query.Remotes(s.Git.Service(), ctx, root)
	if err != nil {
		return action.Answer{}, err
	}
	for _, r := range list {
		if r.Name == name {
			return action.Deny(http.StatusConflict, apierr.CodeRemoteExists, nil), nil
		}
	}
	return action.Allow(), nil
}

// compareAnswer 는 비교 대화상자의 판정이다 (GV-c · G-B6). 실행은 화면이 diff 를 여는 것이라
// 서버의 실행 종단이 없다 — `commit-range` 의 from·to 검사는 그대로다.
func compareAnswer(rev, path string) action.Answer {
	if blank(rev) {
		return action.Deny(http.StatusBadRequest, apierr.CodeEmptyRev, nil)
	}
	if blank(path) {
		return action.Deny(http.StatusBadRequest, apierr.CodeEmptyPath, nil)
	}
	return action.Allow()
}

// repoAddAnswer 는 저장소 추가의 판정이다 (GV-c · G-B7). 저장소가 아니라는 판정(4xx)은
// 답이고, git 이 없는 것처럼 저장소 밖의 실패(5xx)는 오류다. 참이면 핀할 루트를 준다.
func (s *GitServer) repoAddAnswer(ctx context.Context, path string) (action.Answer, string, error) {
	if blank(path) {
		return action.Deny(http.StatusBadRequest, apierr.CodeEmptyPath, nil), "", nil
	}
	if !filepath.IsAbs(path) {
		return action.Deny(http.StatusBadRequest, apierr.CodeAbsPathNeeded, nil), "", nil
	}
	root, err := s.Git.RepoRoot(ctx, path)
	if err != nil {
		if status, _, ok := apierr.Git.Lookup(err); ok && status < http.StatusInternalServerError {
			return errAnswer(err), "", nil
		}
		return action.Answer{}, "", err
	}
	return action.Allow(), root, nil
}
