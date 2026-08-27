package gitapi

import (
	"context"
	"net/http"

	"dongminal/internal/webserver/domain/git/write"
)

// /api/git/operation — 진행 중 작업의 출구 (GIT_ACTIONS_SRS §3.1 / FR-GIT-252).
//
// merge·rebase·cherry-pick·revert 가 충돌로 멈추면 저장소에 중간 상태가 남는다.
// 그 상태에서 나갈 길이 없으면 사용자는 GUI 안에 갇힌다 — 이 표면이 그 출구다.

const (
	// gitErrOperationMismatch 는 화면이 아는 작업과 저장소의 실제 작업이 다르다는
	// 것이다. 낡은 화면의 `rebase --abort` 가 남의 머지를 깨지 않게 한다.
	gitErrOperationMismatch = "operation_mismatch"
	// gitErrNoOperation 은 진행 중인 것이 없다는 것이다.
	gitErrNoOperation = "no_operation"
)

type gitOperationReq struct {
	Repo    string `json:"repo"`
	Kind    string `json:"kind"`
	Action  string `json:"action"`
	Confirm bool   `json:"confirm"`
}

// POST /api/git/operation — 계속 / 건너뛰기 / 중단.
//
// **중단은 파괴적이다** (`operation_abort`) — 그 작업 중 해결한 내용이 사라지고
// 되살릴 값이 없다. 그래서 `confirm:true` 없이는 실행하지 않는다 (FR-GIT-89).
// 계속·건너뛰기는 되돌릴 것이 없으므로 확인을 요구하지 않는다.
func (s *GitServer) apiGitOperation(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	var req gitOperationReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if req.Action == write.OpAbort && !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"중단은 그 작업 중 해결한 내용을 버린다: confirm:true 를 요구한다 (FR-GIT-89)")
		return
	}
	// 잘못된 조합은 실행 **전에** 답한다. gitApply 를 지나면 코드가 500 이 되고,
	// 클라이언트는 자기 요청이 틀렸다는 것을 알 수 없다.
	if _, err := write.OperationArgs(req.Kind, req.Action); err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	before, ok := s.gitStatusBefore(w, r, root)
	if !ok {
		return
	}
	// **화면이 아는 작업과 저장소의 작업이 같은지 본다.** 다르면 실행하지 않는다 —
	// 낡은 화면이 `rebase --abort` 를 보냈는데 저장소는 머지 중일 수 있고, 그때
	// git 은 exit 128 로만 답한다. 사용자는 무엇이 어긋났는지 알 수 없다.
	if cur := before.Operation.Kind; cur != req.Kind {
		code, name := http.StatusConflict, gitErrOperationMismatch
		if cur == "" {
			name = gitErrNoOperation
		}
		gitJSON(w, code, map[string]any{
			"error": name, "requested": req.Repo, "repo": root,
			"message": "진행 중인 작업이 " + operationLabel(cur) + " 입니다",
			"status":  before,
		})
		return
	}
	after, ok := s.gitApply(w, r, req.Repo, root, before, func(ctx context.Context) error {
		_, err := write.Operation(s.Git.Service(), ctx, root, req.Kind, req.Action)
		return err
	})
	if !ok {
		return
	}
	gitWriteOK(w, req.Repo, root, after, nil)
}

// operationLabel 은 사유 문구에 쓸 이름이다. 빈 값은 "없음"이며, 그것이 사용자가
// 읽어야 하는 사실이다 — 빈 문자열을 그대로 문장에 넣으면 문장이 끊긴다.
func operationLabel(kind string) string {
	if kind == "" {
		return "없음"
	}
	return kind
}
