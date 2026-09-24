package gitapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
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

const gitErrWorktreeExists = apierr.CodeWorktreeExists

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
	ctx, cancel := context.WithTimeout(r.Context(), core.PrePhaseTimeout)
	defer cancel()
	entries, err := s.UserWorktrees.List(ctx, root)
	if err != nil {
		gitError(w, err)
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
//
// **잡이다** (REPO_FIX 01 §5.2·5.6). 사전 단계: common 칸 확인 → repoLock(≤5s) →
// 충돌 판정 → 부모 디렉터리 생성 → 요청 확인 → 등록. 등록 전에 실패하면 repoLock 을
// 반납하고 이번에 만든 빈 부모 디렉터리를 지운다. 완료 처리가 config 두 건을 쓰고
// repoLock 을 반납한다(모든 결말).
//
//	이전 동작: 동기 — git 한 번 180s·취소 불가, 응답 {ok, path, branch}
//	새  동작: 200 {job}(kind worktree, common 칸). path·branch 는 잡의 result
//	이유:     큰 저장소의 체크아웃은 분 단위다 — 35s 에 끊긴 화면과 계속 도는 서버가 어긋났다
func (s *GitServer) apiGitWorktreeCreate(w http.ResponseWriter, r *http.Request) {
	var req gitWorktreeCreateReq
	t := s.beginServiceWrite(w, r, &req, s.UserWorktrees != nil, gitWorktreesUnavailable)
	if err := worktree.CheckName(req.Name); err != nil {
		t.rejectWith(http.StatusBadRequest, gitErrRefName, gitTail(err.Error()))
	}
	if strings.TrimSpace(req.Ref) == "" {
		t.rejectWith(http.StatusBadRequest, gitErrBadRequest, "ref 가 없다")
	}
	t.resolve(req.Repo)
	if t.stop() {
		return
	}
	keys, err := s.jobKeys(t.ctx(), t.root)
	if err != nil {
		t.reject(err)
		return
	}
	t.keys = keys
	if id, busy := s.exclusion().CommonBusy(keys.Common); busy {
		t.rejectWith(http.StatusConflict, gitErrJobBusy,
			"이 저장소에서 원격 작업("+id+")이 진행 중이다 — 끝난 뒤 다시 시도하라")
		return
	}
	release, err := worktree.LockRepo(t.ctx(), keys.Common, s.gitLockWait())
	if err != nil {
		t.reject(err)
		return
	}
	registered := false
	var made []string
	defer func() {
		if registered {
			return
		}
		release()
		gitRemoveMadeDirs(made)
	}()

	// 여기부터는 이 표면 고유의 충돌 판정이다 — 파이프라인이 대신할 수 없다.
	path := s.UserWorktrees.Path(worktree.RepoBucket(t.root), req.Name)
	if _, err := os.Stat(path); err == nil {
		t.rejectBody(http.StatusConflict, gitErrWorktreeExists,
			"이미 있는 이름이다: "+req.Name, map[string]any{"path": path})
		return
	}
	spec := worktree.Spec{Repo: t.root, Path: path, Base: req.Ref, LockKey: keys.Common}
	if req.NewBranch {
		if s.UserWorktrees.BranchExists(t.ctx(), t.root, req.Name) {
			t.rejectBody(http.StatusConflict, gitErrBranchExists,
				"로컬 브랜치 "+req.Name+" 가 이미 있다", map[string]any{"branch": req.Name})
			return
		}
		spec.Branch = req.Name
	}
	add, err := s.UserWorktrees.AddSpec(spec)
	if err != nil {
		t.reject(err)
		return
	}
	made, err = gitMkdirParents(filepath.Dir(path))
	if err != nil {
		t.reject(err)
		return
	}
	finish := jobs.OnFinish(func(ctx context.Context, jb *jobs.Job) {
		// ⑤ config(성공·루트 생존) → ⑥ repoLock 반납(항상) (§6.3).
		if jobSucceeded(jb) {
			if ctx.Err() == nil {
				s.UserWorktrees.Configure(ctx, spec)
			}
			jb.Result = &jobs.Result{Path: spec.Path, Branch: spec.Branch}
		}
		release()
	})
	t.launchJob(func(h *jobs.Jobs, k jobs.Keys) (*jobs.Job, error) {
		jb, err := h.StartUnguarded(t.root, k, "worktree", add.Argv, add.Reason, finish)
		registered = err == nil
		return jb, err
	}, nil)
}

// gitMkdirParents 는 dir 을 만들고 **이번에 새로 만든** 디렉터리를 바깥부터 준다 —
// 등록 전 실패에서 그것만 되돌린다. 이미 있던 것은 목록에 없다.
func gitMkdirParents(dir string) ([]string, error) {
	var missing []string
	for p := filepath.Clean(dir); ; p = filepath.Dir(p) {
		if _, err := os.Stat(p); err == nil {
			break
		}
		missing = append(missing, p)
		if filepath.Dir(p) == p {
			break
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return missing, nil
}

// gitRemoveMadeDirs 는 gitMkdirParents 가 만든 디렉터리를 안쪽부터 지운다. 비어 있지
// 않으면(그 사이 누군가 채웠다) os.Remove 가 거부하므로 남의 것을 지우지 않는다.
func gitRemoveMadeDirs(made []string) {
	for _, p := range made {
		_ = os.Remove(p)
	}
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
//
// **요청 worktree 의 칸·뮤텍스는 보지 않는다** (REPO_FIX 01 §5.6) — `git worktree
// remove` 는 대상 작업 트리와 `$GIT_COMMON_DIR/worktrees/<n>` 만 바꾼다. 순서:
// ① worktree 잡 확인 → 목록으로 대상 확정 → 대상 index 칸 확인 → ② 대상 toplevel
// 뮤텍스(≤5s) → ③ 대상 index 칸 재확인 → ④ 요청 확인 → ⑤ 쓰기 단계(180s, 루트
// 파생): repoLock 대기 + Remove. common-dir 잠금(stash)은 쓰지 않는다.
//
//	이전 동작: 배타 없음 — 대상 worktree 에서 커밋이 도는 중에도 지웠다
//	새  동작: 대상의 잡·동기 쓰기가 있으면 409, repoLock 대기가 마감에 걸리면 504
//	이유:     진행 중인 쓰기의 작업 트리를 지우지 않는다
func (s *GitServer) apiGitWorktreeRemove(w http.ResponseWriter, r *http.Request) {
	var req gitWorktreeRemoveReq
	t := s.beginServiceWrite(w, r, &req, s.UserWorktrees != nil, gitWorktreesUnavailable)
	t.requireConfirm(true, req.Confirm,
		"worktree 제거는 확인을 요구한다: confirm:true (FR-GIT-243)")
	t.resolve(req.Repo)
	if t.stop() {
		return
	}
	keys, err := s.jobKeys(t.ctx(), t.root)
	if err != nil {
		t.reject(err)
		return
	}
	x := s.exclusion()
	if id, busy := x.CommonBusy(keys.Common); busy && s.gitJobKind(id) == "worktree" {
		t.rejectWith(http.StatusConflict, gitErrJobBusy,
			"이 저장소에서 worktree 작업("+id+")이 진행 중이다 — 끝난 뒤 다시 시도하라")
		return
	}

	// 지울 브랜치 이름은 클라이언트를 믿지 않는다 — 실제 목록에서 다시 찾는다.
	entries, err := s.UserWorktrees.List(t.ctx(), t.root)
	if err != nil {
		t.reject(err)
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
		t.rejectWith(http.StatusNotFound, gitErrNotFound,
			"이 저장소의 worktree 가 아니다: "+req.Path)
		return
	}
	if !req.DeleteBranch {
		// 브랜치를 함께 지우는 것은 별도 선택이며 기본이 아니다 (FR-GIT-243).
		branch = ""
	}

	// 밖에서 지운 worktree 도 키가 나온다 (§5.1 — 존재하는 조상까지 푼다).
	top := core.ExclusionKey(target)
	if t.targetIndexBusy(x, top) {
		return
	}
	unlock, err := x.LockTop(t.r.Context(), top, s.gitLockWait())
	if err != nil {
		t.reject(err)
		return
	}
	defer unlock()
	if t.targetIndexBusy(x, top) {
		return
	}

	var res worktree.Result
	ran, err := t.writeWithin(s.gitManagerWrite(), func(ctx context.Context) error {
		res = s.UserWorktrees.Remove(ctx, worktree.RemoveSpec{
			Repo: t.root, Path: req.Path, Branch: branch, LockKey: keys.Common,
		})
		return res.Err
	})
	if !ran {
		return
	}
	if err != nil {
		// repoLock 을 얻지 못했다 — 아무것도 지우지 않았다. 마감이면 504, 종료면 503.
		t.reject(err)
		return
	}
	// `ok` 는 "요청을 처리했다" 이고 `removed` 는 "실제로 지웠다" 다 — 둘은 다르다.
	// 지우지 않은 경우(dirty)도 정상 처리이며 사유는 `residue` 가 싣는다. 그래서
	// 이 자리는 `rejectBody` 가 아니라 `okPlain` 이다.
	t.okPlain(map[string]any{
		"path": res.Path, "branch": res.Branch,
		"removed": res.Removed, "residue": res.Residue, "detail": res.Detail,
	})
}

// targetIndexBusy 는 **대상** worktree 의 index 칸을 쥔 잡이 있으면 409 job_busy 다.
func (t *gitWrite) targetIndexBusy(x *jobs.Exclusion, top string) bool {
	id, busy := x.IndexBusy(top)
	if busy {
		t.rejectWith(http.StatusConflict, gitErrJobBusy,
			"지우려는 worktree 에서 작업("+id+")이 진행 중이다 — 끝난 뒤 다시 시도하라")
	}
	return busy
}

// gitJobKind 는 진행 중인 잡의 kind 다. 허브가 없거나 이미 치워졌으면 빈 문자열이다.
func (s *GitServer) gitJobKind(id string) string {
	if s.Git == nil {
		return "" // 허브는 Git 이 있어야 선다 — 없으면 도는 잡도 없다
	}
	if jb, ok := s.jobsHub().Get(id); ok {
		return jb.Kind
	}
	return ""
}
