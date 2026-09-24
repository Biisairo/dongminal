package worktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// RemoveSpec 은 정리 대상 하나다. Keep 이면 보존만 하고 보고한다.
type RemoveSpec struct {
	Repo   string
	Path   string
	Branch string
	Keep   bool
	// LockKey 는 repoLock 의 키 — common-dir 키다 (Spec.LockKey 와 같다).
	LockKey string
}

// Result 는 정리 한 건의 결말이다. Removed 가 false 면 Residue 가 반드시 있다.
type Result struct {
	Path    string `json:"path"`
	Branch  string `json:"branch,omitempty"`
	Removed bool   `json:"removed"`
	Residue string `json:"residue,omitempty"`
	Detail  string `json:"detail,omitempty"`
	// Err 는 repoLock 을 얻지 못한 사유다 (REPO_FIX 01 §5.6) — 대기 상한(ErrRepoBusy)·
	// 마감(core.ErrTimeout)·요청 이탈(core.ErrCanceled). 그때는 아무것도 하지 않았다.
	// 호출자가 응답 코드를 고를 수 있게 sentinel 을 그대로 둔다.
	Err error `json:"-"`
}

// Remove 는 정리 규칙 전부다 (FR-WKT-8).
//
//   - dirty 면 제거하지 않는다. 사용자 작업의 조용한 삭제는 금지다
//   - clean 이면 worktree 를 지우고 브랜치는 -d(머지된 것만) 로 지운다
//   - 지우지 못한 것은 잔여물로 보고한다 (FR-WKT-12)
//
// 오류를 반환하지 않고 Result 로 답하는 이유는, 정리가 **여러 건의 부분 성공**
// 이기 때문이다 — 하나가 남았다고 나머지를 포기하면 잔여물만 늘어난다.
func (m *Manager) Remove(ctx context.Context, s RemoveSpec) Result {
	res := Result{Path: s.Path, Branch: s.Branch}
	if err := m.checkPath(s.Path); err != nil {
		res.Residue, res.Detail = ResidueUnsafePath, err.Error()
		return res
	}
	if s.Repo != "" && filepath.Clean(s.Path) == filepath.Clean(s.Repo) {
		res.Residue, res.Detail = ResidueUnsafePath, "저장소 자신은 제거하지 않는다"
		return res
	}
	if s.Keep {
		res.Residue = ResidueKept
		return res
	}

	release, err := m.lock(ctx, s.LockKey, s.Repo)
	if err != nil {
		res.Residue, res.Detail, res.Err = ResidueRemoveFailed, err.Error(), err
		return res
	}
	defer release()

	if _, err := os.Stat(s.Path); errors.Is(err, os.ErrNotExist) {
		// 경로가 이미 없다 — 등록만 남았을 수 있으므로 정리하고 성공으로 본다.
		_, _ = m.git(ctx, s.Repo, "worktree", "prune")
		res.Removed = true
		m.deleteBranch(ctx, s, &res)
		return res
	}
	dirty, err := m.isDirty(ctx, s.Path)
	if err != nil {
		res.Residue, res.Detail = ResidueRemoveFailed, err.Error()
		return res
	}
	if dirty {
		res.Residue = ResidueDirty
		return res
	}
	if err := m.removeWithRetry(ctx, s); err != nil {
		// 조회·제거 실패를 "사라졌다"의 증거로 쓰지 않는다 — prune 뒤 실제로
		// 사라졌는지 재확인하고, 아니면 잔여물로 보고한다.
		_, _ = m.git(ctx, s.Repo, "worktree", "prune")
		if !m.gone(ctx, s.Repo, s.Path) {
			res.Residue, res.Detail = ResidueRemoveFailed, err.Error()
			return res
		}
	}
	res.Removed = true
	m.deleteBranch(ctx, s, &res)
	return res
}

// removeWithRetry 는 `git worktree remove` 를 **잠깐 되풀이한다** (FR-WKT-18).
//
// Windows 는 어느 프로세스의 현재 디렉터리이거나 열린 핸들이 있는 폴더를 지우지
// 못한다. 그런데 그 폴더를 붙들고 있는 것이 **대개 우리 자신**이다 — 이 서버는
// 핀된 자리를 쉬지 않고 관측하며 `git` 을 띄운다. 그러면 사용자가 제거를 눌러도
// "git 이 제거하지 못했습니다" 만 보고, 그 사유는 그의 것이 아니다(러너 실측).
//
// 관측의 틈은 짧고 주기적이므로 몇 번 되풀이하면 만난다. 끝내 안 되면 그때는
// 정직하게 실패다 — 잠금의 주인이 우리가 아닐 수 있고, 그 사실을 삼키면 안 된다.
//
// POSIX 에서는 첫 시도가 성공하므로 이 함수가 하는 일이 없다.
//
// 되풀이에는 **예산이 있고 ctx 로 끊긴다** (M8 `GO-12`). 이 함수는 호출자가
// `repoLock` 을 쥔 채 지나므로, 여기서 기다리는 시간은 같은 저장소의 다른
// worktree 조작 전부가 기다리는 시간이다. 종전에는 git 한 번이 상한(180초)까지
// 걸리면 여섯 번을 다 되풀이해 최악 18분을 잠근 채였다 — 되풀이는 관측의 짧은
// 틈을 만나기 위한 것이지 느린 git 을 기다리기 위한 것이 아니므로, 예산을 넘긴
// 실패는 그대로 실패다.
func (m *Manager) removeWithRetry(ctx context.Context, s RemoveSpec) error {
	start := time.Now()
	var err error
	for i := 0; i < removeRetryTries; i++ {
		if _, err = m.git(ctx, s.Repo, "worktree", "remove", s.Path); err == nil {
			return nil
		}
		if i == removeRetryTries-1 || time.Since(start) > removeRetryBudget {
			return err
		}
		gap := time.NewTimer(removeRetryGap)
		select {
		case <-ctx.Done():
			gap.Stop()
			return fmt.Errorf("%w (요청이 끊겨 되풀이를 접었다: %v)", err, ctx.Err())
		case <-gap.C:
		}
	}
	return err
}

// deleteBranch 는 머지된 브랜치만 지운다. 남으면 잔여물이다 — 사용자의 커밋을
// -D 로 날리는 것보다 남기는 편이 언제나 낫다. 호출자는 repoLock(s.Repo) 를
// 쥐고 있다 (FR-WKT-7, 개정).
func (m *Manager) deleteBranch(ctx context.Context, s RemoveSpec, res *Result) {
	if s.Repo == "" || validRef(s.Branch) != nil {
		return
	}
	if _, err := m.git(ctx, s.Repo, "branch", "-d", s.Branch); err != nil {
		if _, verr := m.git(ctx, s.Repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+s.Branch); verr == nil {
			res.Residue, res.Detail = ResidueBranchRetained, err.Error()
		}
	}
}

// isDirty reports whether the working tree has anything a person could lose —
// 추적되지 않는 파일도 포함한다. 호출자는 repoLock(path 의 repo) 를 쥐고 있다
// (FR-WKT-7, 개정).
func (m *Manager) isDirty(ctx context.Context, path string) (bool, error) {
	out, err := m.git(ctx, path, "status", "--porcelain")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(out) != "", nil
}

// gone confirms the path is no longer a registered worktree AND no longer on
// disk. 호출자는 repoLock(repo) 를 쥐고 있다 (FR-WKT-7, 개정).
//
// List 를 그대로 쓴다 — git worktree list --porcelain 을 다시 파싱하지 않는다
// (FR-GIT-246: worktree 의 git 실행·파싱은 이 패키지 안에서 한 곳으로 모은다,
// 두 벌로 두면 한쪽만 고쳐진다).
func (m *Manager) gone(ctx context.Context, repo, path string) bool {
	if _, err := os.Stat(path); err == nil {
		return false
	}
	entries, err := m.List(ctx, repo)
	if err != nil {
		return false // 확인할 수 없으면 사라졌다고 단정하지 않는다
	}
	for _, e := range entries {
		if e.Path == path {
			return false
		}
	}
	return true
}
