package gitapi

import (
	"net/http"
	"strconv"

	"dongminal/internal/webserver/domain/git/core"
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
	Records   []core.Record       `json:"records"`
	Total     int                 `json:"total"`
	// after 를 준 요청에만 붙는다 — 없는 요청의 본문은 종전과 같다 (FR-OPT-0-3).
	*gitRecordsCursor
}

// gitRecordsCursor 는 증분 조회의 좌표다 (OPTIMIZE_REFACTOR_SRS FR-OPT-4-8). Seq 는
// 리포로 거르기 전의 전역 값이다 — 그 리포의 기록이 없던 회차에도 커서가 나아간다.
type gitRecordsCursor struct {
	LastSeq uint64 `json:"lastSeq"`
	// FirstSeq 는 링이 아직 들고 있는 가장 오래된 Seq 다. 클라이언트는 이것보다 앞의
	// 기록을 버린다 — 전량을 받던 때와 같은 목록이 남는다.
	FirstSeq uint64 `json:"firstSeq"`
	// Gap 이면 records 는 증분이 아니라 전량이다.
	Gap bool `json:"gap"`
	// Epoch 는 기록 링의 세대다. 클라이언트는 다음 물음에 `epoch=` 로 되돌려 준다 —
	// 서버가 다시 떠 세대가 바뀌었으면 Seq 가 커서를 넘어서도 Gap 이다.
	Epoch string `json:"epoch"`
}

// GET /api/git/records?repo=<abs>&n=<int>[&after=<seq>[&epoch=<e>]] — 그 리포에서
// dongminal 이 실행한 git 명령의 기록. 최신이 앞이다 (FR-GIT-218). after 를 주면 그
// Seq 뒤의 것만 보낸다 (FR-OPT-4-8).
//
// **리포로 거른다.** Git 창은 리포 하나에 매인 창이고, 다른 리포의 실행이 섞이면
// 이력이 아니라 잡음이다. 거르는 기준은 요청값이 아니라 rev-parse 로 확정한
// 루트다 (FR-GIT-62).
func (s *GitServer) apiGitRecords(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	n, ok := gitCountParam(w, r.URL.Query(), "n")
	if !ok {
		return
	}

	var cur *gitRecordsCursor
	var all []core.Record
	if q := r.URL.Query(); q.Has("after") {
		after, err := strconv.ParseUint(q.Get("after"), 10, 64)
		if err != nil {
			gitFail(w, http.StatusBadRequest, gitErrBadRequest, "after 는 0 이상의 정수여야 한다")
			return
		}
		var span core.RecordSpan
		all, span = s.Git.Service().RecordsSince(after, q.Get("epoch"))
		cur = &gitRecordsCursor{LastSeq: span.Last, FirstSeq: span.First, Gap: span.Gap, Epoch: span.Epoch}
	} else {
		// 보유분 전부를 받아 거른 뒤 자른다 — 먼저 자르면 다른 리포의 기록이 자리를
		// 차지해 그 리포의 이력이 조용히 짧아진다.
		all = s.Git.Service().Records(0)
	}
	out := make([]core.Record, 0, len(all))
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
		Requested:        gitRecordsRequested{Repo: requested, N: n},
		Repo:             root,
		Records:          out,
		Total:            total,
		gitRecordsCursor: cur,
	})
}
