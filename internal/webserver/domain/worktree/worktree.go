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
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dongminal/internal/webserver/domain/git/core"
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

// removeRetryTries·removeRetryGap·removeRetryBudget 은 `git worktree remove` 의
// 되풀이 규칙이다 (FR-WKT-18). 예산은 되풀이 전체의 상한이지 git 한 번의 상한이
// 아니다 — 그쪽은 opTimeout 이다.
const (
	removeRetryTries  = 6
	removeRetryGap    = 250 * time.Millisecond
	removeRetryBudget = 3 * time.Second
)

// Service 는 소비자 — httpapi 의 Run 격리와 gitapi 의 Worktrees 탭 — 가 이
// 관리자에 요구하는 표면이다 (M8 `GO-44`). `*Manager` 가 만족한다. 두 소비자가
// 같은 표면을 쓰므로 여기 한 벌로 둔다; 핸들러 테스트는 이것을 가짜로 채워 git
// 없이 돌 수 있다.
type Service interface {
	Root() string
	Path(runShort, leaf string) string
	Resolve(cwd, base string) (Repo, error)
	Create(s Spec) error
	Rollback(s Spec)
	Remove(ctx context.Context, s RemoveSpec) Result
	BranchExists(repo, branch string) bool
	List(repo string) ([]Entry, error)
}

var _ Service = (*Manager)(nil)

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

// unguardedReason 은 실행 기록에 남는 사유다 (GIT_EXEC_UNIFY_SRS FR-GXU-1).
// Console 이 이 문장으로 "왜 이 실행이 화이트리스트를 지나지 않았는가"를 답한다.
const unguardedReason = "worktree 도메인 — 화이트리스트가 argv[0] 으로 키잉되어 list 와 add 를 가를 수 없다 (FR-GIT-246)"

// execGit 은 Service 없이 도는 기본 실행기다. 기록이 남지 않을 뿐 환경·마감·출력
// 상한·오류 분류는 그대로 적용된다 (FR-GXU-4).
//
// 실제 배선은 WithService 로 Service 를 준다 — 그래야 이 패키지의 git 실행이
// Console 과 Replay 가 보는 같은 기록에 남는다.
func execGit(dir string, args ...string) (string, error) { return runGit(nil, dir, args...) }

// runGit 은 이 패키지의 유일한 git 실행이다 (GIT_EXEC_UNIFY_SRS FR-GXU-7).
//
// **인가는 이 패키지가 진다.** `checkRepo`·`checkPath`·`validRef`·`repoLock` 이
// 그것이며, core 의 화이트리스트는 지나지 않는다 — `git worktree` 는 한 하위
// 명령에 `list`(읽기)와 `add`(쓰기)를 함께 갖고 허용 목록은 `argv[0]` 으로만
// 키잉되므로, 어느 목록에 넣어도 교집합-금지 불변식이 뜻을 잃는다 (FR-GIT-246).
//
// core 로 가는 것은 **실행 방법**이다 — 환경(FR-GIT-104 의 프롬프트 배제),
// 마감, 출력 상한, 취소, 오류 분류, 기록. 종전에는 그 여섯이 전부 빠져 있었다.
func runGit(svc *core.Service, dir string, args ...string) (string, error) {
	out, err := svc.ExecUnguarded(context.Background(), dir, core.UnguardedSpec{
		Argv:    args,
		Timeout: opTimeout,
		Reason:  unguardedReason,
	})
	// git 부재는 이 패키지의 사유로 바꿔 든다 — apierr 가 이 sentinel 로 HTTP
	// 코드를 정한다 (tables.go:90). 종전과 같이 텍스트는 비운다.
	if errors.Is(err, core.ErrGitMissing) {
		return "", fmt.Errorf("%w: %v", ErrGitMissing, err)
	}
	// 종전 CombinedOutput 의 자리를 채운다. 시간순 인터리브가 아니라 스트림별
	// 결합이며, 성공 경로의 파싱은 stdout 만 읽으므로 실질 차이는 없다.
	text := strings.TrimSpace(out.Stdout + out.Stderr)
	// 사유에 텍스트를 덧붙이지 않는다 — core 의 오류가 이미 stderr 를 싣는다.
	// 붙이면 같은 진단이 두 벌이 되고, 상한(failMax)을 먹어 실제 사유가 잘린다.
	if err != nil {
		return text, fmt.Errorf("git %s: %v", strings.Join(args, " "), err)
	}
	return text, nil
}

// WithService 는 git 실행 기록을 core 와 공유하는 실행기를 붙인다 (FR-GXU-10).
// 이것을 주지 않으면 이 패키지의 실행은 Console 에 보이지 않는다.
func WithService(svc *core.Service) Option {
	return func(m *Manager) {
		m.git = func(dir string, args ...string) (string, error) { return runGit(svc, dir, args...) }
	}
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

// checkPath 는 위험 경로를 거부한다 (FR-WKT-10). 제거 전에 경로가 실제로
// worktrees 루트 **아래**인지 확인하는 것이 이 함수의 존재 이유다.
func (m *Manager) checkPath(p string) error {
	if strings.TrimSpace(p) == "" {
		return fmt.Errorf("%w: 빈 경로", ErrUnsafePath)
	}
	if !filepath.IsAbs(p) {
		return fmt.Errorf("%w: 절대 경로가 아니다: %q", ErrUnsafePath, p)
	}
	// `..` 는 조각으로 본다 (M8 D-A-14) — `a..b` 는 정상 이름이고, 조각 `..` 는
	// Clean 뒤 루트 안으로 돌아오더라도 이탈이다.
	for _, seg := range strings.Split(filepath.ToSlash(p), "/") {
		if seg == ".." {
			return fmt.Errorf("%w: 경로 이탈: %q", ErrUnsafePath, p)
		}
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
