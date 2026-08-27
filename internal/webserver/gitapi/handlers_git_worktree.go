package gitapi

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/webserver/domain/worktree"
)

// /api/git/worktrees* — Worktrees 탭의 서버측 (GIT_REVIEW4_SRS §3.6.5, FR-WKT-13,
// FR-GIT-240~243·246).
//
// **worktree 의 git 실행은 전부 internal/webserver/domain/worktree 를 지난다**
// (FR-GIT-246, D12) — `readCommands`·`writeCommands` 의 교집합-금지 불변식
// (FR-GIT-95) 때문에 `worktree` 는 domain/git 의 어느 화이트리스트에도 들어갈 수
// 없다(한 하위 명령에 읽기(list)와 쓰기(add·remove)가 함께 있다). 그래서 아래 세
// 핸들러는 `s.Git`(domain/git)을 쓰지 않고 `s.UserWorktrees`(domain/worktree 의
// 두 번째 Manager, root=$DONGMINAL_HOME/git-worktrees)만 건드린다 — repo 경로를
// 실제 저장소 루트로 재확인하는 `gitResolveRepo` 만 예외인데, 그건 `rev-parse` 라
// 이미 domain/git 의 읽기 목록에 있는 일반 조회이지 worktree 실행이 아니다.

const gitErrWorktreeExists = "worktree_exists"

func gitWorktreesUnavailable(w http.ResponseWriter) {
	gitFail(w, http.StatusServiceUnavailable, gitErrUnavailable, "사용자 worktree 관리자가 구성되지 않았다")
}

// 소유 판정 (FR-GIT-240) — 경로만 본다. Run 것과 바깥 것을 여기서 가려내는 이유는
// FR-GIT-241 이 그 둘의 제거 진입점을 아예 막기 때문이다.
const (
	worktreeOwnerUser    = "user"
	worktreeOwnerRun     = "run"
	worktreeOwnerOutside = "outside"
)

func gitWorktreeOwner(path, userRoot, runRoot string) string {
	switch {
	case gitUnderRoot(path, userRoot):
		return worktreeOwnerUser
	case gitUnderRoot(path, runRoot):
		return worktreeOwnerRun
	default:
		return worktreeOwnerOutside
	}
}

// gitUnderRoot 는 checkPath(internal/webserver/domain/worktree/worktree.go:515,
// 529-531)와 **정확히 같은 뜻**이어야 한다 — root 가 비면(격리를 안 쓰는 서버) 어느
// 경로도 그 영역이 아니고, **root 자신도 그 영역이 아니다.** checkPath 는 root
// 자신을 "루트 자신"이라는 별도 사유로 거부한다(제거 대상이 아니다) — 여기서
// `clean==root` 를
// "안"으로 셌더니 UI 는 그 경로를 사용자 것으로 보여 remove 버튼을 붙이고, 서버는
// checkPath 에서 거부하는 어긋남이 있었다. 판정을 두 벌로 두면 어긋날 때
// 구멍이 생긴다는 것이 이 패키지 전체의 근거이므로, 여기서만 다르게 셀 이유가 없다.
func gitUnderRoot(path, root string) bool {
	if root == "" {
		return false
	}
	clean := filepath.Clean(path)
	return strings.HasPrefix(clean, root+string(filepath.Separator))
}

// gitWorktreeEntry 는 목록 한 줄의 응답 모양이다 (FR-GIT-240) — 경로·브랜치(또는
// detached)·소유·main 여부.
type gitWorktreeEntry struct {
	Path     string `json:"path"`
	Branch   string `json:"branch,omitempty"`
	Detached bool   `json:"detached"`
	Owner    string `json:"owner"`
	Main     bool   `json:"main"`
}

// GET /api/git/worktrees?repo=<abs> — 활성 리포의 worktree 전부다 (FR-GIT-240).
// 진실은 git worktree list 이므로 main worktree 도 포함한다.
func (s *GitServer) apiGitWorktrees(w http.ResponseWriter, r *http.Request) {
	if s.UserWorktrees == nil {
		gitWorktreesUnavailable(w)
		return
	}
	root, requested, ok := s.gitRepoParam(w, r)
	if !ok {
		return
	}
	entries, err := s.UserWorktrees.List(root)
	if err != nil {
		gitWorktreeError(w, err)
		return
	}
	userRoot := s.UserWorktrees.Root()
	out := make([]gitWorktreeEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, gitWorktreeEntry{
			Path:     e.Path,
			Branch:   e.Branch,
			Detached: e.Detached,
			Owner:    gitWorktreeOwner(e.Path, userRoot, s.RunWorktreeRoot),
			// e.Main 을 그대로 옮긴다 — "조회 경로와 같다"로 여기서 다시 판정하지
			// 않는다(V162). main worktree 여부는 porcelain 출력의 **순서**로만
			// 정해지고, 그 순서를 아는 것은 파싱하는 domain/worktree 뿐이다 — 여기서
			// 다시 판정을 세우면 그 사실을 두 곳에서 따로 알게 된다.
			Main: e.Main,
		})
	}
	gitJSON(w, http.StatusOK, map[string]any{
		"repo":      root,
		"requested": requested,
		"worktrees": out,
	})
}

// gitWorktreeCreateReq 는 생성의 본문이다 (FR-GIT-242) — 이름 + 대상 ref + (선택)
// 새 브랜치.
type gitWorktreeCreateReq struct {
	Repo      string `json:"repo"`
	Name      string `json:"name"`
	Ref       string `json:"ref"`
	NewBranch bool   `json:"newBranch"`
}

// POST /api/git/worktrees/create — 사용자 worktree 를 만든다 (FR-GIT-242).
//
// 이름·경로·브랜치 충돌은 실행 **전에** 답한다 — 클라이언트만 막으면 API 직접
// 호출이 그대로 우회한다(handlers_git_write.go 의 규약과 같다). **조용히 다른
// 경로를 고르지 않는다** — Run 영역은 uuid 파생이라 충돌이 구조적으로 없지만
// 사용자 영역은 사람이 고른 이름이라 충돌이 실제로 있고, 조용히 비켜가면
// "내가 만든 게 어디 갔지"가 된다.
func (s *GitServer) apiGitWorktreeCreate(w http.ResponseWriter, r *http.Request) {
	if s.UserWorktrees == nil {
		gitWorktreesUnavailable(w)
		return
	}
	var req gitWorktreeCreateReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if err := worktree.CheckName(req.Name); err != nil {
		gitFail(w, http.StatusBadRequest, gitErrRefName, gitTail(err.Error()))
		return
	}
	if strings.TrimSpace(req.Ref) == "" {
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, "ref 가 없다")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}

	bucket := worktree.RepoBucket(root)
	path := s.UserWorktrees.Path(bucket, req.Name)
	if _, err := os.Stat(path); err == nil {
		gitJSON(w, http.StatusConflict, map[string]any{
			"error":     gitErrWorktreeExists,
			"message":   "이미 있는 이름이다: " + req.Name,
			"requested": req.Repo, "repo": root, "path": path,
		})
		return
	}

	spec := worktree.Spec{Repo: root, Path: path, Base: req.Ref}
	if req.NewBranch {
		if s.UserWorktrees.BranchExists(root, req.Name) {
			gitJSON(w, http.StatusConflict, map[string]any{
				"error":     gitErrBranchExists,
				"message":   "로컬 브랜치 " + req.Name + " 가 이미 있다",
				"requested": req.Repo, "repo": root, "branch": req.Name,
			})
			return
		}
		spec.Branch = req.Name
	}

	if err := s.UserWorktrees.Create(spec); err != nil {
		gitWorktreeError(w, err)
		return
	}
	// `ok` 는 **클라이언트의 성공 판정**이다 — `panel.post` 가
	// `!!(r&&r.ok&&d&&d.ok)` 로 계산하므로 HTTP 200 만으로는 성공이 되지 않는다.
	// 다른 쓰기 핸들러가 이미 지키는 규약이다 (handlers_git_write.go).
	gitJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"repo": root, "requested": req.Repo,
		"path": spec.Path, "branch": spec.Branch,
	})
}

// gitWorktreeRemoveReq 는 제거의 본문이다 (FR-GIT-243). Confirm 은 파괴적 동작의
// 2단계 확인이다 — 기존 GitConfirm 규약(gitDiscardReq.Confirm 등)과 같다.
type gitWorktreeRemoveReq struct {
	Repo         string `json:"repo"`
	Path         string `json:"path"`
	DeleteBranch bool   `json:"deleteBranch"`
	Confirm      bool   `json:"confirm"`
}

// POST /api/git/worktrees/remove — 사용자 worktree 를 지운다 (FR-GIT-243).
//
// **"Run 것과 바깥 것은 제거할 수 없다"(FR-GIT-241)를 여기서 따로 판정하지
// 않는다.** UserWorktrees.Remove 가 지나는 checkPath 가 자기 root(사용자 영역)
// 밖의 모든 경로를 unsafe_path 로 거부한다 — Run 영역도 그 형제이므로 밖이다
// (FR-WKT-13). 소유 판정을 다시 구현하면 그 판정이 checkPath 와 어긋날 때 구멍이
// 생긴다.
func (s *GitServer) apiGitWorktreeRemove(w http.ResponseWriter, r *http.Request) {
	if s.UserWorktrees == nil {
		gitWorktreesUnavailable(w)
		return
	}
	var req gitWorktreeRemoveReq
	if !gitDecodeBody(w, r, &req) {
		return
	}
	if !req.Confirm {
		gitFail(w, http.StatusBadRequest, gitErrConfirmRequired,
			"worktree 제거는 확인을 요구한다: confirm:true (FR-GIT-243)")
		return
	}
	root, ok := s.gitResolveRepo(w, r, req.Repo)
	if !ok {
		return
	}
	// 지울 브랜치 이름은 클라이언트를 믿지 않는다 — 실제 목록에서 다시 찾는다.
	entries, err := s.UserWorktrees.List(root)
	if err != nil {
		gitWorktreeError(w, err)
		return
	}
	target := filepath.Clean(req.Path)
	var branch string
	found := false
	for _, e := range entries {
		if e.Path == target {
			found, branch = true, e.Branch
			break
		}
	}
	if !found {
		gitFail(w, http.StatusNotFound, gitErrNotFound, "이 저장소의 worktree 가 아니다: "+req.Path)
		return
	}
	if !req.DeleteBranch {
		// 브랜치를 함께 지우는 것은 별도 선택이며 기본이 아니다 (FR-GIT-243).
		branch = ""
	}
	res := s.UserWorktrees.Remove(worktree.RemoveSpec{Repo: root, Path: req.Path, Branch: branch})
	// `ok` 는 "요청을 처리했다" 이고 `removed` 는 "실제로 지웠다" 다 — 둘은 다르다.
	// 지우지 않은 경우(dirty)도 정상 처리이며 사유는 `residue` 가 싣는다. 여기서
	// `ok` 를 빼면 클라이언트가 그 사유를 읽는 분기에 들어오지 못한다.
	gitJSON(w, http.StatusOK, map[string]any{
		"ok":   true,
		"repo": root, "requested": req.Repo,
		"path": res.Path, "branch": res.Branch,
		"removed": res.Removed, "residue": res.Residue, "detail": res.Detail,
	})
}

// gitWorktreeError 는 domain/worktree 의 거부를 공용 규약의 코드로 옮긴다.
func gitWorktreeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, worktree.ErrUnsafeArgument):
		gitFail(w, http.StatusBadRequest, gitErrRefName, gitTail(err.Error()))
	case errors.Is(err, worktree.ErrUnsafePath):
		gitFail(w, http.StatusBadRequest, gitErrBadRequest, gitTail(err.Error()))
	case errors.Is(err, worktree.ErrNotRepo):
		gitFail(w, http.StatusNotFound, gitErrNotRepo, gitTail(err.Error()))
	case errors.Is(err, worktree.ErrGitMissing):
		gitFail(w, http.StatusServiceUnavailable, gitErrMissing, gitTail(err.Error()))
	default:
		gitFail(w, http.StatusInternalServerError, gitErrFailed, gitTail(err.Error()))
	}
}
