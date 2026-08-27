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
	top = strings.TrimSpace(top)
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
func (m *Manager) Create(s Spec) error {
	if err := validRef(s.Branch); err != nil {
		return err
	}
	if s.Base != "" {
		if err := validRef(s.Base); err != nil {
			return err
		}
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
	args := []string{"worktree", "add", "--no-track", "-b", s.Branch, s.Path}
	if s.Base != "" {
		args = append(args, s.Base)
	}
	if _, err := m.git(s.Repo, args...); err != nil {
		return err
	}
	_, _ = m.git(s.Path, "config", "push.autoSetupRemote", "true")
	if s.Base != "" {
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
func (m *Manager) gone(repo, path string) bool {
	if _, err := os.Stat(path); err == nil {
		return false
	}
	out, err := m.git(repo, "worktree", "list", "--porcelain")
	if err != nil {
		return false // 확인할 수 없으면 사라졌다고 단정하지 않는다
	}
	for _, ln := range strings.Split(out, "\n") {
		if strings.TrimSpace(ln) == "worktree "+path {
			return false
		}
	}
	return true
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
