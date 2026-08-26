package server

import (
	"net/http"

	"dongminal/internal/webserver/domain/git"
)

// 묶음 Q — Console 탭 (GIT_UI_REVISION_SRS FR-GIT-218, 검증 V95).
//
// 기록 자체는 M1 부터 Recorder 가 담고 있었다 (FR-GIT-5). 여기서 정하는 것은
// **무엇을 내보내느냐** 다.

type gitRecordsRequested struct {
	Repo string `json:"repo"`
	N    int    `json:"n"`
}

type gitRecordsResponse struct {
	Requested gitRecordsRequested `json:"requested"`
	Repo      string              `json:"repo"`
	Records   []git.Record        `json:"records"`
	Total     int                 `json:"total"`
}

// GET /api/git/records?repo=<abs>&n=<int> — 그 리포에서 dongminal 이 실행한 git
// 명령의 기록. 최신이 앞이다 (FR-GIT-218).
//
// **리포로 거른다.** Git 창은 리포 하나에 매인 창이고, 다른 리포의 실행이 섞이면
// 이력이 아니라 잡음이다. 거르는 기준은 요청값이 아니라 rev-parse 로 확정한
// 루트다 (FR-GIT-62).
func (s *Server) apiGitRecords(w http.ResponseWriter, r *http.Request) {
	if s.Git == nil {
		gitUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	n, ok := gitCountParam(w, r.URL.Query(), "n")
	if !ok {
		return
	}

	// 보유분 전부를 받아 거른 뒤 자른다 — 먼저 자르면 다른 리포의 기록이 자리를
	// 차지해 그 리포의 이력이 조용히 짧아진다.
	all := s.Git.Service().Records(0)
	out := make([]git.Record, 0, len(all))
	for i := len(all) - 1; i >= 0; i-- { // Recent 는 최신이 마지막이다
		if all[i].Cwd != root {
			continue
		}
		// 자격증명은 내보내지 않는다 (FR-GIT-104, 보안 기준 S.1·S.2).
		out = append(out, all[i].Redacted())
	}
	total := len(out)
	if n > 0 && n < total {
		out = out[:n]
	}
	gitJSON(w, http.StatusOK, gitRecordsResponse{
		Requested: gitRecordsRequested{Repo: requested, N: n},
		Repo:      root,
		Records:   out,
		Total:     total,
	})
}
