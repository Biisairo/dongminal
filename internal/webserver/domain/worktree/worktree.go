// Package worktree 는 Run 격리의 파일시스템 절반이다 (RUN_ORCHESTRATION_SRS 묶음 W).
//
// **저장소에서 파일시스템을 파괴할 수 있는 유일한 경로다.** 그래서 이 패키지의
// 규칙은 대부분 "무엇을 하지 않는가"로 되어 있다 — dirty 트리를 지우지 않고
// (FR-WKT-8), 등록 범위 밖을 건드리지 않으며 (FR-WKT-9/10), 지우지 못한 것을
// 조용히 넘기지 않는다 (FR-WKT-12).
//
// 이 패키지는 Run 을 모른다. 경로·브랜치를 무엇에서 파생할지는 호출자가 정하고,
// 여기 있는 것은 git 조작과 그 안전 가드뿐이다.
package worktree

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 거부 사유는 열거한다 — 무엇이 위험했는지 호출자가 구분할 수 있어야 한다.
var (
	ErrGitMissing     = errors.New("git_missing")
	ErrNotRepo        = errors.New("not_a_git_repo")
	ErrUnsafeArgument = errors.New("unsafe_argument")
	ErrUnsafePath     = errors.New("unsafe_path")
)

// 잔여물 사유 (FR-WKT-12). 정리하지 못한 자원은 반드시 이 중 하나로 보고된다.
const (
	ResidueDirty          = "dirty"           // 사용자 작업이 있다 — 지우지 않는다
	ResidueKept           = "kept"            // --keep-worktrees
	ResidueUnsafePath     = "unsafe-path"     // 안전 가드가 거부했다
	ResidueRemoveFailed   = "remove-failed"   // git 이 제거하지 못했다
	ResidueBranchRetained = "branch-retained" // 트리는 지웠으나 브랜치가 남았다
)

// opTimeout 은 git 한 번의 상한이다. 큰 저장소의 체크아웃이 분 단위라는 것이
// 참조 구현의 전제이고(WORKTREE_ADD_TIMEOUT_MS 기본 180초), 무한 대기는
// 조정자를 영구히 멈추게 한다.
const opTimeout = 180 * time.Second

// Runner 는 git 한 번이다. 테스트가 직렬화·실패 경로를 결정적으로 관찰할 수
// 있도록 주입 가능하게 둔다.
type Runner func(dir string, args ...string) (string, error)

// Manager 는 $DONGMINAL_HOME/worktrees 아래만을 자기 영역으로 삼는다.
type Manager struct {
	root string
	git  Runner
}

// repoLocksMu 와 repoLocks 는 worktree 생성·제거의 직렬화 단위다 (FR-WKT-7, 개정).
//
// **개정 사실**: 이전에는 Manager 의 인스턴스 필드(mu)가 이 자리였다. 근거는 지금도
// 같다 — git worktree 가 저장소의 공용 common-dir 를 건드리므로 병렬 팬아웃에서
// 경합한다. 근거는 **저장소**를 말하는데 구현은 **인스턴스**를 잠갔다 — Manager 가
// 하나뿐이던 동안은(생성 지점이 cmd/dongminal/main.go 하나) 둘이 우연히 같았을
// 뿐이다. I7 이 사용자 영역용 두 번째 Manager 를 두면서 그 우연이 깨진다: 두
// 인스턴스가 같은 저장소를 대상으로 해도 각자의 mu 만 잠가 경합이 그대로 열린다
// (D13). 그래서 잠금을 인스턴스 밖, 패키지 전역으로 옮기고 저장소 경로로 키를
// 잡는다 — 몇 개의 Manager 가 있든 같은 저장소를 대상으로 하면 같은 잠금을 문다.
//
// 저장소별 잠금은 지우지 않는다. 저장소 수는 사람이 열거나 핀한 리포 수준이라
// 무한히 늘지 않고(§ 세션당 수십 개 규모), sync.Mutex 하나(포인터+8바이트)를 그
// 저장소가 살아있는 동안 들고 있는 비용은 무시할 만하다. TTL 이나 참조 카운팅으로
// 정리하면 "언제 지워도 안전한가"라는 새 판단이 필요해지고, 그 판단이 틀리면 서로
// 다른 잠금이 같은 저장소를 가리키게 된다 — 그 위험이 무한정 늘지 않는 맵을 그냥
// 두는 비용보다 크다.
var (
	repoLocksMu sync.Mutex
	repoLocks   = map[string]*sync.Mutex{}
)

// repoLock 은 정규화한 저장소 경로의 잠금을 돌려준다 (FR-WKT-7, 개정).
//
// **정규화는 여기서 한다** — 호출자가 Resolve 의 canonical 값을 그대로 넘긴다는
// 관례에 기대지 않는다. Manager 가 하나뿐일 때는 인스턴스 자체가 경계였으니 이
// 관례가 어긋날 자리가 없었지만, 둘이 되면 그 관례가 양쪽 모두에서 지켜져야 하고
// 한쪽만 어긋나도(트레일링 슬래시 하나로도) 잠금이 조용히 갈라진다.
//
// filepath.Clean 만 쓴다 — symlink 는 따라가지 않는다. 심볼릭 링크를 실제로
// 풀려면 stat 이 필요한데, 그러면 존재하지 않는 경로(테스트의 가짜 저장소,
// Rollback 이 이미 지워진 대상을 다시 가리키는 경우)에서 판정이 흔들린다. 유일한
// 프로덕션 호출자(httpapi)는 이미 Resolve 가 `git rev-parse --show-toplevel` 로
// 심볼릭 링크를 푼 값을 그대로 넘기므로, 여기서는 표기 차이(트레일링 슬래시 등)만
// 바로잡으면 충분하다.
func repoLock(repo string) *sync.Mutex {
	key := filepath.Clean(repo)
	repoLocksMu.Lock()
	defer repoLocksMu.Unlock()
	l, ok := repoLocks[key]
	if !ok {
		l = &sync.Mutex{}
		repoLocks[key] = l
	}
	return l
}

type Option func(*Manager)

// WithRunner replaces the git invoker.
func WithRunner(r Runner) Option { return func(m *Manager) { m.git = r } }

func New(root string, opts ...Option) *Manager {
	// 루트는 반드시 절대 경로다 — 안전 가드가 "이 경로가 루트 아래인가"를
	// 문자열로 판정하므로, 상대 경로 루트는 모든 판정을 무의미하게 만든다.
	clean := filepath.Clean(root)
	if abs, err := filepath.Abs(clean); err == nil {
		clean = abs
	}
	// **심볼릭 링크를 여기서 푼다** (FR-WKT-13 전제, V163). `git worktree list`
	// 는 항상 realpath 를 보고하는데, checkPath·gitUnderRoot(gitapi) 는 문자열
	// prefix 로만 판정한다. 데이터 디렉터리 자체가 symlink 경유면(macOS
	// `/tmp`→`/private/tmp` 등) 그 판정이 영원히 어긋난다 — 사용자 것도 Run 것도
	// 전부 영역 밖으로 보이고, 정당한 제거가 unsafe_path 로 거부된다. **여기 한
	// 곳에서 풀어야** Path·checkPath·gone·Root 가 전부 한 번에 맞는다 — 판정하는
	// 자리마다 각자 풀면 한 곳이 빠질 수 있고, 그 한 곳이 보호 전체를 여는 자리가
	// 될 수 있다.
	clean = resolveSymlinksPrefix(clean)
	m := &Manager{root: clean, git: execGit}
	for _, o := range opts {
		o(m)
	}
	return m
}

// resolveSymlinksPrefix 는 p 를 realpath 로 만든다. **p 자신은 아직 없을 수 있다**
// (첫 실행 — worktrees 디렉터리는 첫 worktree 를 만들 때 비로소 생긴다,
// Create:MkdirAll 참고). filepath.EvalSymlinks 는 없는 경로에서 실패하므로,
// **존재하는 가장 깊은 조상까지만 풀고 나머지 조각을 그대로 이어 붙인다** — 그러면
// 아직 없는 경로에서도 판정이 흔들리지 않는다.
func resolveSymlinksPrefix(p string) string {
	dir := p
	var tail []string
	for {
		resolved, err := filepath.EvalSymlinks(dir)
		if err == nil {
			return filepath.Join(append([]string{resolved}, tail...)...)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			// 파일시스템 루트까지 왔는데도 못 풀었다 — 포기하고 원본을 돌려준다.
			// (권한 문제 등 EvalSymlinks 가 항상 실패하는 드문 환경.)
			return p
		}
		tail = append([]string{filepath.Base(dir)}, tail...)
		dir = parent
	}
}

func (m *Manager) Root() string { return m.root }

func execGit(dir string, args ...string) (string, error) {
	bin, err := exec.LookPath("git")
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrGitMissing, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		return text, fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, text)
	}
	return text, nil
}

// Repo 는 조정자 cwd 에서 확정한 저장소와 base 다.
type Repo struct {
	Root string `json:"root"`
	Base string `json:"base"`
}

// Resolve 는 격리 Run 이 설 수 있는지 판정한다 (FR-WKT-5/11).
//
// 실패는 **명확한 오류**여야 한다. 조용히 none 으로 낮추면 멤버들이 같은 트리를
// 공유한 채로 병렬 작업을 시작하고, 그 사실을 아무도 모른다.
func (m *Manager) Resolve(cwd, base string) (Repo, error) {
	if strings.TrimSpace(cwd) == "" {
		return Repo{}, fmt.Errorf("%w: 조정자의 cwd 를 알 수 없다", ErrNotRepo)
	}
	if !filepath.IsAbs(cwd) {
		return Repo{}, fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", ErrNotRepo, cwd)
	}
	if base != "" {
		if err := validRef(base); err != nil {
			return Repo{}, err
		}
	}
	top, err := m.git(cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		if errors.Is(err, ErrGitMissing) {
			return Repo{}, err
		}
		return Repo{}, fmt.Errorf("%w: %s 는 git 저장소가 아니다", ErrNotRepo, cwd)
	}
	// git 출력은 OS 형태로 옮겨 담는다 — parseWorktreeList 와 같은 이유다
	// (FR-WTP-3). Repo.Root 는 이후 경로 비교·조립에 전부 쓰인다.
	top = normalizeGitPath(strings.TrimSpace(top))
	if top == "" {
		return Repo{}, fmt.Errorf("%w: %s 는 git 저장소가 아니다", ErrNotRepo, cwd)
	}
	if base == "" {
		// FR-WKT-5: 기본 base 는 조정자 cwd 의 HEAD 다. 이름으로 잡아 두는 이유는
		// "이 브랜치가 무엇에서 갈라졌나"를 사람이 읽을 수 있어야 하기 때문이며,
		// 분리 HEAD 면 이름이 없으므로 커밋으로 떨어진다.
		name, nerr := m.git(top, "rev-parse", "--abbrev-ref", "HEAD")
		if nerr != nil {
			return Repo{}, fmt.Errorf("%w: HEAD 를 확인할 수 없다 (커밋이 없는 저장소인가): %v", ErrNotRepo, nerr)
		}
		base = strings.TrimSpace(name)
		if base == "HEAD" || base == "" {
			sha, serr := m.git(top, "rev-parse", "HEAD")
			if serr != nil {
				return Repo{}, fmt.Errorf("%w: HEAD 를 확인할 수 없다: %v", ErrNotRepo, serr)
			}
			base = strings.TrimSpace(sha)
		}
	} else if _, verr := m.git(top, "rev-parse", "--verify", "--quiet", base+"^{commit}"); verr != nil {
		return Repo{}, fmt.Errorf("%w: base 를 찾을 수 없다: %q", ErrUnsafeArgument, base)
	}
	return Repo{Root: top, Base: base}, nil
}

// Spec 은 worktree 하나의 생성 인자다.
type Spec struct {
	Repo   string `json:"repo"`
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Base   string `json:"base"`
}

// Create 는 worktree 를 만든다 (FR-WKT-2).
//
//	git worktree add --no-track -b <branch> <path> [<base>]
//
// --no-track 이 핵심이다 — base 의 upstream 을 물려받으면 push 전에 git status
// 가 "behind by N" 을 오보한다. 대신 push.autoSetupRemote 를 걸어 첫 push 가
// upstream 을 만들게 한다. 이 두 config 는 best-effort 이며 실패해도 롤백하지
// 않는다 — worktree 자체는 이미 쓸 수 있는 상태다.
//
// **Branch 가 비면 새 브랜치를 만들지 않는다** (FR-GIT-242) — `Base` 를 그대로
// 체크아웃한다: `git worktree add <path> <base>`. 사용자 worktree 생성에서
// "새 브랜치를 만들 것인지"가 선택이기 때문에 생긴 갈래이며, Run 격리는 항상
// Branch 를 채우므로(worktree.Branch 의 fallback 이 절대 빈 문자열을 주지 않는다)
// 그 경로는 이 분기를 타지 않는다 — 기존 동작이 그대로 유지된다.
func (m *Manager) Create(s Spec) error {
	if s.Branch != "" {
		if err := validRef(s.Branch); err != nil {
			return err
		}
	}
	if s.Base != "" {
		if err := validRef(s.Base); err != nil {
			return err
		}
	}
	if s.Branch == "" && s.Base == "" {
		return fmt.Errorf("%w: branch 나 base 중 하나는 있어야 한다", ErrUnsafeArgument)
	}
	if err := m.checkPath(s.Path); err != nil {
		return err
	}
	if strings.TrimSpace(s.Repo) == "" {
		return fmt.Errorf("%w: repo 가 비었다", ErrNotRepo)
	}

	lock := repoLock(s.Repo)
	lock.Lock()
	defer lock.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.Path), 0o755); err != nil {
		return err
	}
	var args []string
	if s.Branch != "" {
		args = []string{"worktree", "add", "--no-track", "-b", s.Branch, s.Path}
		if s.Base != "" {
			args = append(args, s.Base)
		}
	} else {
		args = []string{"worktree", "add", s.Path, s.Base}
	}
	if _, err := m.git(s.Repo, args...); err != nil {
		return err
	}
	_, _ = m.git(s.Path, "config", "push.autoSetupRemote", "true")
	if s.Branch != "" && s.Base != "" {
		// 생성 base 를 repo config 에 영속한다 — 나중에 "이 브랜치는 무엇에서
		// 갈라져 나왔나"를 물을 유일한 근거다.
		_, _ = m.git(s.Repo, "config", "branch."+s.Branch+".base", s.Base)
	}
	return nil
}

// BranchExists reports whether refs/heads/<branch> is already there. 이름 충돌
// 시 호출자가 다른 이름을 고르라고 두는 것이 목적이며, 여기서 남의 브랜치를
// 재사용하지 않는다.
func (m *Manager) BranchExists(repo, branch string) bool {
	if repo == "" || validRef(branch) != nil {
		return false
	}
	lock := repoLock(repo)
	lock.Lock()
	defer lock.Unlock()
	_, err := m.git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil
}

// Rollback 은 **생성 실패의 되돌리기 전용**이다 (FR-WKT-8).
//
// 여기서만 -D 를 쓴다 — 방금 만든 것이 등록에 실패한 경우라 사용자 작업이 없다는
// 것이 확실하기 때문이다. 정리 경로(Remove)는 절대 -D 를 쓰지 않는다.
func (m *Manager) Rollback(s Spec) {
	if m.checkPath(s.Path) != nil || strings.TrimSpace(s.Repo) == "" {
		return
	}
	lock := repoLock(s.Repo)
	lock.Lock()
	defer lock.Unlock()
	_, _ = m.git(s.Repo, "worktree", "remove", "--force", s.Path)
	_, _ = m.git(s.Repo, "worktree", "prune")
	if validRef(s.Branch) == nil {
		_, _ = m.git(s.Repo, "branch", "-D", s.Branch)
	}
	if _, err := os.Stat(s.Path); err == nil {
		_ = os.RemoveAll(s.Path)
	}
}

// RemoveSpec 은 정리 대상 하나다. Keep 이면 보존만 하고 보고한다.
type RemoveSpec struct {
	Repo   string
	Path   string
	Branch string
	Keep   bool
}

// Result 는 정리 한 건의 결말이다. Removed 가 false 면 Residue 가 반드시 있다.
type Result struct {
	Path    string `json:"path"`
	Branch  string `json:"branch,omitempty"`
	Removed bool   `json:"removed"`
	Residue string `json:"residue,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

// Remove 는 정리 규칙 전부다 (FR-WKT-8).
//
//   - dirty 면 제거하지 않는다. 사용자 작업의 조용한 삭제는 금지다
//   - clean 이면 worktree 를 지우고 브랜치는 -d(머지된 것만) 로 지운다
//   - 지우지 못한 것은 잔여물로 보고한다 (FR-WKT-12)
//
// 오류를 반환하지 않고 Result 로 답하는 이유는, 정리가 **여러 건의 부분 성공**
// 이기 때문이다 — 하나가 남았다고 나머지를 포기하면 잔여물만 늘어난다.
func (m *Manager) Remove(s RemoveSpec) Result {
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

	lock := repoLock(s.Repo)
	lock.Lock()
	defer lock.Unlock()

	if _, err := os.Stat(s.Path); errors.Is(err, os.ErrNotExist) {
		// 경로가 이미 없다 — 등록만 남았을 수 있으므로 정리하고 성공으로 본다.
		_, _ = m.git(s.Repo, "worktree", "prune")
		res.Removed = true
		m.deleteBranch(s, &res)
		return res
	}
	dirty, err := m.isDirty(s.Path)
	if err != nil {
		res.Residue, res.Detail = ResidueRemoveFailed, err.Error()
		return res
	}
	if dirty {
		res.Residue = ResidueDirty
		return res
	}
	if _, err := m.git(s.Repo, "worktree", "remove", s.Path); err != nil {
		// 조회·제거 실패를 "사라졌다"의 증거로 쓰지 않는다 — prune 뒤 실제로
		// 사라졌는지 재확인하고, 아니면 잔여물로 보고한다.
		_, _ = m.git(s.Repo, "worktree", "prune")
		if !m.gone(s.Repo, s.Path) {
			res.Residue, res.Detail = ResidueRemoveFailed, err.Error()
			return res
		}
	}
	res.Removed = true
	m.deleteBranch(s, &res)
	return res
}

// deleteBranch 는 머지된 브랜치만 지운다. 남으면 잔여물이다 — 사용자의 커밋을
// -D 로 날리는 것보다 남기는 편이 언제나 낫다. 호출자는 repoLock(s.Repo) 를
// 쥐고 있다 (FR-WKT-7, 개정).
func (m *Manager) deleteBranch(s RemoveSpec, res *Result) {
	if s.Repo == "" || validRef(s.Branch) != nil {
		return
	}
	if _, err := m.git(s.Repo, "branch", "-d", s.Branch); err != nil {
		if _, verr := m.git(s.Repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+s.Branch); verr == nil {
			res.Residue, res.Detail = ResidueBranchRetained, err.Error()
		}
	}
}

// isDirty reports whether the working tree has anything a person could lose —
// 추적되지 않는 파일도 포함한다. 호출자는 repoLock(path 의 repo) 를 쥐고 있다
// (FR-WKT-7, 개정).
func (m *Manager) isDirty(path string) (bool, error) {
	out, err := m.git(path, "status", "--porcelain")
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
func (m *Manager) gone(repo, path string) bool {
	if _, err := os.Stat(path); err == nil {
		return false
	}
	entries, err := m.List(repo)
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

// Entry 는 `git worktree list` 한 줄이다 (FR-GIT-240). 화면이 보일 최소 정보만
// 남긴다 — 경로·브랜치(또는 detached)·main 여부. 소유(사용자/Run/바깥) 판정은 이
// 패키지가 Run 을 모르므로(패키지 doc 참고) 호출자의 일이다.
type Entry struct {
	Path     string
	Branch   string
	Detached bool
	// Main 은 이 항목이 git 의 main worktree(저장소를 clone·init 한 자리)인지다
	// (V162). **파싱 순서에서 낸다** — "조회에 쓴 경로와 같다"로 판정하지 않는다.
	// 후자는 main worktree 를 링크드 worktree 에서 조회하면(예: 사용자가 그 링크드
	// worktree 를 활성 리포로 열고 다시 조회하면) 판정이 조회 대상을 따라 옮겨간다 —
	// "main" 배지가 탐색 위치를 따라다니는 결함이었다.
	Main bool
}

// List 는 repo 의 worktree 전부를 `git worktree list --porcelain` 그대로 준다
// (FR-GIT-240) — main worktree 도 포함한다(그 명령이 포함하므로, 빼면 목록이
// 진실과 달라진다).
//
// **이 저장소에서 그 명령을 실행하는 자리는 여기 하나뿐이다** (FR-GIT-246) — gone
// 도 이 함수를 부른다. domain/git 의 읽기 화이트리스트를 넓히지 않는 이유이기도
// 하다: worktree 는 한 하위 명령에 읽기(list)와 쓰기(add·remove)가 함께 있어
// 그 목록들의 교집합-금지 불변식(FR-GIT-95)과 맞지 않는다.
func (m *Manager) List(repo string) ([]Entry, error) {
	out, err := m.git(repo, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	return parseWorktreeList(out), nil
}

// parseWorktreeList 는 porcelain 출력을 해석한다. 레코드는 빈 줄로 갈린다 —
// `worktree <path>` 로 시작하고 `HEAD <sha>`·`branch <ref>`(또는 `detached`)가
// 뒤따른다 (git worktree add --help, PORCELAIN FORMAT).
//
// **첫 레코드가 main worktree 다 (Entry.Main, V162).** 근거는 git-worktree(1)
// 매뉴얼의 list 절 — "The main worktree is listed first, followed by each of the
// linked worktrees." — 이며, 이 파일이 실측으로도 확인한다
// (TestList_MainIsAlwaysFirstEntry). 순서에 의존한다는 사실을 여기 명시적으로
// 적어 두는 이유는, 예전에 "조회 대상 경로와 같다"로 판정했다가 링크드 worktree
// 를 활성 리포로 열면 main 배지가 그리로 옮겨가던 결함을 겪었기 때문이다 — 근거
// 없이 가정을 재도입하는 사고가 다시 나지 않게 한다.
func parseWorktreeList(out string) []Entry {
	var entries []Entry
	var cur *Entry
	flush := func() {
		if cur != nil {
			entries = append(entries, *cur)
			cur = nil
		}
	}
	for _, ln := range strings.Split(out, "\n") {
		ln = strings.TrimRight(ln, "\r")
		switch {
		case ln == "":
			flush()
		case strings.HasPrefix(ln, "worktree "):
			flush()
			cur = &Entry{Path: normalizeGitPath(strings.TrimPrefix(ln, "worktree ")), Main: len(entries) == 0}
		case ln == "detached":
			if cur != nil {
				cur.Detached = true
			}
		case strings.HasPrefix(ln, "branch "):
			if cur != nil {
				cur.Branch = strings.TrimPrefix(strings.TrimPrefix(ln, "branch "), "refs/heads/")
			}
		}
	}
	flush()
	return entries
}

// normalizeGitPath 는 git 이 낸 경로를 **OS 형태로** 옮긴다 (FR-WTP-3).
//
// Windows 의 git 은 `C:/Users/x` 처럼 드라이브 문자에 슬래시를 붙여 낸다. 이
// 저장소의 다른 모든 경로는 `filepath` 가 만든 OS 형태(`C:\Users\x`)다. 두
// 형태가 섞이면 문자열 비교가 조용히 어긋난다 — `gone` 의 `e.Path == path`
// 와 `gitWorktreeOwner` 의 접두사 판정이 그 자리다. 그러면 Windows 에서
// worktree 소유가 전부 "outside" 로 떨어지고, 살아 있는 worktree 를 사라졌다고
// 본다.
//
// 정규화를 **파싱 경계 한 곳**에 두는 이유는 FR-GIT-246 과 같다 — 소비처마다
// 옮기면 한 곳이 빠지고, 빠진 곳은 조용하다. POSIX 에서는 아무 변화가 없다.
func normalizeGitPath(p string) string {
	if strings.TrimSpace(p) == "" {
		return p
	}
	return filepath.Clean(p)
}

// RepoBucket 은 사용자 worktree 영역의 저장소별 버킷 이름이다 (FR-WKT-13, V159):
//
//	<베이스이름>-<정규화된 루트의 해시 앞자리>
//
// 베이스이름을 남기는 이유는 FR-GIT-242 가 "만들어진 경로를 보인다"고 요구하기
// 때문이다 — 해시만 쓰면 사람이 그 경로가 어느 저장소인지 알 수 없다. 해시를
// 더하는 이유는 베이스이름만으로는 서로 다른 저장소(동명의 리포)를 가르지 못하기
// 때문이다 — Run 영역이 uuid 파생으로 경로를 절대 재사용하지 않는 것과 같은
// 이유다(FR-WKT-4). safeSegment 를 그대로 쓴다 — 새 정규화 규칙을 만들지 않는다.
func RepoBucket(root string) string {
	clean := filepath.Clean(root)
	sum := sha256.Sum256([]byte(clean))
	return safeSegment(filepath.Base(clean), "repo") + "-" + hex.EncodeToString(sum[:])[:8]
}

// checkPath 는 위험 경로를 거부한다 (FR-WKT-10). 제거 전에 경로가 실제로
// worktrees 루트 **아래**인지 확인하는 것이 이 함수의 존재 이유다.
func (m *Manager) checkPath(p string) error {
	if strings.TrimSpace(p) == "" {
		return fmt.Errorf("%w: 빈 경로", ErrUnsafePath)
	}
	if !filepath.IsAbs(p) {
		return fmt.Errorf("%w: 절대 경로가 아니다: %q", ErrUnsafePath, p)
	}
	if strings.Contains(p, "..") {
		return fmt.Errorf("%w: 경로 이탈: %q", ErrUnsafePath, p)
	}
	clean := filepath.Clean(p)
	if clean == string(filepath.Separator) {
		return fmt.Errorf("%w: 파일시스템 루트", ErrUnsafePath)
	}
	if clean == m.root {
		return fmt.Errorf("%w: worktrees 루트 자신", ErrUnsafePath)
	}
	if !strings.HasPrefix(clean, m.root+string(filepath.Separator)) {
		return fmt.Errorf("%w: %s 아래가 아니다: %q", ErrUnsafePath, m.root, p)
	}
	return nil
}

// Path 는 worktree 경로를 식별자에서 파생한다 (FR-WKT-3).
//
//	$DONGMINAL_HOME/worktrees/<run.short>/<member.short>
//
// **경로를 재사용하지 않는다** (FR-WKT-4). uuid 파생이 이를 자동으로 보장한다 —
// 에이전트 CLI 는 대화 이력을 cwd 로 키잉하므로, 지워진 worktree 의 경로를 다시
// 쓰면 새 멤버가 남의 이력을 물려받는다.
func (m *Manager) Path(runShort, leaf string) string {
	return filepath.Join(m.root, safeSegment(runShort, "run"), safeSegment(leaf, "member"))
}

// Branch 는 브랜치 이름을 파생한다 (FR-WKT-3): dmn/<run.short>/<role>.
// role 을 ASCII 로 환원할 수 없으면(한글 역할명 등) fallback 으로 떨어진다.
func Branch(runShort, role, fallback string) string {
	name := slug(role)
	if name == "" {
		name = slug(fallback)
	}
	if name == "" {
		name = "member"
	}
	return "dmn/" + safeSegment(runShort, "run") + "/" + name
}

func safeSegment(s, fallback string) string {
	if out := slug(s); out != "" {
		return out
	}
	return fallback
}

// slug 는 경로·ref 에 안전한 ASCII 만 남긴다. 앞의 - 를 떼는 것이 FR-WKT-6 과
// 같은 이유이며(git 플래그 오인), 빈 문자열은 호출자가 대체한다.
func slug(s string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_':
			b.WriteRune(r)
			prevDash = false
		case r == '-' && b.Len() > 0 && !prevDash:
			b.WriteRune('-')
			prevDash = true
		default:
			if b.Len() > 0 && !prevDash {
				b.WriteRune('-')
				prevDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-.")
	if len(out) > 40 {
		out = strings.Trim(out[:40], "-.")
	}
	return out
}

// validRef 는 브랜치·base 인자를 검사한다 (FR-WKT-6). - 로 시작하는 값이 git
// 플래그로 오인되는 것이 이 검사의 출발점이다.
func validRef(name string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("%w: 빈 ref", ErrUnsafeArgument)
	}
	if strings.HasPrefix(name, "-") {
		return fmt.Errorf("%w: - 로 시작하는 ref 는 git 플래그로 오인된다: %q", ErrUnsafeArgument, name)
	}
	if strings.Contains(name, "..") || strings.HasSuffix(name, ".lock") {
		return fmt.Errorf("%w: 잘못된 ref: %q", ErrUnsafeArgument, name)
	}
	if strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") || strings.Contains(name, "//") {
		return fmt.Errorf("%w: 잘못된 ref: %q", ErrUnsafeArgument, name)
	}
	for _, r := range name {
		if r <= ' ' || r == 0x7f || strings.ContainsRune("~^:?*[\\\"'`$;|&<>", r) {
			return fmt.Errorf("%w: ref 에 쓸 수 없는 문자: %q", ErrUnsafeArgument, name)
		}
	}
	return nil
}

// CheckName 은 사용자 worktree 의 이름·브랜치를 검사한다 (FR-GIT-242) — "-" 로
// 시작하는 값을 거부하는 것은 FR-WKT-6 과 같은 근거(git 플래그 오인)다. validRef
// 를 그대로 드러낸다 — 이름·ref·브랜치가 결국 같은 git 인자 자리로 가므로 규칙을
// 두 벌 두지 않는다.
func CheckName(name string) error { return validRef(name) }
