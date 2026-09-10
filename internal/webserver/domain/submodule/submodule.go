/*
Package submodule 은 저장소 안에 등록된 서브모듈의 목록과 그 조작이다
(UX_BATCH5_SRS 묶음 D, FR-SUB-1~5).

**별도 패키지인 이유는 화이트리스트의 판정 단위다** (D-9 정정). `domain/git` 의
읽기·쓰기 허용 목록은 `argv[0]` 으로 판정하는데(`core/write.go:53`), `git submodule
status`(읽기)와 `git submodule update`(쓰기)는 argv[0] 이 똑같이 `submodule` 이다 —
어느 목록에 넣어도 반대쪽이 함께 열리고, 둘 다 넣으면 교집합-금지 불변식
(FR-GIT-95)이 깨진다. worktree 가 별도 Manager 인 것과 정확히 같은 상황이며
(`handlers_git_worktree.go:14`), 그 선례를 그대로 따른다.

이 패키지는 화면을 모른다. 무엇을 보일지는 호출자가 정하고, 여기 있는 것은 git
조작과 그 안전 가드뿐이다 — worktree 패키지와 같은 규약이다.

**하지 않는 것:** `submodule add`·`deinit` (§7 비목표 7). 저장소의 구성을 바꾸는
조작이며 되돌리기가 사용자 몫이 되는 범위다.
*/
package submodule

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"dongminal/internal/shared/diagtail"
	"dongminal/internal/webserver/domain/git/core"
)

// 거부 사유는 열거한다 — 무엇이 위험했는지 호출자가 구분할 수 있어야 한다
// (worktree 패키지와 같은 규약).
var (
	ErrUnsafePath = errors.New("unsafe_path")
	ErrFailed     = errors.New("submodule_failed")
)

// 서브모듈 상태 (FR-SUB-2). `git submodule status` 의 접두 문자에서 온다 — 판정을
// 우리가 다시 구현하지 않는다.
const (
	StateOK            = "ok"            // ' ' 등록된 커밋과 체크아웃이 같다
	StateUninitialized = "uninitialized" // '-' 초기화되지 않았다
	StateModified      = "modified"      // '+' 등록된 것과 다른 커밋에 있다
	StateConflict      = "conflict"      // 'U' 머지 충돌
)

var stateByPrefix = map[byte]string{
	' ': StateOK, '-': StateUninitialized, '+': StateModified, 'U': StateConflict,
}

// opTimeout 은 git 한 번의 상한이다. `submodule update` 는 원격에서 받아올 수
// 있어 짧게 둘 수 없다 — worktree 의 체크아웃과 같은 성질이다.
const opTimeout = 180 * time.Second

// oidLen 은 서브모듈 상태가 싣는 커밋 해시의 길이다. 짧은 것을 받지 않는 이유는
// 그것이 알아보지 못한 줄이라는 신호이기 때문이다.
const oidLen = 40

// Runner 는 git 한 번이다. 주입인 것은 런타임 없이 파싱과 가드를 결정적으로
// 관찰하기 위해서다 (worktree.Runner 와 같은 모양).
type Runner func(dir string, args ...string) (string, error)

type Manager struct{ git Runner }

func New(git Runner) *Manager { return &Manager{git: git} }

// Entry 는 서브모듈 하나다 (FR-SUB-1).
//
// `AbsPath` 를 여기서 채우지 않는다 — 그것은 응답의 모양이고 호출자가 repo 와
// 합쳐 만든다. 이 패키지가 아는 것은 저장소 안의 상대경로뿐이다.
type Entry struct {
	Path     string `json:"path"`
	OID      string `json:"oid"`
	State    string `json:"state"`
	Describe string `json:"describe,omitempty"`
}

/*
List 는 등록된 서브모듈 전부다 (FR-SUB-1·2).

**`--recursive` 를 쓰지 않는다** (FR-SUB-3). 중첩된 서브모듈을 한 목록에 섞으면
어느 행이 누구의 것인지 말할 수 없다 — 그것은 그 서브모듈을 저장소로 연 뒤 그
창의 Submodules 탭에서 본다.

빈 출력은 **정상**이다. 서브모듈이 없는 저장소가 흔하며, 그것을 오류로 바꾸면
탭이 저장소마다 실패를 보인다 (FR-SUB-10).
*/
func (m *Manager) List(repo string) ([]Entry, error) {
	if err := checkRepo(repo); err != nil {
		return nil, err
	}
	out, err := m.run(repo, "submodule", "status")
	if err != nil {
		// 실패를 빈 목록으로 낮추지 않는다 — "없다" 와 "확인에 실패했다" 는
		// 사용자가 할 일이 다르다.
		return nil, fmt.Errorf("%w: %s", ErrFailed, tail(out, err))
	}
	return parseStatus(out), nil
}

/*
parseStatus 는 `git submodule status` 한 줄씩을 읽는다.

	 <oid> <path> (<describe>)
	-<oid> <path>
	+<oid> <path> (<describe>)
	U<oid> <path>

**describe 는 끝에서 뗀다.** 공백으로 자르면 경로에 공백이 있을 때 잘린다 —
`vendor/my lib` 같은 경로가 실재한다.

알아보지 못한 줄은 **버린다.** 반쯤 채운 항목을 만들면 화면이 빈 경로의 행을
그리고, 그 행의 동작이 저장소 전체를 가리킨다.
*/
func parseStatus(out string) []Entry {
	entries := []Entry{}
	for _, line := range strings.Split(out, "\n") {
		// 앞 공백을 다듬지 않는다 — 첫 글자가 상태다.
		line = strings.TrimRight(line, "\r\n")
		if len(line) < 1+oidLen+1 {
			continue
		}
		state, ok := stateByPrefix[line[0]]
		if !ok {
			continue
		}
		oid := line[1 : 1+oidLen]
		if !isHex(oid) {
			continue
		}
		rest := line[1+oidLen:]
		if !strings.HasPrefix(rest, " ") {
			continue
		}
		path, describe := splitDescribe(strings.TrimPrefix(rest, " "))
		if path == "" {
			continue
		}
		entries = append(entries, Entry{Path: path, OID: oid, State: state, Describe: describe})
	}
	return entries
}

// splitDescribe 는 끝의 ` (…)` 를 뗀다. 없으면 전부가 경로다 — 초기화되지 않은
// 서브모듈이 그렇다.
func splitDescribe(s string) (path, describe string) {
	if !strings.HasSuffix(s, ")") {
		return s, ""
	}
	i := strings.LastIndex(s, " (")
	if i < 0 {
		return s, ""
	}
	return s[:i], s[i+2 : len(s)-1]
}

func isHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

/*
Update 는 서브모듈을 등록된 커밋으로 옮긴다 (FR-SUB-4).

**파괴적이다** (FR-SUB-5) — 서브모듈 안의 체크아웃이 바뀌며, 커밋되지 않은 변경이
있으면 git 이 거부하거나 덮는다. 확인은 호출자가 이미 거쳤다.

`path` 가 비면 저장소의 서브모듈 **전부**가 대상이다.
*/
func (m *Manager) Update(repo, path string, init, recursive bool) error {
	args := []string{"submodule", "update"}
	if init {
		args = append(args, "--init")
	}
	if recursive {
		args = append(args, "--recursive")
	}
	return m.runPathOp(repo, path, args)
}

// Sync 는 `.gitmodules` 의 URL 을 `.git/config` 로 옮긴다 (FR-SUB-4).
// 체크아웃을 건드리지 않으므로 파괴적이지 않다.
func (m *Manager) Sync(repo, path string) error {
	return m.runPathOp(repo, path, []string{"submodule", "sync"})
}

// runPathOp 은 경로 가드와 `--` 규약을 한 자리에 둔다. 두 조작이 같은 규칙을
// 따라야 하고, 그것을 각자 적으면 한쪽만 고쳐진다.
func (m *Manager) runPathOp(repo, path string, args []string) error {
	if err := checkRepo(repo); err != nil {
		return err
	}
	if path != "" {
		if err := checkPath(path); err != nil {
			return err
		}
		// `--` 뒤에 둔다 — 앞에 두면 `-` 로 시작하는 경로가 플래그로 읽히고,
		// 그때 대상이 뜻하지 않게 넓어진다. 경로가 없으면 뒤에 올 것이 없으므로
		// 붙이지 않는다.
		args = append(args, "--", path)
	}
	out, err := m.run(repo, args...)
	if err != nil {
		return fmt.Errorf("%w: %s", ErrFailed, tail(out, err))
	}
	return nil
}

// checkRepo 는 호출자가 RepoRoot 로 정규화한 절대경로만 받는다. 상대경로는 해석
// 기준이 없어 쓸 수 없다 (core.RepoRoot 와 같은 근거).
func checkRepo(repo string) error {
	if strings.TrimSpace(repo) == "" || !filepath.IsAbs(repo) {
		return fmt.Errorf("%w: repo 는 절대경로여야 한다: %q", ErrUnsafePath, repo)
	}
	return nil
}

/*
checkPath 는 저장소 **안의 상대경로**만 받는다.

셋을 막는다: 절대경로(저장소 밖을 가리킨다) · `..`(빠져나간다) · `-` 로 시작하는
것(플래그로 읽힌다). 마지막은 `--` 를 붙여도 막는다 — 방어가 한 겹이면 그 겹을
잊는 날 구멍이 된다.
*/
func checkPath(p string) error {
	if strings.TrimSpace(p) == "" {
		return fmt.Errorf("%w: 빈 경로", ErrUnsafePath)
	}
	if filepath.IsAbs(p) || strings.HasPrefix(p, "/") {
		return fmt.Errorf("%w: 절대경로: %q", ErrUnsafePath, p)
	}
	// 윈도우 드라이브 문자(`C:\…`). POSIX 서버에서도 막는다 — 요청은 어디서든 온다.
	if len(p) >= 2 && p[1] == ':' {
		return fmt.Errorf("%w: 드라이브 경로: %q", ErrUnsafePath, p)
	}
	if strings.HasPrefix(p, "-") {
		return fmt.Errorf("%w: 플래그로 읽힌다: %q", ErrUnsafePath, p)
	}
	for _, seg := range strings.Split(filepath.ToSlash(p), "/") {
		if seg == ".." {
			return fmt.Errorf("%w: 경로 이탈: %q", ErrUnsafePath, p)
		}
	}
	return nil
}

func (m *Manager) run(dir string, args ...string) (string, error) {
	return m.git(dir, args...)
}

// unguardedReason 은 실행 기록에 남는 사유다 (GIT_EXEC_UNIFY_SRS FR-GXU-1).
// Console 이 이 문장으로 "왜 이 실행이 화이트리스트를 지나지 않았는가"를 답한다.
const unguardedReason = "submodule 도메인 — 화이트리스트가 argv[0] 으로 키잉되어 status 와 update 를 가를 수 없다 (D-9)"

/*
ExecGit 는 Service 없이 도는 기본 Runner 다. 기록이 남지 않을 뿐 환경·마감·출력
상한·오류 분류는 그대로 적용된다 (FR-GXU-4). 실제 배선은 RunnerFor 를 쓴다.

두 스트림을 모아 드는 것이 요점이다 — 서브모듈 조작의 진단은 stderr 로 나오며,
그것을 버리면 "왜 실패했는가" 가 통째로 사라진다.

**출력의 앞을 다듬지 않는다.** `worktree.runGit` 는 `TrimSpace` 하지만 그것을
그대로 베끼면 안 된다 — `submodule status` 는 **첫 글자가 상태**이고(FR-SUB-2),
`ok` 상태의 접두는 공백이다. 앞을 다듬으면 그 줄들의 첫 글자가 해시가 되어 전부
버려진다. 실측으로 잡은 결함이며, Runner 를 주입한 단위 시험은 이것을 볼 수 없다
— 그래서 `TestExecGitKeepsLeadingSpace` 가 이 경로 자신을 시험한다.
*/
func ExecGit(dir string, args ...string) (string, error) { return runGit(nil, dir, args...) }

// RunnerFor 는 실행 기록을 core 와 공유하는 Runner 를 만든다 (FR-GXU-10).
// 이것을 쓰지 않으면 이 패키지의 실행은 Console 에 보이지 않는다.
func RunnerFor(svc *core.Service) Runner {
	return func(dir string, args ...string) (string, error) { return runGit(svc, dir, args...) }
}

// runGit 은 이 패키지의 유일한 git 실행이다 (GIT_EXEC_UNIFY_SRS FR-GXU-7).
//
// **인가는 이 패키지가 진다** — `checkRepo`·`checkPath`·`--` 규약이 그것이며,
// core 의 화이트리스트는 지나지 않는다 (패키지 주석의 D-9 근거). core 로 가는
// 것은 실행 방법이다: 환경(FR-GIT-104 의 프롬프트 배제)·마감·출력 상한·취소·
// 오류 분류·기록.
//
// **환경이 특히 중요한 자리다.** `submodule update --init` 은 원격에 닿으므로,
// `GIT_TERMINAL_PROMPT=0` 이 없으면 private 서브모듈에서 자격증명 프롬프트가 뜨고
// 프로세스가 opTimeout 까지 매달린다 — GUI askpass 면 보이지 않는 창을 기다린다.
func runGit(svc *core.Service, dir string, args ...string) (string, error) {
	out, err := svc.ExecUnguarded(context.Background(), dir, core.UnguardedSpec{
		Argv:    args,
		Timeout: opTimeout,
		Reason:  unguardedReason,
	})
	if errors.Is(err, core.ErrGitMissing) {
		return "", fmt.Errorf("%w: git 을 찾을 수 없다: %v", ErrFailed, err)
	}
	// 뒤의 개행만 다듬는다 — 파싱이 줄 단위이므로 끝의 빈 줄은 뜻이 없다.
	// **앞은 손대지 않는다** (위 FR-SUB-2).
	text := strings.TrimRight(out.Stdout+out.Stderr, "\r\n")
	if err != nil {
		return text, fmt.Errorf("git %s: %v", strings.Join(args, " "), err)
	}
	return text, nil
}

// failMax 는 `ErrFailed` 에 감싸 올릴 진단의 길이 상한이다. 이 문자열은 다시
// `gitTail` 을 지나 응답에 실린다 — 여기서 너무 짧게 자르면 그때는 이미 사유가
// 없다.
const failMax = 2000

// tail 은 판정을 `diagtail` 에 맡기고 이 표면의 상한만 정한다 (FR-DRC-9).
func tail(out string, err error) string { return diagtail.Of(out, err, failMax) }
