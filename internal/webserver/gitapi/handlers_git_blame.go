package gitapi

import (
	"net/http"

	"dongminal/internal/webserver/domain/git/query"
)

// FR-GIT-276 — blame. 줄마다 어느 커밋에서 왔는지를 답한다.

// gitBlameRequested 는 클라이언트가 보낸 값 그대로다. 식별자는 (리포, 리비전,
// 경로) 다 — 되돌아오지 않으면 늦게 온 응답이 어느 파일의 것인지 가릴 수 없다
// (FR-GIT-54 의 stale 가드와 같은 규약).
type gitBlameRequested struct {
	Repo string `json:"repo"`
	Rev  string `json:"rev"`
	Path string `json:"path"`
}

type gitBlameResponse struct {
	Requested gitBlameRequested `json:"requested"`
	query.FileBlame
}

// GET /api/git/blame?repo=&rev=&path= — 파일 하나의 줄별 출처 (FR-GIT-276).
func (s *GitServer) apiGitBlame(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	req := gitBlameRequested{Repo: requested, Rev: q.Get("rev"), Path: q.Get("path")}
	if req.Path == "" {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "path 가 비었다")
		return
	}
	b, err := query.Blame(s.Git.Service(), r.Context(), query.BlameQuery{
		Repo: root, Rev: req.Rev, Path: req.Path,
	})
	if err != nil {
		gitError(w, err)
		return
	}
	// 해석된 루트가 요청의 자리를 대신하면 클라이언트는 응답과 자기 요청의 짝을
	// 맞출 수 없다.
	b.Repo = root
	gitJSON(w, http.StatusOK, gitBlameResponse{Requested: req, FileBlame: b})
}
