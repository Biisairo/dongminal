package git

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// 원격 작업의 argv 구성 (GIT_SRS §3B.1 FR-GIT-98~106).
//
// **버튼은 기본 동작만 한다** (FR-GIT-99) — 변형은 호출자가 옵션으로 명시할 때만
// 붙는다. 여기서 기본값을 넉넉히 채우면 다이얼로그가 뜻을 잃는다.
//
// **자격증명을 받는 자리가 없다** (FR-GIT-104). 옵션 구조체에 사용자명·비밀·
// 인증 재료를 담는 필드를 만들지 않는다 — 만들지 않는 것이 유일한 보장이다.

// progressFlag 는 진행 표시를 강제한다. git 은 tty 가 아니면 진행을 내지 않고
// 우리는 파이프로 읽으므로, 이것 없이는 스트리밍할 것이 없다 (FR-GIT-103).
const progressFlag = "--progress"

// PullOpts 의 병합 방식 (FR-GIT-110). 빈 값이 기본이며 그것이 안전한 쪽이다.
const (
	PullDefault = ""
	PullRebase  = "rebase"
	PullFFOnly  = "ff-only"
	PullNoFF    = "no-ff"
)

// PushOpts 의 force 세기 (FR-GIT-106). **기본은 force 가 아니다** (FR-GIT-97).
const (
	PushNoForce = ""
	PushLease   = "lease"
	PushForce   = "force"
)

var (
	// ErrPullMode 는 다이얼로그가 제공하지 않는 pull 변형이다.
	ErrPullMode = errors.New("pull_mode_invalid")
	// ErrPushForce 는 모르는 force 세기다.
	ErrPushForce = errors.New("push_force_invalid")
	// ErrForceConfirm 은 --force 의 2단계 확인이 없다는 것이다 (FR-GIT-106).
	ErrForceConfirm = errors.New("force_confirmation_required")
	// ErrPublishRequired 는 upstream 설정을 사용자가 아직 확인하지 않았다는
	// 것이다 (FR-GIT-100).
	ErrPublishRequired = errors.New("publish_required")
	// ErrNoRemote 는 밀 원격을 정할 수 없다는 것이다.
	ErrNoRemote = errors.New("no_remote")
	// ErrDetachedPush 는 detached HEAD 라 밀 브랜치가 없다는 것이다.
	ErrDetachedPush = errors.New("detached_head_push")
)

// FetchOpts 는 fetch 다이얼로그의 선택이다 (FR-GIT-109).
//
// Tags 가 nil 이면 아무 플래그도 붙이지 않는다 — 다이얼로그를 열지 않은 사용자의
// `remote.<name>.tagOpt` 설정을 우리가 덮지 않는다.
type FetchOpts struct {
	Prune bool  `json:"prune"`
	Tags  *bool `json:"tags"`
}

// PullOpts 는 pull 다이얼로그의 선택이다 (FR-GIT-110).
type PullOpts struct {
	Mode string `json:"mode"`
}

// PushOpts 는 push 한 번의 선택이다.
//
// Confirm 과 Publish 를 나눠 받는 이유는 확인하는 대상이 다르기 때문이다 —
// Confirm 은 `--force` 의 2단계 확인이고(FR-GIT-106), Publish 는 upstream 을
// 설정한다는 사실의 사전 확인이다(FR-GIT-100).
type PushOpts struct {
	Force   string `json:"force"`
	Confirm bool   `json:"confirm"`
	Publish bool   `json:"publish"`
}

// PushPlan 은 push 한 번이 무엇을 할지다. Publish 여부를 호출자가 사용자에게
// 알려야 하므로 argv 와 함께 돌려준다 (FR-GIT-100).
//
// 거부(ErrPublishRequired)와 **함께도** 채워져 나간다 — 무엇을 확인해야 하는지를
// 모르면 사용자가 확인할 수 없다.
type PushPlan struct {
	Publish bool   `json:"publish"`
	Remote  string `json:"remote,omitempty"`
	Branch  string `json:"branch,omitempty"`
	Force   string `json:"force,omitempty"`
}

// FetchSpec 은 fetch 의 argv 다. 파괴적이 아니다.
func FetchSpec(o FetchOpts) WriteSpec {
	argv := []string{"fetch", progressFlag}
	if o.Prune {
		argv = append(argv, "--prune")
	}
	if o.Tags != nil {
		if *o.Tags {
			argv = append(argv, "--tags")
		} else {
			argv = append(argv, "--no-tags")
		}
	}
	return WriteSpec{Argv: argv}
}

// PullSpec 은 pull 의 argv 다. 모르는 모드는 **오류다** — 통과시키면 다이얼로그가
// 제공하지 않는 플래그가 argv 로 흘러들어간다.
func PullSpec(o PullOpts) (WriteSpec, error) {
	argv := []string{"pull", progressFlag}
	switch o.Mode {
	case PullDefault:
	case PullRebase:
		argv = append(argv, "--rebase")
	case PullFFOnly:
		argv = append(argv, "--ff-only")
	case PullNoFF:
		argv = append(argv, "--no-ff")
	default:
		return WriteSpec{}, fmt.Errorf("%w: %q", ErrPullMode, o.Mode)
	}
	return WriteSpec{Argv: argv}, nil
}

// PushSpec 은 저장소의 현재 상태를 보고 push 의 argv 를 만든다.
//
// upstream 이 없으면 Push 는 Publish 다 (FR-GIT-100) — `-u <remote> <branch>`.
// 그 사실은 실행 **전에** 알려야 하므로, Publish 확인이 없으면 계획만 돌려주고
// ErrPublishRequired 로 멈춘다.
//
// force 는 `--force-with-lease` 가 기본이고 `--force` 는 2단계 확인을 거친다
// (FR-GIT-106). 둘 다 파괴적으로 선언한다 (I5) — 원격의 커밋을 잃게 할 수 있다.
func (s *Service) PushSpec(ctx context.Context, repo string, o PushOpts) (WriteSpec, PushPlan, error) {
	argv := []string{"push", progressFlag}
	plan := PushPlan{Force: o.Force}
	switch o.Force {
	case PushNoForce:
	case PushLease:
		argv = append(argv, "--force-with-lease")
	case PushForce:
		if !o.Confirm {
			return WriteSpec{}, plan, fmt.Errorf("%w: --force 는 2단계 확인을 요구한다", ErrForceConfirm)
		}
		argv = append(argv, "--force")
	default:
		return WriteSpec{}, plan, fmt.Errorf("%w: %q", ErrPushForce, o.Force)
	}
	spec := WriteSpec{Destructive: o.Force != PushNoForce}

	st, err := s.Status(ctx, repo)
	if err != nil {
		return WriteSpec{}, plan, err
	}
	if st.HasUpstream {
		spec.Argv = argv
		return spec, plan, nil
	}
	if st.Detached {
		return WriteSpec{}, plan, fmt.Errorf("%w: detached HEAD 에는 밀 브랜치가 없다", ErrDetachedPush)
	}
	remote, err := s.defaultRemote(ctx, repo)
	if err != nil {
		return WriteSpec{}, plan, err
	}
	plan.Publish, plan.Remote, plan.Branch = true, remote, st.Branch
	if !o.Publish {
		return WriteSpec{}, plan, fmt.Errorf("%w: %s 를 %s 의 upstream 으로 설정한다", ErrPublishRequired, remote+"/"+st.Branch, st.Branch)
	}
	spec.Argv = append(argv, "-u", remote, st.Branch)
	return spec, plan, nil
}

// defaultRemote 는 밀 대상 원격을 정한다. 하나면 그것, 여럿이면 origin, 없으면
// 오류다 (FR-GIT-100).
//
// 목록은 `git config --list` 에서 읽는다. `git remote` 는 읽기 허용 목록에 없고,
// **허용 목록을 늘리지 않고 얻을 수 있는 값이므로 늘리지 않는다.** `refs/remotes`
// 를 훑는 방법은 쓰지 않는다 — fetch 한 적 없는 원격은 그 아래에 아무것도 없다.
func (s *Service) defaultRemote(ctx context.Context, repo string) (string, error) {
	out, err := s.Exec(ctx, repo, "config", "--list")
	if err != nil {
		return "", err
	}
	names := remoteNames(out.Stdout)
	switch len(names) {
	case 0:
		return "", fmt.Errorf("%w: 원격이 없다", ErrNoRemote)
	case 1:
		return names[0], nil
	}
	for _, n := range names {
		if n == "origin" {
			return "origin", nil
		}
	}
	return "", fmt.Errorf("%w: 원격이 %d 개이고 origin 이 없다: %v", ErrNoRemote, len(names), names)
}

// remoteNames 는 `config --list` 에서 `remote.<name>.url` 만 골라 이름을 모은다.
//
// url 이 있는 것만 세는 이유는 `remote.<name>.prune` 처럼 전역 설정에 흔히 있는
// 키가 원격의 **존재**를 뜻하지 않기 때문이다. 이름에 점이 들 수 있으므로
// (`remote.my.fork.url`) 접두·접미만 떼고 남은 것을 그대로 이름으로 본다.
func remoteNames(out string) []string {
	seen := map[string]bool{}
	names := []string{}
	for _, line := range strings.Split(out, "\n") {
		key, _, ok := strings.Cut(line, "=")
		if !ok || !strings.HasPrefix(key, "remote.") || !strings.HasSuffix(key, ".url") {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(key, "remote."), ".url")
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// remoteCreds 는 URL 의 userinfo 다. `scheme://user:pass@host` 의 `user:pass` 는
// 물론이고 **콜론이 없어도** 지운다 — `https://ghp_…@github.com` 처럼 토큰이
// 사용자명 자리에 오는 형태가 흔하다.
//
// scp 형태(`git@host:path`)는 손대지 않는다: scheme 이 없고 비밀이 들어갈 자리도
// 없다.
var remoteCreds = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/@\s]+@`)

// sanitizeRemote 는 자격증명을 지운다. **저장 전에** 부른다 (FR-GIT-104, V43) —
// argv·출력 줄·실행 기록·SSE·응답 중 한 곳만 늦게 지우면 그곳이 유출 경로가 된다.
func sanitizeRemote(s string) string {
	if !strings.Contains(s, "://") {
		return s
	}
	return remoteCreds.ReplaceAllString(s, "${1}***@")
}

func sanitizeArgv(argv []string) []string {
	out := make([]string, len(argv))
	for i, a := range argv {
		out[i] = sanitizeRemote(a)
	}
	return out
}
