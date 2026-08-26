package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// 브랜치 조작 (GIT_SRS §3D.1 FR-GIT-155~160).
//
// **목록을 여기서 만들지 않는다** — 14단계의 Refs 가 이름·대상·upstream·
// ahead/behind 를 이미 준다 (FR-GIT-147). 조회가 두 벌이면 한쪽만 고쳐진다.
//
// **기본값은 항상 안전한 쪽이다** (FR-GIT-97) — force 도 detach 도 호출자가
// 명시할 때만 붙는다. 여기서 기본을 넉넉히 채우면 다이얼로그가 뜻을 잃는다.

// checkout 의 플래그와 브랜치 ref 접두. 상수로 못박는다 — 호출 지점마다 다른
// 문자열이 흩어지면 무엇이 붙는지 한 자리에서 볼 수 없다.
const (
	checkoutForceFlag  = "--force"
	checkoutDetachFlag = "--detach"
	checkoutCreateFlag = "-b"
	checkoutTrackFlag  = "--track"
	branchRefPrefix    = "refs/heads/"
)

var (
	// ErrRefName 은 git 의 ref 이름 규칙을 어긴 이름이다 (FR-GIT-159).
	ErrRefName = errors.New("ref_name_invalid")
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

// refNameInvalidStderr 는 "그 이름은 브랜치 이름이 아니다" 를 뜻하는 git 의 fatal
// 문구다 (git 2.50.1 실측). classify 가 분류하지 않는 exit 128 이므로 문구로 좁힌다
// — 그 밖의 128 을 "이름이 틀렸다" 로 뭉개면 저장소 실패가 입력 오류로 보인다.
const refNameInvalidStderr = "is not a valid branch name"

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
		if err := checkRefArg(f.name, f.val); err != nil {
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
	if err := checkRefArg("name", o.Name); err != nil {
		return nil, err
	}
	if o.StartRef != "" {
		if err := checkRefArg("startRef", o.StartRef); err != nil {
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
func (s *Service) Checkout(ctx context.Context, repo string, o CheckoutOpts) (Output, error) {
	argv, err := CheckoutArgs(o)
	if err != nil {
		return denied(), err
	}
	if o.Create != "" {
		if err := s.checkNewBranchName(ctx, repo, o.Create); err != nil {
			return denied(), err
		}
	}
	return s.ExecWrite(ctx, repo, WriteSpec{Argv: argv, Destructive: o.Force})
}

// BranchCreate 는 브랜치를 만든다 (FR-GIT-158). Checkout 이면 만들면서 옮겨 간다.
//
// 이름 규칙은 실행 **전에** 확인한다 (FR-GIT-159) — 클라이언트의 입력 단계 차단만
// 두면 API 직접 호출이 우회한다.
func (s *Service) BranchCreate(ctx context.Context, repo string, o BranchCreateOpts) (Output, error) {
	argv, err := BranchCreateArgs(o)
	if err != nil {
		return denied(), err
	}
	if err := s.checkNewBranchName(ctx, repo, o.Name); err != nil {
		return denied(), err
	}
	return s.ExecWrite(ctx, repo, WriteSpec{Argv: argv})
}

// ValidBranchName 은 git 의 이름 규칙을 확인한다 (FR-GIT-159).
//
// **규칙을 직접 구현하지 않는다** — `git check-ref-format --branch <name>` 이
// 판정한다. 규칙이 두 벌이면 한쪽만 고쳐져, git 이 받는 이름을 우리가 막거나 그
// 반대가 된다.
//
// 실측 (git 2.50.1): 유효하면 exit 0 + **펼쳐진 이름**을 출력, 무효하면 exit 128 +
// `fatal: 'x' is not a valid branch name`.
//
// 출력이 입력과 다르면 거부한다. `@{-1}` 은 exit 0 으로 직전 브랜치 이름을
// 출력하며(실측), 통과시키면 사용자가 적은 이름과 git 이 만드는 이름이 달라진다.
func (s *Service) ValidBranchName(ctx context.Context, repo, name string) error {
	if err := checkRefArg("name", name); err != nil {
		return err
	}
	out, err := s.Exec(ctx, repo, "check-ref-format", checkRefFormatBranch, name)
	if err != nil {
		return refNameError(name, err)
	}
	if got := strings.TrimRight(out.Stdout, "\n"); got != name {
		return fmt.Errorf("%w: %q 는 git 이 %q 로 펼치는 표현이다", ErrRefName, name, got)
	}
	return nil
}

// LocalBranchExists 는 그 이름의 로컬 브랜치가 있는지다. 읽기이므로 Exec 으로
// 간다 — rev-parse 는 쓰기 목록에 없다.
//
// `refs/heads/<name>` 으로 정확히 묻는다. for-each-ref 의 패턴은 `refs/heads/feat`
// 가 `refs/heads/feat/sub` 도 잡으므로 쓰지 않는다.
//
// 없는 ref 의 실패는 실패가 아니다. 그 사실 자체가 답이며, 오류로 올리면 충돌이
// 없을 때 생성이 아예 막힌다.
func (s *Service) LocalBranchExists(ctx context.Context, repo, name string) (bool, error) {
	if err := checkRefArg("name", name); err != nil {
		return false, err
	}
	if _, err := s.Exec(ctx, repo, "rev-parse", "--verify", branchRefPrefix+name); err != nil {
		var xe *ExecError
		if errors.As(err, &xe) && xe.kind == nil {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// checkNewBranchName 은 "이 이름으로 새 브랜치를 만들 수 있는가" 다 — 규칙 위반과
// 이름 충돌을 한 자리에서 본다. Checkout 과 BranchCreate 가 나눠 쓴다.
func (s *Service) checkNewBranchName(ctx context.Context, repo, name string) error {
	if err := s.ValidBranchName(ctx, repo, name); err != nil {
		return err
	}
	exists, err := s.LocalBranchExists(ctx, repo, name)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("%w: 로컬 브랜치 %q 가 이미 있다", ErrBranchExists, name)
	}
	return nil
}

// refNameError 는 실패가 "이름 규칙 위반" 이면 그것으로 갈라 준다. 저장소 실패와
// 구분되지 않으면 사용자는 이름을 고치면 되는지 알 수 없다.
func refNameError(name string, err error) error {
	var xe *ExecError
	if !errors.As(err, &xe) || xe.kind != nil {
		return err
	}
	if strings.Contains(strings.ToLower(xe.Stderr), refNameInvalidStderr) {
		return fmt.Errorf("%w: %q 는 git 의 브랜치 이름 규칙을 어긴다", ErrRefName, name)
	}
	return err
}

// checkRefArg 는 위치 인자로 들어갈 ref 이름을 본다 (FR-GIT-62). checkRev 와 같은
// 정신이되 더 좁다 — 옵션처럼 생긴 값과 범위 표현을 인자로 넘기기 전에 막는다.
//
// **규칙 전체를 여기서 판정하지 않는다.** 그것은 check-ref-format 의 일이며, 여기서
// 막는 것은 git 에 넘기는 순간 뜻이 달라지는 값뿐이다.
func checkRefArg(name, val string) error {
	if strings.TrimSpace(val) == "" {
		return fmt.Errorf("%w: %s 가 비었다", ErrRefName, name)
	}
	if strings.HasPrefix(val, "-") {
		return fmt.Errorf("%w: %s 는 - 로 시작할 수 없다: %q", ErrRefName, name, val)
	}
	if strings.ContainsRune(val, 0) {
		return fmt.Errorf("%w: %s 에 NUL 이 있다", ErrRefName, name)
	}
	if strings.Contains(val, "..") {
		return fmt.Errorf("%w: %s 에 범위 표현(..) 이 있다: %q", ErrRefName, name, val)
	}
	return nil
}
