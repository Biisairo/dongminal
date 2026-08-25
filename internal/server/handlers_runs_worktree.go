// 묶음 W — 격리의 서버 절반이다 (RUN_ORCHESTRATION_SRS §3.4).
//
// 격리는 **Run 단위 선택**이고 기본은 none 이다 (D-A). "독립 태스크·병렬 실행·
// 편의"는 격리 사유가 아니다 — dongminal 의 협업 토폴로지 일부는 파일 공유를
// 전제하기 때문이다.
//
// 이 파일이 저장소에서 파일을 지울 수 있는 유일한 접합점이다. 그래서 지우는
// 판단은 전부 internal/worktree 의 가드를 거치고, **무엇이 정리 대상인지**는
// Run 레코드만이 정한다 (FR-WKT-9).
package server

import (
	"errors"
	"fmt"
	"log"

	"dongminal/internal/run"
	"dongminal/internal/uuid"
	"dongminal/internal/worktree"
)

// errIsolationUnavailable 은 격리를 요청했는데 서버에 worktree 관리자가 없는
// 경우다. **none 으로 낮추지 않는다** (FR-WKT-11) — 낮추면 멤버들이 같은 트리를
// 공유한 채 병렬 작업을 시작하고 아무도 그 사실을 모른다.
var errIsolationUnavailable = errors.New("isolation_unavailable")

// runIsolation 은 격리 Run 시작에 필요한 것 전부다. Run 레코드가 생기기 **전에**
// 결정된다 — 경로가 run.short 에서 파생되므로 id 를 먼저 정해야 하고(FR-WKT-3),
// 생성이 실패하면 레코드가 아예 없어야 고아 Run 이 남지 않는다.
type runIsolation struct {
	ID       string
	Repo     string
	Base     string
	Worktree *run.Worktree
	spec     worktree.Spec // 롤백 대상 (per-run 일 때만)
}

// provisionRun 은 격리 Run 의 시작 준비다 (FR-WKT-1/2/5/11).
func (s *Server) provisionRun(iso run.Isolation, cwd, base string) (*runIsolation, error) {
	if iso == "" || iso == run.IsolationNone {
		return nil, nil
	}
	if s.Worktrees == nil {
		return nil, fmt.Errorf("%w: 이 서버에는 worktree 관리자가 없다", errIsolationUnavailable)
	}
	repo, err := s.Worktrees.Resolve(cwd, base)
	if err != nil {
		return nil, err
	}
	out := &runIsolation{ID: uuid.NewString(), Repo: repo.Root, Base: repo.Base}
	if iso != run.IsolationPerRun {
		return out, nil
	}
	// per-run 은 Run 전체가 트리 하나를 공유한다. 시작 시점에 만드는 이유는
	// 실패를 **여기서** 드러내기 위해서다 — 첫 멤버를 띄우고 나서 알게 되면
	// 이미 도구가 생성돼 있다.
	slug := run.PathSlug(out.ID)
	spec := worktree.Spec{
		Repo:   repo.Root,
		Path:   s.Worktrees.Path(slug, "run"),
		Branch: s.freeBranch(repo.Root, slug, "run", "run"),
		Base:   repo.Base,
	}
	if err := s.Worktrees.Create(spec); err != nil {
		return nil, err
	}
	out.spec = spec
	out.Worktree = &run.Worktree{Path: spec.Path, Branch: spec.Branch, Base: spec.Base}
	return out, nil
}

// rollbackRun 은 Run 레코드가 서지 못했을 때 방금 만든 트리를 되돌린다.
func (s *Server) rollbackRun(iso *runIsolation) {
	if iso == nil || iso.Worktree == nil || s.Worktrees == nil {
		return
	}
	log.Printf("[run] 격리 롤백 — 레코드 생성 실패: %s", iso.spec.Path)
	s.Worktrees.Rollback(iso.spec)
}

// memberIsolation 은 멤버 하나의 격리 준비다.
type memberIsolation struct {
	ID       string
	Worktree *run.Worktree
	spec     worktree.Spec
	created  bool
}

// provisionMember 는 멤버의 작업 트리를 정한다 (FR-WKT-1/3/4).
//
//   - none:       없다
//   - per-run:    Run 의 공유 트리를 그대로 받는다
//   - per-member: 멤버 전용 트리를 만든다. 경로는 uuid 파생이라 재사용되지 않는다
func (s *Server) provisionMember(rec run.Record, role string) (*memberIsolation, error) {
	switch rec.Isolation {
	case "", run.IsolationNone:
		return &memberIsolation{}, nil
	case run.IsolationPerRun:
		if rec.Worktree == nil {
			return nil, fmt.Errorf("%w: per-run Run 에 공유 트리가 없다", errIsolationUnavailable)
		}
		wt := *rec.Worktree
		return &memberIsolation{Worktree: &wt}, nil
	}
	if s.Worktrees == nil || rec.Repo == "" {
		return nil, fmt.Errorf("%w: 이 Run 의 저장소를 알 수 없다", errIsolationUnavailable)
	}
	id := uuid.NewString()
	// 경로 조각은 short 가 아니라 PathSlug 다 — short 는 uuid v7 의 타임스탬프
	// 상위 비트라 같은 기간의 Run·Member 끼리 겹친다 (run.PathSlug 주석).
	slug := run.PathSlug(id)
	spec := worktree.Spec{
		Repo:   rec.Repo,
		Path:   s.Worktrees.Path(run.PathSlug(rec.ID), slug),
		Branch: s.freeBranch(rec.Repo, run.PathSlug(rec.ID), role, slug),
		Base:   rec.Base,
	}
	if err := s.Worktrees.Create(spec); err != nil {
		return nil, err
	}
	return &memberIsolation{
		ID:       id,
		Worktree: &run.Worktree{Path: spec.Path, Branch: spec.Branch, Base: spec.Base},
		spec:     spec,
		created:  true,
	}, nil
}

// rollbackMember 는 멤버 등록이 거부됐을 때 방금 만든 트리를 되돌린다. 여기서만
// -D 가 쓰인다 — 방금 만든 것이라 사용자 작업이 없다는 것이 확실하다 (FR-WKT-8).
func (s *Server) rollbackMember(mi *memberIsolation) {
	if mi == nil || !mi.created || s.Worktrees == nil {
		return
	}
	log.Printf("[run] 격리 롤백 — 멤버 등록 실패: %s", mi.spec.Path)
	s.Worktrees.Rollback(mi.spec)
}

// freeBranch 는 충돌하지 않는 브랜치 이름을 고른다. 이미 있는 브랜치를 재사용하지
// 않는 이유는 경로 재사용을 막는 이유와 같다 (FR-WKT-4) — 남의 작업 위에 새 멤버를
// 앉히게 된다.
func (s *Server) freeBranch(repo, runShort, role, fallback string) string {
	name := worktree.Branch(runShort, role, fallback)
	if s.Worktrees == nil || !s.Worktrees.BranchExists(repo, name) {
		return name
	}
	return worktree.Branch(runShort, role+"-"+fallback, fallback)
}

// cleanupWorktrees 는 close 의 정리 규칙을 수행한다 (FR-WKT-8/9/12).
//
// 대상은 **Run 이 만든 것뿐**이다. 파일시스템을 훑지 않는다 — 사용자가 같은 루트
// 아래에 만든 트리를 구분할 방법이 없기 때문이다.
func (s *Server) cleanupWorktrees(rec run.Record, keep bool) []worktree.Result {
	targets := rec.WorktreeTargets()
	if len(targets) == 0 {
		return nil
	}
	out := make([]worktree.Result, 0, len(targets))
	if s.Worktrees == nil {
		// 지우지 못한 것은 조용히 남기지 않는다 (FR-WKT-12).
		for _, t := range targets {
			out = append(out, worktree.Result{
				Path: t.Path, Branch: t.Branch,
				Residue: worktree.ResidueRemoveFailed, Detail: "worktree 관리자가 없다",
			})
		}
		return out
	}
	for _, t := range targets {
		res := s.Worktrees.Remove(worktree.RemoveSpec{
			Repo: rec.Repo, Path: t.Path, Branch: t.Branch, Keep: keep,
		})
		if !res.Removed {
			log.Printf("[run] worktree 잔여물 run=%s path=%s residue=%s detail=%s",
				rec.Short, res.Path, res.Residue, res.Detail)
		}
		out = append(out, res)
	}
	marks := make([]run.WorktreeMark, 0, len(out))
	for _, r := range out {
		marks = append(marks, run.WorktreeMark{
			Path: r.Path, Removed: r.Removed, Residue: r.Residue, Detail: r.Detail,
		})
	}
	if err := s.Runs.MarkWorktrees(rec.ID, marks); err != nil {
		log.Printf("[run] 정리 결과 기록 실패 run=%s: %v", rec.Short, err)
	}
	return out
}
