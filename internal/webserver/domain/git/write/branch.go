package write

import (
	"context"
	"errors"
	"fmt"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 브랜치 조작 (GIT_SRS §3D.1 FR-GIT-155~160).
//
// **목록을 여기서 만들지 않는다** — Refs 가 이름·대상·upstream·ahead/behind 를 이미
// 준다 (FR-GIT-147). 조회가 두 벌이면 한쪽만 고쳐진다.
//
// **기본값은 항상 안전한 쪽이다** (FR-GIT-97) — force 도 detach 도 호출자가
// 명시할 때만 붙는다. 여기서 기본을 넉넉히 채우면 다이얼로그가 뜻을 잃는다.
//
// 이름 규칙·존재 확인은 조회이므로 query 에 있다 (ValidBranchName,
// LocalBranchExists) — 생성 경로가 그것을 실행 **전에** 부른다 (FR-GIT-156·159).

// checkout 의 플래그. 상수로 못박는다 — 호출 지점마다 다른 문자열이 흩어지면
// 무엇이 붙는지 한 자리에서 볼 수 없다.
const (
	checkoutForceFlag  = "--force"
	checkoutDetachFlag = "--detach"
	checkoutCreateFlag = "-b"
	checkoutTrackFlag  = "--track"
)

var (
	// ErrBranchExists 는 같은 이름의 로컬 브랜치가 이미 있다는 것이다 (FR-GIT-156).
	ErrBranchExists = errors.New("branch_exists")
	// ErrCheckoutTarget 은 checkout 이 무엇을 할지 정할 수 없다는 것이다.
	ErrCheckoutTarget = errors.New("checkout_target_invalid")
)

// BranchConflict* 는 이름이 이미 있을 때 사용자가 고를 수 있는 선택지다
// (FR-GIT-156). **API 로 노출한다** — 클라이언트가 목록을 복제하면 서버가 선택지를
// 늘려도 그것을 보이지 못한다. 기본 포커스는 취소다 (FR-GIT-97, O14).
const (
	BranchConflictCheckout = "checkout_existing"
	BranchConflictRename   = "create_other_name"
	BranchConflictCancel   = "cancel"
)

var BranchConflictOptions = []string{BranchConflictCheckout, BranchConflictRename, BranchConflictCancel}

// CheckoutOpts 는 checkout 한 번의 선택이다.
//
// Force 는 **파괴적이다** — 워킹 트리의 변경을 버린다. 기본이 false 인 것이
// FR-GIT-97·157 이며, 2단계 확인은 호출자(서버 라우트)가 요구한다.
type CheckoutOpts struct {
	Ref    string `json:"ref"`
	Create string `json:"create"` // 비어 있지 않으면 이 이름으로 만들며 checkout
	Track  string `json:"track"`  // upstream 으로 설정할 원격 ref
	Detach bool   `json:"detach"`
	Force  bool   `json:"force"`
}

// BranchCreateOpts 는 브랜치 생성 다이얼로그의 선택이다 (FR-GIT-158).
type BranchCreateOpts struct {
	Name     string `json:"name"`
	StartRef string `json:"startRef"` // 비면 HEAD
	Checkout bool   `json:"checkout"`
}

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
		return append(argv, checkoutTrackFlag, o.Track), nil
	}
	if o.Ref != "" {
		argv = append(argv, o.Ref)
	}
	return argv, nil
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

// Checkout 은 워킹 트리를 다른 ref 로 옮긴다 (FR-GIT-155·156).
//
// Create 가 있으면 실행 **전에** 이름 규칙과 같은 이름의 로컬 브랜치를 확인한다
// (FR-GIT-156). git 에 맡기면 exit 128 의 문구로만 알 수 있고, 사용자에게 줄
// 선택지를 만들 수 없다. 클라이언트만 막으면 API 직접 호출이 우회한다.
func Checkout(s *core.Service, ctx context.Context, repo string, o CheckoutOpts) (core.Output, error) {
	argv, err := CheckoutArgs(o)
	if err != nil {
		return denied(), err
	}
	if o.Create != "" {
		if err := checkNewBranchName(s, ctx, repo, o.Create); err != nil {
			return denied(), err
		}
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv, Destructive: o.Force})
}

// BranchCreate 는 브랜치를 만든다 (FR-GIT-158). Checkout 이면 만들면서 옮겨 간다.
//
// 이름 규칙은 실행 **전에** 확인한다 (FR-GIT-159) — 클라이언트의 입력 단계 차단만
// 두면 API 직접 호출이 우회한다.
func BranchCreate(s *core.Service, ctx context.Context, repo string, o BranchCreateOpts) (core.Output, error) {
	argv, err := BranchCreateArgs(o)
	if err != nil {
		return denied(), err
	}
	if err := checkNewBranchName(s, ctx, repo, o.Name); err != nil {
		return denied(), err
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
}

// checkNewBranchName 은 "이 이름으로 새 브랜치를 만들 수 있는가" 다 — 규칙 위반과
// 이름 충돌을 한 자리에서 본다. Checkout 과 BranchCreate 가 나눠 쓴다.
func checkNewBranchName(s *core.Service, ctx context.Context, repo, name string) error {
	if err := query.ValidBranchName(s, ctx, repo, name); err != nil {
		return err
	}
	exists, err := query.LocalBranchExists(s, ctx, repo, name)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("%w: 로컬 브랜치 %q 가 이미 있다", ErrBranchExists, name)
	}
	return nil
}
