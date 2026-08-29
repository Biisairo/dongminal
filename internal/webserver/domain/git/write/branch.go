package write

import (
	"context"
	"errors"
	"fmt"
	"strings"

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

// ── 묶음 B — 브랜치 동작 (GIT_ACTIONS_SRS §3.2 FR-GIT-253~259 · §3.5 FR-GIT-268) ──
//
// 접수한 말의 본체다: "branch 삭제, 이름변경 등 기본적인 기능들이 없다."
//
// 규칙은 위와 같다 — 순수 `…Args` 가 argv 만 만들고(FR-GIT-250 ①), 실행은
// `ExecWrite` 하나만 지나며(②), **파괴 여부는 옵션에서 파생해 선언한다**. 목록도
// 이름 검사도 새로 만들지 않는다: Refs 와 ValidBranchName 이 이미 답한다.

// 브랜치 조작의 플래그. 상수로 못박는다 — 호출 지점마다 다른 문자열이 흩어지면
// 무엇이 붙는지 한 자리에서 볼 수 없다.
//
// **`-M` 이 없다** (FR-GIT-253). 기존 ref 를 덮는 것은 이름 변경이 아니다.
const (
	branchRenameFlag        = "-m"
	branchDeleteFlag        = "-d"
	branchDeleteForceFlag   = "-D"
	branchUnsetUpstreamFlag = "--unset-upstream"
	branchSetUpstreamPrefix = "--set-upstream-to="
	// `--delete` 는 태그 삭제(tag.go)와 **같은 플래그**다 — 원격에서 ref 를 지우는
	// 것은 대상이 브랜치든 태그든 같은 명령이므로 상수도 하나다.
	pushUpstreamFlag = "-u"
)

// Merge 의 방식 (FR-GIT-255). 빈 값이 기본이며 그것이 git 의 기본이다 — 여기서
// 기본을 넉넉히 채우면 다이얼로그가 뜻을 잃는다 (FR-GIT-99 와 같은 정신).
const (
	MergeDefault = ""
	MergeFFOnly  = "ff-only"
	MergeNoFF    = "no-ff"
	MergeSquash  = "squash"
)

// 미머지 브랜치의 `-d` 거부 뒤에 사용자가 고를 수 있는 선택지 (FR-GIT-254).
// **API 로 노출한다** — 이름 충돌의 3선택과 같은 규약이며, 클라이언트가 목록을
// 복제하면 서버가 선택지를 늘려도 그것을 보이지 못한다. 기본은 취소다 (O14).
const (
	BranchDeleteForce  = "force_delete"
	BranchDeleteCancel = "cancel"
)

var BranchDeleteOptions = []string{BranchDeleteForce, BranchDeleteCancel}

var (
	// ErrBranchRename 은 이 조합으로 이름을 바꿀 수 없다는 것이다.
	ErrBranchRename = errors.New("branch_rename_invalid")
	// ErrBranchDelete 는 이 조합으로 지울 수 없다는 것이다 — 대상이 없거나,
	// 여러 개를 강제로 지우려 한 경우다.
	ErrBranchDelete = errors.New("branch_delete_invalid")
	// ErrMergeMode 는 다이얼로그가 제공하지 않는 머지 변형이다.
	ErrMergeMode = errors.New("merge_mode_invalid")
	// ErrBranchUpstream 은 set 인지 unset 인지 가릴 수 없는 요청이다.
	ErrBranchUpstream = errors.New("branch_upstream_invalid")
)

// BranchRenameOpts 는 이름 변경 하나의 선택이다 (FR-GIT-253).
type BranchRenameOpts struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// BranchDeleteOpts 는 삭제 한 번의 선택이다 (FR-GIT-254).
//
// **Force 는 하나를 지울 때만 받는다.** 한 번의 확인으로 여러 개를 강제 삭제하는
// 자리를 만들지 않는다 — 다중 선택 일괄 삭제는 `-d` 로만 한다.
type BranchDeleteOpts struct {
	Names []string `json:"names"`
	Force bool     `json:"force"`
}

// BranchDeletePlan 은 지우기 **전에** 잡아 둔 되살릴 값이다 (FR-GIT-250.2).
// 지운 뒤에는 읽을 수 없으므로 실행 전에 잡는다.
type BranchDeletePlan struct {
	Names []string `json:"names"`
	Oids  []string `json:"oids"`
	Force bool     `json:"force"`
}

// MergeOpts 는 머지 다이얼로그의 선택이다 (FR-GIT-255).
type MergeOpts struct {
	Ref  string `json:"ref"`
	Mode string `json:"mode"`
}

// RebaseOpts 는 rebase 한 번의 선택이다 (FR-GIT-256). interactive 는 여기 없다.
type RebaseOpts struct {
	Ref  string `json:"ref"`
	Onto string `json:"onto"`
}

// UpstreamOpts 는 upstream 설정/해제다 (FR-GIT-257). 대상 목록은 원격 ref 목록에서
// 오므로 여기서 새 조회를 만들지 않는다.
type UpstreamOpts struct {
	Branch   string `json:"branch"`
	Upstream string `json:"upstream"`
	Unset    bool   `json:"unset"`
}

// BranchPushOpts 는 대상 브랜치 하나를 미는 선택이다 (FR-GIT-258).
//
// **자격증명을 담는 필드가 없다** (FR-GIT-104) — 만들지 않는 것이 유일한 보장이다.
type BranchPushOpts struct {
	Branch  string `json:"branch"`
	Force   string `json:"force"`
	Confirm bool   `json:"confirm"`
	Publish bool   `json:"publish"`
}

// RemoteBranchOpts 는 원격 브랜치 하나를 가리킨다 (FR-GIT-268). 원격 이름과 브랜치
// 이름을 나눠 받는 이유는 `origin/feat` 를 서버가 다시 쪼개면 원격 이름에 `/` 가 든
// 경우를 가릴 수 없기 때문이다.
type RemoteBranchOpts struct {
	Remote string `json:"remote"`
	Branch string `json:"branch"`
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

// BranchRename 은 브랜치 이름을 바꾼다 (FR-GIT-253).
//
// 새 이름의 검사는 생성과 **같은 자리**를 쓴다 (`checkNewBranchName`) — 규칙 검사와
// 중복 확인이 두 벌이면 한쪽만 고쳐진다.
func BranchRename(s *core.Service, ctx context.Context, repo string, o BranchRenameOpts) (core.Output, error) {
	argv, err := BranchRenameArgs(o)
	if err != nil {
		return denied(), err
	}
	if err := checkNewBranchName(s, ctx, repo, o.To); err != nil {
		return denied(), err
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
}

// BranchDelete 는 브랜치를 지운다. **파괴적이다** (FR-GIT-89·254).
//
// 실행 **전에** 지워질 브랜치의 oid 를 읽어 recovery hint 로 남긴다 (FR-GIT-250.2).
// 실행 후에 읽으면 ref 가 이미 없고, 그러면 hint 는 안내문만 남는다.
func BranchDelete(s *core.Service, ctx context.Context, repo string, o BranchDeleteOpts) (core.Output, BranchDeletePlan, error) {
	argv, err := BranchDeleteArgs(o)
	if err != nil {
		return denied(), BranchDeletePlan{}, err
	}
	plan := BranchDeletePlan{Names: append([]string(nil), o.Names...), Force: o.Force}
	for _, n := range o.Names {
		oid, err := query.BranchOid(s, ctx, repo, n)
		if err != nil {
			// 없는 브랜치의 복구 안내는 거짓이므로 실행도 hint 도 하지 않는다.
			return denied(), plan, err
		}
		plan.Oids = append(plan.Oids, oid)
		s.AddHint(branchDeleteHint(repo, n, oid))
	}
	out, err := s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv, Destructive: true})
	return out, plan, err
}

// Merge 는 대상 ref 를 현재 브랜치에 합친다 (FR-GIT-255).
//
// **파괴적이 아니다** — 충돌로 멈춰도 저장소는 되돌릴 수 있는 중간 상태이고,
// 그 출구는 묶음 A 가 준다 (FR-GIT-251·252).
func Merge(s *core.Service, ctx context.Context, repo string, o MergeOpts) (core.Output, error) {
	argv, err := MergeArgs(o)
	if err != nil {
		return denied(), err
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
}

// Rebase 는 대상 ref 위로 현재 브랜치를 다시 얹는다. **파괴적이다** (FR-GIT-256) —
// 커밋 해시가 바뀌고 되돌리려면 원래 HEAD 를 알아야 한다.
//
// 그래서 실행 **전에** HEAD 의 oid 를 읽어 hint 에 싣는다 (FR-GIT-250.2).
func Rebase(s *core.Service, ctx context.Context, repo string, o RebaseOpts) (core.Output, error) {
	argv, err := RebaseArgs(o)
	if err != nil {
		return denied(), err
	}
	st, err := query.StatusOf(s, ctx, repo)
	if err != nil {
		return denied(), err
	}
	s.AddHint(rebaseHint(repo, o, st.Oid))
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv, Destructive: true})
}

// SetUpstream 은 upstream 을 설정하거나 해제한다 (FR-GIT-257). **파괴적이 아니다**
// — 되돌리는 것이 set 하나다.
func SetUpstream(s *core.Service, ctx context.Context, repo string, o UpstreamOpts) (core.Output, error) {
	argv, err := UpstreamArgs(o)
	if err != nil {
		return denied(), err
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
}

// BranchPushSpec 은 **현재 브랜치가 아닐 수도 있는** 대상 하나를 미는 argv 다
// (FR-GIT-258).
//
// upstream 이 없으면 publish 이며 그 사실을 실행 **전에** 알려야 한다 —
// FR-GIT-100 의 규약을 현재 브랜치가 아닌 대상에도 넓힌 것이다. 확인이 없으면
// 계획만 돌려주고 멈춘다.
//
// force 는 `--force-with-lease` 가 기본이고 `--force` 는 2단계 확인을 거친다
// (FR-GIT-106). 둘 다 파괴적으로 선언한다 — 원격의 커밋을 잃게 할 수 있다.
func BranchPushSpec(s *core.Service, ctx context.Context, repo string, o BranchPushOpts) (core.WriteSpec, PushPlan, error) {
	plan := PushPlan{Force: o.Force, Branch: o.Branch}
	if err := core.CheckRefArg("branch", o.Branch); err != nil {
		return core.WriteSpec{}, plan, err
	}
	argv := []string{"push", progressFlag}
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

	up, err := query.BranchUpstream(s, ctx, repo, o.Branch)
	if err != nil {
		return core.WriteSpec{}, plan, err
	}
	if up != "" {
		plan.Remote = remoteOfUpstream(up)
		spec.Argv = append(argv, plan.Remote, o.Branch)
		return spec, plan, nil
	}
	remote, err := query.DefaultRemote(s, ctx, repo)
	if err != nil {
		return core.WriteSpec{}, plan, err
	}
	plan.Publish, plan.Remote = true, remote
	if !o.Publish {
		return core.WriteSpec{}, plan, fmt.Errorf("%w: %s 를 %s 의 upstream 으로 설정한다",
			ErrPublishRequired, remote+"/"+o.Branch, o.Branch)
	}
	spec.Argv = append(argv, pushUpstreamFlag, remote, o.Branch)
	return spec, plan, nil
}

// RemoteFetchSpec 은 원격 ref 를 **같은 이름의 로컬 ref 로** 가져온다 (FR-GIT-268).
// 파괴적이 아니다 — git 은 fast-forward 가 아니면 거부한다.
func RemoteFetchSpec(o RemoteBranchOpts) (core.WriteSpec, error) {
	if err := checkRemoteBranch(o); err != nil {
		return core.WriteSpec{}, err
	}
	return core.WriteSpec{Argv: []string{"fetch", progressFlag, o.Remote, o.Branch + ":" + o.Branch}}, nil
}

// RemoteBranchDeleteSpec 은 원격의 ref 를 지운다. **파괴적이다** (`remote_ref_delete`).
//
// hint 는 **되살리는 push** 이며 지우기 전 oid 를 싣는다 (FR-GIT-250.2) — 실행은
// 나중에 job 이 하므로 hint 는 여기서, 즉 실행 전에 남긴다.
func RemoteBranchDeleteSpec(s *core.Service, ctx context.Context, repo string, o RemoteBranchOpts) (core.WriteSpec, error) {
	if err := checkRemoteBranch(o); err != nil {
		return core.WriteSpec{}, err
	}
	oid, err := query.RemoteBranchOid(s, ctx, repo, o.Remote+"/"+o.Branch)
	if err != nil {
		return core.WriteSpec{}, err
	}
	s.AddHint(remoteBranchDeleteHint(repo, o, oid))
	return core.WriteSpec{
		Argv:        []string{"push", progressFlag, o.Remote, pushDeleteFlag, o.Branch},
		Destructive: true,
	}, nil
}

func checkRemoteBranch(o RemoteBranchOpts) error {
	if err := CheckRemoteName(o.Remote); err != nil {
		return err
	}
	return core.CheckRefArg("branch", o.Branch)
}

// remoteOfUpstream 은 `origin/feat` 에서 원격 이름을 뽑는다. 첫 조각만 보는 이유는
// 브랜치 이름에 `/` 가 흔하기 때문이다 (`origin/feature/a`).
func remoteOfUpstream(up string) string {
	if i := strings.Index(up, "/"); i > 0 {
		return up[:i]
	}
	return up
}

// branchDeleteHint 는 지워질 브랜치의 oid 로 **되살리는 명령**을 만든다
// (FR-GIT-92·250.2). 안내문만 남기면 되살릴 수 없다.
func branchDeleteHint(repo, name, oid string) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionBranchDelete,
		Targets: []string{name},
		Values:  []string{oid},
		Command: "git branch " + name + " " + oid,
		Note:    "지우기 전 " + name + " 는 " + oid + " 를 가리켰다. 위 명령이 그 자리로 되돌린다.",
	}
}

// rebaseHint 는 rebase 전 HEAD 로 되돌리는 명령이다 (FR-GIT-256). 커밋 해시가
// 바뀌므로 원래 oid 없이는 reflog 를 뒤져야 한다.
func rebaseHint(repo string, o RebaseOpts, head string) core.Hint {
	target := o.Ref
	if o.Onto != "" {
		target = o.Onto + " ← " + o.Ref
	}
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionRebase,
		Targets: []string{target},
		Values:  []string{head},
		Command: "git reset --hard " + head,
		Note:    "rebase 전 HEAD 는 " + head + " 였다. 커밋 해시가 바뀌므로 위 명령이 유일한 되돌림이다.",
	}
}

// remoteBranchDeleteHint 는 지워질 원격 ref 를 되살리는 push 다 (FR-GIT-268).
func remoteBranchDeleteHint(repo string, o RemoteBranchOpts, oid string) core.Hint {
	return core.Hint{
		Repo:    repo,
		Action:  core.ActionRemoteRefDelete,
		Targets: []string{o.Remote + "/" + o.Branch},
		Values:  []string{oid},
		Command: "git push " + o.Remote + " " + oid + ":refs/heads/" + o.Branch,
		Note:    "지우기 전 " + o.Remote + "/" + o.Branch + " 는 " + oid + " 였다. 위 명령이 원격에 그 ref 를 다시 만든다.",
	}
}
