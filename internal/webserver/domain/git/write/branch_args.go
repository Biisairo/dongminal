package write

import (
	"fmt"

	"dongminal/internal/webserver/domain/git/core"
)

// 브랜치 조작의 argv 빌더 (FR-GIT-155·158·253~257). 실행하지 않는 순수 함수들이다 —
// 서버가 잘못된 요청을 실행 전에 400 으로 답할 수 있어야 한다.

// CheckoutArgs 는 선택을 argv 로 옮긴다. **실행하지 않는다** — 서버가 잘못된 요청을
// 실행 전에 400 으로 답할 수 있어야 하고, 판정이 두 벌이면 한쪽만 고쳐진다
// (Checkout 이 이 함수를 부른다).
//
// 순서를 고정하는 이유는 테스트가 **무엇을 실행하지 않았는가**까지 볼 수 있어야
// 하기 때문이다. 위치 인자는 마지막 하나뿐이며, Track 이 있으면 시작점은
// `--track` 의 값이므로 Ref 를 함께 받지 않는다 — 둘 다 오면 어느 것이 시작점인지
// 가릴 수 없다.
func CheckoutArgs(o CheckoutOpts) ([]string, error) {
	for _, f := range []struct{ name, val string }{
		{"ref", o.Ref}, {"create", o.Create}, {"track", o.Track},
	} {
		if f.val == "" {
			continue
		}
		if err := core.CheckRefArg(f.name, f.val); err != nil {
			return nil, err
		}
	}
	switch {
	case o.Create == "" && o.Ref == "":
		return nil, fmt.Errorf("%w: 옮겨 갈 ref 가 없다", ErrCheckoutTarget)
	case o.Create == "" && o.Track != "":
		return nil, fmt.Errorf("%w: track 은 create 와 함께만 온다", ErrCheckoutTarget)
	case o.Track != "" && o.Ref != "":
		return nil, fmt.Errorf("%w: track 과 ref 를 함께 받지 않는다: %q / %q", ErrCheckoutTarget, o.Track, o.Ref)
	}
	argv := []string{"checkout"}
	if o.Force {
		argv = append(argv, checkoutForceFlag)
	}
	if o.Detach {
		argv = append(argv, checkoutDetachFlag)
	}
	if o.Create != "" {
		argv = append(argv, checkoutCreateFlag, o.Create)
	}
	if o.Track != "" {
		argv = append(argv, checkoutTrackFlag, o.Track)
	}
	if o.Ref != "" {
		argv = append(argv, o.Ref)
	}
	// 끝의 `--` 는 이름을 ref 로만 읽게 한다 (ATTIC_FIX_SRS FR-ATF-1, AT-GAPI-1).
	// 이전: 없는 ref 가 같은 이름의 파일이면 git 이 경로로 읽어 그 변경을 지웠다.
	// 새: 없는 ref 는 git 이 오류로 끝낸다.
	return append(argv, pathsSep), nil
}

// BranchCreateArgs 는 생성의 argv 다. Checkout 이면 만들면서 옮겨 가므로 명령 자체가
// 갈린다 — `branch` 는 만들기만 하고 `checkout -b` 는 옮겨 간다.
//
// 이름 규칙 검사는 여기 없다 — 그것은 git 에 물어야 하며(ValidBranchName), 순수
// 함수가 답할 수 있는 것이 아니다.
func BranchCreateArgs(o BranchCreateOpts) ([]string, error) {
	if err := core.CheckRefArg("name", o.Name); err != nil {
		return nil, err
	}
	if o.StartRef != "" {
		if err := core.CheckRefArg("startRef", o.StartRef); err != nil {
			return nil, err
		}
	}
	// `-f` 를 붙이지 않는다 — 기존 ref 를 옮기는 것은 생성이 아니다 (FR-GIT-97).
	argv := []string{"branch", o.Name}
	if o.Checkout {
		argv = []string{"checkout", checkoutCreateFlag, o.Name}
	}
	if o.StartRef != "" {
		argv = append(argv, o.StartRef)
	}
	return argv, nil
}

// BranchRenameArgs 는 이름 변경의 argv 다 (FR-GIT-253).
//
// 같은 이름으로의 변경은 거부한다 — 아무것도 하지 않는 실행을 성공으로 보이면
// 사용자는 바뀌었다고 읽는다.
func BranchRenameArgs(o BranchRenameOpts) ([]string, error) {
	if err := core.CheckRefArg("from", o.From); err != nil {
		return nil, err
	}
	if err := core.CheckRefArg("to", o.To); err != nil {
		return nil, err
	}
	if o.From == o.To {
		return nil, fmt.Errorf("%w: 같은 이름이다: %q", ErrBranchRename, o.To)
	}
	return []string{"branch", branchRenameFlag, o.From, o.To}, nil
}

// BranchDeleteArgs 는 삭제의 argv 다 (FR-GIT-254).
//
// `-d` 가 기본이고 `-D` 는 호출자가 명시할 때만이다 (FR-GIT-97). **여러 개를 한 번에
// 강제 삭제하지 않는다** — 확인 하나가 여러 개의 미머지 브랜치를 지우는 자리가 된다.
func BranchDeleteArgs(o BranchDeleteOpts) ([]string, error) {
	if len(o.Names) == 0 {
		return nil, fmt.Errorf("%w: 지울 브랜치가 없다", ErrBranchDelete)
	}
	if o.Force && len(o.Names) > 1 {
		return nil, fmt.Errorf("%w: 일괄 삭제는 -d 로만 한다 (%d개)", ErrBranchDelete, len(o.Names))
	}
	for _, n := range o.Names {
		if err := core.CheckRefArg("name", n); err != nil {
			return nil, err
		}
	}
	flag := branchDeleteFlag
	if o.Force {
		flag = branchDeleteForceFlag
	}
	return append([]string{"branch", flag}, o.Names...), nil
}

// MergeArgs 는 머지의 argv 다 (FR-GIT-255). 모르는 방식은 **오류다** — 통과시키면
// 다이얼로그가 제공하지 않는 플래그가 argv 로 흘러들어간다 (PullSpec 과 같은 규약).
func MergeArgs(o MergeOpts) ([]string, error) {
	if err := core.CheckRefArg("ref", o.Ref); err != nil {
		return nil, err
	}
	argv := []string{"merge"}
	switch o.Mode {
	case MergeDefault:
	case MergeFFOnly:
		argv = append(argv, "--ff-only")
	case MergeNoFF:
		argv = append(argv, "--no-ff")
	case MergeSquash:
		argv = append(argv, "--squash")
	default:
		return nil, fmt.Errorf("%w: %q", ErrMergeMode, o.Mode)
	}
	return append(argv, o.Ref), nil
}

// RebaseArgs 는 rebase 의 argv 다 (FR-GIT-256). `--onto` 는 옵션이며 주면 위치
// 인자보다 앞선다 — git 이 그 순서를 요구한다.
func RebaseArgs(o RebaseOpts) ([]string, error) {
	if err := core.CheckRefArg("ref", o.Ref); err != nil {
		return nil, err
	}
	argv := []string{"rebase"}
	if o.Onto != "" {
		if err := core.CheckRefArg("onto", o.Onto); err != nil {
			return nil, err
		}
		argv = append(argv, "--onto", o.Onto)
	}
	return append(argv, o.Ref), nil
}

// UpstreamArgs 는 upstream 설정/해제의 argv 다 (FR-GIT-257).
//
// 대상 브랜치를 **반드시 받는다.** 생략하면 git 이 현재 브랜치에 적용하는데, 화면은
// 다른 브랜치를 눌렀을 수 있다 — 그 어긋남은 조용히 일어난다.
func UpstreamArgs(o UpstreamOpts) ([]string, error) {
	if err := core.CheckRefArg("branch", o.Branch); err != nil {
		return nil, err
	}
	if o.Unset {
		if o.Upstream != "" {
			return nil, fmt.Errorf("%w: unset 과 upstream 을 함께 받지 않는다: %q", ErrBranchUpstream, o.Upstream)
		}
		return []string{"branch", branchUnsetUpstreamFlag, o.Branch}, nil
	}
	if err := core.CheckRefArg("upstream", o.Upstream); err != nil {
		return nil, err
	}
	return []string{"branch", branchSetUpstreamPrefix + o.Upstream, o.Branch}, nil
}
