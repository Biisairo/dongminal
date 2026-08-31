package gitapi

import (
	"net/http"
	"net/url"
	"strconv"

	"dongminal/internal/webserver/domain/git/query"
)

// /api/git/log·/commit·/refs — 히스토리 조회 (GIT_SRS §3C FR-GIT-113·122·136~139).
//
// 셋 다 `requested` 를 에코한다 — stale 가드(FR-GIT-133·145)의 서버측 절반이며,
// 해석된 루트가 그 자리를 대신하면 클라이언트는 응답과 자기 요청의 짝을 맞출 수 없다.

// gitLogRequested 는 클라이언트가 보낸 값 그대로다. 식별자는 (리포, ref, 페이징,
// 정렬, 필터) 다 — 필터가 빠지면 뒤늦게 온 다른 필터의 응답을 자기 것으로 읽는다.
type gitLogRequested struct {
	Repo   string `json:"repo"`
	Ref    string `json:"ref"`
	Skip   int    `json:"skip"`
	Limit  int    `json:"limit"`
	Order  string `json:"order"`
	Author string `json:"author"`
	Since  string `json:"since"`
	Until  string `json:"until"`
	Path   string `json:"path"`
	Grep   string `json:"grep"`
	Reflog bool   `json:"reflog"`
}

type gitLogResponse struct {
	Requested gitLogRequested `json:"requested"`
	Repo      string          `json:"repo"`
	// Limit 은 실제로 쓰인 개수다. 상한으로 접힌 것을 알리지 않으면 클라이언트는
	// 자기가 요청한 만큼 받았다고 믿고 페이징을 어긋나게 계산한다 (FR-GIT-114).
	Limit   int            `json:"limit"`
	Commits []query.Commit `json:"commits"`
}

// GET /api/git/log?repo=&ref=&skip=&limit=&order=&author=&since=&until=&path=&grep=&reflog=
// — 커밋 목록 한 페이지 (FR-GIT-113·114·123·128·130·280).
func (s *GitServer) apiGitLog(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	skip, ok := gitCountParam(w, q, "skip")
	if !ok {
		return
	}
	limit, ok := gitCountParam(w, q, "limit")
	if !ok {
		return
	}
	reflog, ok := gitBoolParam(w, q, "reflog")
	if !ok {
		return
	}
	req := gitLogRequested{
		Repo: requested, Ref: q.Get("ref"), Skip: skip, Limit: limit, Order: q.Get("order"),
		Author: q.Get("author"), Since: q.Get("since"), Until: q.Get("until"),
		Path: q.Get("path"), Grep: q.Get("grep"), Reflog: reflog,
	}
	commits, err := query.Log(s.Git.Service(), r.Context(), query.LogQuery{
		Repo: root, Ref: req.Ref, Skip: req.Skip, Limit: req.Limit, Order: req.Order,
		Author: req.Author, Since: req.Since, Until: req.Until, Path: req.Path, Grep: req.Grep,
		Reflog: req.Reflog,
	})
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitLogResponse{
		Requested: req, Repo: root, Limit: query.LogLimit(req.Limit), Commits: commits,
	})
}

// gitCommitRequested 의 식별자는 (리포, 커밋 해시, 비교 부모) 다 (FR-GIT-145).
// 부모까지 실어야 머지 커밋에서 부모를 바꿨을 때 이전 응답을 폐기할 수 있다.
type gitCommitRequested struct {
	Repo   string `json:"repo"`
	Oid    string `json:"oid"`
	Parent int    `json:"parent"`
}

type gitCommitResponse struct {
	Requested gitCommitRequested `json:"requested"`
	Repo      string             `json:"repo"`
	query.CommitDetail
}

// GET /api/git/commit?repo=&oid=&parent=<n> — 커밋 하나의 상세 (FR-GIT-136·137·139).
func (s *GitServer) apiGitCommit(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	oid := q.Get("oid")
	if oid == "" {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "oid 인자가 없다")
		return
	}
	parent, ok := gitCountParam(w, q, "parent")
	if !ok {
		return
	}
	req := gitCommitRequested{Repo: requested, Oid: oid, Parent: parent}
	d, err := query.CommitDetailOf(s.Git.Service(), r.Context(), root, oid, parent)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitCommitResponse{Requested: req, Repo: root, CommitDetail: d})
}

type gitRefsRequested struct {
	Repo string `json:"repo"`
}

type gitRefsResponse struct {
	Requested gitRefsRequested `json:"requested"`
	Repo      string           `json:"repo"`
	Refs      []query.Ref      `json:"refs"`
}

// GET /api/git/refs?repo= — 로컬·원격·태그 (FR-GIT-122).
func (s *GitServer) apiGitRefs(w http.ResponseWriter, r *http.Request) {
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	refs, err := query.Refs(s.Git.Service(), r.Context(), root)
	if err != nil {
		gitError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, gitRefsResponse{Requested: gitRefsRequested{Repo: requested}, Repo: root, Refs: refs})
}

// gitCountParam 은 0 이상의 정수 인자를 읽는다. 값이 없으면 0 이다.
//
// 읽지 못한 값을 조용히 0 으로 낮추지 않는다 — skip 이 0 이 되면 추가 로드가 같은
// 페이지를 되풀이하고, 사용자는 목록이 늘지 않는 이유를 알 수 없다.
// gitBoolParam 은 토글 하나를 읽는다. 빈 값은 꺼짐이고, 모르는 값은 **거부한다** —
// 조용히 꺼진 것으로 낮추면 사용자는 켰다고 믿는 토글이 꺼진 목록을 본다.
func gitBoolParam(w http.ResponseWriter, q url.Values, name string) (bool, bool) {
	raw := q.Get(name)
	if raw == "" {
		return false, true
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, name+" 는 참·거짓이어야 한다: "+raw)
		return false, false
	}
	return v, true
}

func gitCountParam(w http.ResponseWriter, q url.Values, name string) (int, bool) {
	raw := q.Get(name)
	if raw == "" {
		return 0, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, name+" 는 0 이상의 정수여야 한다: "+raw)
		return 0, false
	}
	return n, true
}
