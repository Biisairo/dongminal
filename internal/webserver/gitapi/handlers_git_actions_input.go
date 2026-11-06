package gitapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/write"
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
