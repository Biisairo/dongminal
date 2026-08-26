package write

import (
	"context"
	"errors"
	"fmt"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 원격 작업의 argv 구성 (GIT_SRS §3B.1 FR-GIT-98~106).
//
// **버튼은 기본 동작만 한다** (FR-GIT-99) — 변형은 호출자가 옵션으로 명시할 때만
// 붙는다. 여기서 기본값을 넉넉히 채우면 다이얼로그가 뜻을 잃는다.
//
// **자격증명을 받는 자리가 없다** (FR-GIT-104). 옵션 구조체에 사용자명·비밀·
// 인증 재료를 담는 필드를 만들지 않는다 — 만들지 않는 것이 유일한 보장이다.
//
// 여기서 git 을 실행하는 것은 없다 — WriteSpec 을 만들어 주고, 실제 실행은
// jobs 의 스트리밍 경로가 한다 (FR-GIT-101~104).

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
func FetchSpec(o FetchOpts) core.WriteSpec {
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
	return core.WriteSpec{Argv: argv}
}

// PullSpec 은 pull 의 argv 다. 모르는 모드는 **오류다** — 통과시키면 다이얼로그가
// 제공하지 않는 플래그가 argv 로 흘러들어간다.
func PullSpec(o PullOpts) (core.WriteSpec, error) {
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
		return core.WriteSpec{}, fmt.Errorf("%w: %q", ErrPullMode, o.Mode)
	}
	return core.WriteSpec{Argv: argv}, nil
}

// PushSpec 은 저장소의 현재 상태를 보고 push 의 argv 를 만든다.
//
// upstream 이 없으면 Push 는 Publish 다 (FR-GIT-100) — `-u <remote> <branch>`.
// 그 사실은 실행 **전에** 알려야 하므로, Publish 확인이 없으면 계획만 돌려주고
// ErrPublishRequired 로 멈춘다.
//
// force 는 `--force-with-lease` 가 기본이고 `--force` 는 2단계 확인을 거친다
// (FR-GIT-106). 둘 다 파괴적으로 선언한다 (I5) — 원격의 커밋을 잃게 할 수 있다.
func PushSpec(s *core.Service, ctx context.Context, repo string, o PushOpts) (core.WriteSpec, PushPlan, error) {
	argv := []string{"push", progressFlag}
	plan := PushPlan{Force: o.Force}
	switch o.Force {
	case PushNoForce:
	case PushLease:
		argv = append(argv, "--force-with-lease")
	case PushForce:
		if !o.Confirm {
			return core.WriteSpec{}, plan, fmt.Errorf("%w: --force 는 2단계 확인을 요구한다", ErrForceConfirm)
		}
		argv = append(argv, "--force")
	default:
		return core.WriteSpec{}, plan, fmt.Errorf("%w: %q", ErrPushForce, o.Force)
	}
	spec := core.WriteSpec{Destructive: o.Force != PushNoForce}

	st, err := query.StatusOf(s, ctx, repo)
	if err != nil {
		return core.WriteSpec{}, plan, err
	}
	if st.HasUpstream {
		spec.Argv = argv
		return spec, plan, nil
	}
	if st.Detached {
		return core.WriteSpec{}, plan, fmt.Errorf("%w: detached HEAD 에는 밀 브랜치가 없다", ErrDetachedPush)
	}
	remote, err := query.DefaultRemote(s, ctx, repo)
	if err != nil {
		return core.WriteSpec{}, plan, err
	}
	plan.Publish, plan.Remote, plan.Branch = true, remote, st.Branch
	if !o.Publish {
		return core.WriteSpec{}, plan, fmt.Errorf("%w: %s 를 %s 의 upstream 으로 설정한다", ErrPublishRequired, remote+"/"+st.Branch, st.Branch)
	}
	spec.Argv = append(argv, "-u", remote, st.Branch)
	return spec, plan, nil
}
