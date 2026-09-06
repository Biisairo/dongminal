package gitapi

import (
	"errors"
	"net/http"
	"path/filepath"

	"dongminal/internal/webserver/domain/submodule"
)

/*
/api/git/submodules* — Submodules 탭의 서버측 (UX_BATCH5_SRS 묶음 D, FR-SUB-1~5).

**서브모듈의 git 실행은 전부 internal/webserver/domain/submodule 을 지난다** —
worktree 와 같은 이유다 (D-9 정정): 두 허용 목록은 `argv[0]` 으로 판정하는데
`git submodule` 은 한 하위 명령에 읽기(status)와 쓰기(update·sync)가 함께 있어,
어느 목록에 넣어도 반대쪽이 함께 열린다 (FR-GIT-95 의 교집합-금지).

그래서 아래 핸들러는 `s.Git` 을 **조회에만** 쓴다 — `gitResolveRepo` 의 `rev-parse`
뿐이며, 그것은 이미 읽기 목록에 있는 일반 조회이지 서브모듈 실행이 아니다.
*/

// gitSubmoduleEntry 는 목록 한 줄의 응답 모양이다 (FR-SUB-1).
//
// `absPath` 를 서버가 계산한다 — 화면이 repo 와 상대경로를 이어 붙이면 구분자
// 규칙이 두 벌이 되고, Windows 에서 어긋난다.
type gitSubmoduleEntry struct {
	Path     string `json:"path"`
	AbsPath  string `json:"absPath"`
	OID      string `json:"oid"`
	State    string `json:"state"`
	Describe string `json:"describe,omitempty"`
}

func gitSubmodulesUnavailable(w http.ResponseWriter) {
	gitFail(w, http.StatusServiceUnavailable, gitErrUnavailable, "서브모듈 관리자가 구성되지 않았다")
}

// gitSubmoduleError 는 도메인 오류를 응답으로 옮긴다. 안전 가드의 거부와 실행
// 실패를 가른다 — 앞은 클라이언트가 잘못 보낸 것이고 뒤는 git 이 거부한 것이라
// 사용자가 할 일이 다르다.
func gitSubmoduleError(w http.ResponseWriter, err error) {
	if errors.Is(err, submodule.ErrUnsafePath) {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
		return
	}
	gitFail(w, http.StatusInternalServerError, gitErrFailed, gitTail(err.Error()))
}

// GET /api/git/submodules?repo=<abs> — 등록된 서브모듈 전부다 (FR-SUB-1).
//
// 서브모듈이 없는 저장소는 **빈 목록**이며 오류가 아니다 (FR-SUB-10).
func (s *GitServer) apiGitSubmodules(w http.ResponseWriter, r *http.Request) {
	if s.Submodules == nil {
		gitSubmodulesUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	entries, err := s.Submodules.List(root)
	if err != nil {
		gitSubmoduleError(w, err)
		return
	}
	out := make([]gitSubmoduleEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, gitSubmoduleEntry{
			Path:     e.Path,
			AbsPath:  filepath.Join(root, filepath.FromSlash(e.Path)),
			OID:      e.OID,
			State:    e.State,
			Describe: e.Describe,
		})
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"repo":       root,
		"requested":  requested,
		"submodules": out,
	})
}

// gitSubmoduleReq 는 두 쓰기의 공통 본문이다 (FR-SUB-4).
//
// `Path` 가 비면 저장소의 서브모듈 전부가 대상이다. `Confirm` 은 파괴적 조작의
// 규약이며, 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.
type gitSubmoduleReq struct {
	Repo      string `json:"repo"`
	Path      string `json:"path"`
	Init      bool   `json:"init"`
	Recursive bool   `json:"recursive"`
	Confirm   bool   `json:"confirm"`
}

/*
POST /api/git/submodules/update — 서브모듈을 등록된 커밋으로 옮긴다 (FR-SUB-4).

**파괴적이다** (FR-SUB-5). 서브모듈 안의 체크아웃이 바뀌며 커밋되지 않은 변경이
있으면 git 이 거부하거나 덮는다 — 그래서 `confirm` 을 요구한다. discard·clean 과
같은 규약이다.
*/
func (s *GitServer) apiGitSubmoduleUpdate(w http.ResponseWriter, r *http.Request) {
	if s.Submodules == nil {
		gitSubmodulesUnavailable(w)
		return
	}
	var req gitSubmoduleReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "confirm 이 없다")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	if err := s.Submodules.Update(root, req.Path, req.Init, req.Recursive); err != nil {
		gitSubmoduleError(w, err)
		return
	}
	// 상태가 바뀌었으므로 관측 캐시를 버린다 — 서브모듈의 체크아웃이 옮겨지면
	// 부모의 status 도 달라진다. 그러지 않으면 화면이 한 주기 동안 옛 상태를
	// 보인다 (쓰기 경로의 공통 규약, `handlers_git_write.go:250` 와 같다).
	s.Git.Invalidate(root)
	// **`ok` 를 싣는다.** 이 표면의 성공 판정은 HTTP 200 이 아니라 본문의 `ok` 다
	// (`panel-write.js:166`) — 부분 적용도 200 으로 오기 때문이다 (FR-GIT-73).
	// 빠뜨리면 화면이 성공을 실패로 읽고 확인창이 닫히지 않는다 (실측).
	gitJSON(w, http.StatusOK, map[string]any{"ok": true, "repo": root})
}

// POST /api/git/submodules/sync — `.gitmodules` 의 URL 을 `.git/config` 로 옮긴다.
//
// 체크아웃을 건드리지 않으므로 파괴적이지 않다 (FR-SUB-5) — 그래도 `confirm` 을
// 요구한다: 쓰기 표면의 규약을 조작마다 다르게 두면 어느 것이 무엇을 요구하는지
// 말할 수 없다.
func (s *GitServer) apiGitSubmoduleSync(w http.ResponseWriter, r *http.Request) {
	if s.Submodules == nil {
		gitSubmodulesUnavailable(w)
		return
	}
	var req gitSubmoduleReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "confirm 이 없다")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	if err := s.Submodules.Sync(root, req.Path); err != nil {
		gitSubmoduleError(w, err)
		return
	}
	gitJSON(w, http.StatusOK, map[string]any{"ok": true, "repo": root})
}
