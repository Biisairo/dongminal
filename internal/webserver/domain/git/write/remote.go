package write

import (
	"context"
	"errors"
	"fmt"
	"strings"

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
	// ErrPushTarget 은 지목한 remote/branch 가 인자로 넘길 수 없는 값이라는
	// 것이다 (FR-GIT-271·250.3).
	ErrPushTarget = errors.New("push_target_invalid")
	// ErrRemoteName 은 원격 이름 규칙을 어긴 이름이다 (FR-GIT-269).
	ErrRemoteName = errors.New("remote_name_invalid")
	// ErrRemoteURL 은 인자로 넘길 수 없는 URL 이다.
	ErrRemoteURL = errors.New("remote_url_invalid")
	// ErrRemoteExists 는 같은 이름의 원격이 이미 있다는 것이다.
	ErrRemoteExists = errors.New("remote_exists")
	// ErrRemoteMissing 은 지우려는 원격이 없다는 것이다.
	ErrRemoteMissing = errors.New("remote_missing")
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
//
// Remote·Branch 는 Push preview 가 고친 대상이다 (FR-GIT-271). **둘은 함께 온다** —
// 반쪽만 오면 무엇을 어디로 미는지가 반쪽이다. 지정하면 upstream 을 건드리지
// 않는 것이 기본이고, `-u` 는 Publish 로 사용자가 명시할 때만 붙는다 (FR-GIT-97).
type PushOpts struct {
	Force   string `json:"force"`
	Confirm bool   `json:"confirm"`
	Publish bool   `json:"publish"`
	Remote  string `json:"remote"`
	Branch  string `json:"branch"`
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

	// 대상을 지목한 push (FR-GIT-271). 저장소의 upstream 을 보지 않는다 — 사용자가
	// 미리보기에서 고른 것이 그대로 대상이다.
	if o.Remote != "" || o.Branch != "" {
		if terr := checkPushTarget(o.Remote, o.Branch); terr != nil {
			return core.WriteSpec{}, plan, terr
		}
		plan.Remote, plan.Branch, plan.Publish = o.Remote, o.Branch, o.Publish
		if o.Publish {
			argv = append(argv, "-u")
		}
		spec.Argv = append(argv, o.Remote, o.Branch)
		return spec, plan, nil
	}

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

// checkPushTarget 은 위치 인자로 들어갈 대상 한 쌍을 본다 (FR-GIT-250.3).
// **클라이언트만 막으면 API 직접 호출이 우회한다.**
func checkPushTarget(remote, branch string) error {
	if err := CheckRemoteName(remote); err != nil {
		return fmt.Errorf("%w: %v", ErrPushTarget, err)
	}
	if err := core.CheckRefArg("branch", branch); err != nil {
		return fmt.Errorf("%w: %v", ErrPushTarget, err)
	}
	return nil
}

// PushRange 는 outgoing 커밋 목록의 리비전 범위다 (FR-GIT-271).
//
// **새 조회를 만들지 않는다** — 이 문자열이 query.LogQuery.Ref 로 그대로 들어간다.
// 원격에 그 브랜치가 아직 없으면 범위가 없다: 브랜치의 커밋 전부가 올라간다.
func PushRange(upstream, branch string) string {
	if upstream == "" {
		return branch
	}
	return upstream + ".." + branch
}

// ── Sync (FR-GIT-270) ──

// sync 한 번의 단계. **순서가 곧 규약이다** — pull 이 먼저이고, 앞이 실패하면
// 뒤를 돌리지 않는다.
const (
	SyncStepPull = "pull"
	SyncStepPush = "push"
)

// SyncSteps 는 그 순서다. 화면이 "1/2" 를 말하려면 몇 단계인지 알아야 한다.
var SyncSteps = []string{SyncStepPull, SyncStepPush}

// StepOutcome 은 앞 단계가 어떻게 끝났는가다. job 을 그대로 받지 않는 이유는
// 판정이 순수해야 하기 때문이다 — 순수해야 "돌리지 않았다"를 단위로 고정할 수
// 있고, 그 고정이 이 요구사항의 전부다 (V197).
type StepOutcome struct {
	ExitCode int    `json:"exitCode"`
	Err      string `json:"err,omitempty"`
	Canceled bool   `json:"canceled"`
}

// OK 는 뒤를 돌려도 되는가다. exit 만 보지 않는다 — 취소도 사유가 있는 종료이고,
// 취소한 pull 뒤에 push 가 도는 것은 사용자가 요청한 적 없는 일이다.
func (o StepOutcome) OK() bool { return o.ExitCode == 0 && o.Err == "" && !o.Canceled }

// SyncNext 는 앞 단계의 결과를 보고 다음 단계를 정한다 (FR-GIT-270).
//
// **앞이 실패하면 뒤를 돌리지 않는다.** 멈출 때는 사유를 함께 준다 — 조용히
// 멈추면 사용자는 push 가 돈 줄 안다.
func SyncNext(step string, prev StepOutcome) (next string, run bool, reason string) {
	switch step {
	case "":
		return SyncStepPull, true, ""
	case SyncStepPull:
		if prev.OK() {
			return SyncStepPush, true, ""
		}
		return "", false, syncStopReason(prev)
	case SyncStepPush:
		// 마지막 단계다. 멈춘 것이 아니므로 사유가 없다.
		return "", false, ""
	}
	return "", false, fmt.Sprintf("%q 는 sync 의 단계가 아니다", step)
}

func syncStopReason(o StepOutcome) string {
	switch {
	case o.Canceled:
		return "pull 을 취소해 push 를 돌리지 않았다"
	case o.Err != "":
		return "pull 이 실패해 push 를 돌리지 않았다: " + o.Err
	}
	return fmt.Sprintf("pull 이 exit %d 로 끝나 push 를 돌리지 않았다", o.ExitCode)
}

// ── 원격 목록 add / remove (FR-GIT-269) ──

// RemoteRemoveAction 은 remove 의 recovery hint 이름이다. **파괴적 목록에 없다** —
// 설정만 지우므로 2단계 확인의 대상이 아니고, 그럼에도 되살릴 명령은 남긴다
// (FR-GIT-92).
const RemoteRemoveAction = "remote_remove"

// remoteNameBad 는 원격 이름에 들 수 없는 문자다. git 은 `refs/remotes/<name>/…`
// 를 만들므로 슬래시가 들면 그것은 이름이 아니다.
const remoteNameBad = "/ \t\n\r~^:?*[\\"

// CheckRemoteName 은 원격 이름을 실행 **전에** 본다 (FR-GIT-250.3).
func CheckRemoteName(name string) error {
	if err := core.CheckRefArg("remote", name); err != nil {
		return fmt.Errorf("%w: %v", ErrRemoteName, err)
	}
	if strings.ContainsAny(name, remoteNameBad) {
		return fmt.Errorf("%w: 원격 이름에 쓸 수 없는 문자가 있다: %q", ErrRemoteName, name)
	}
	return nil
}

// CheckRemoteURL 은 URL 이 인자로 들어갈 수 있는 값인지 본다.
//
// **모양을 판정하지 않는다** — git 이 아는 전송 방식은 우리가 아는 것보다 많고,
// 여기서 좁히면 정상 URL 이 막힌다. 막는 것은 git 에 넘기는 순간 뜻이 달라지는
// 값뿐이다: 옵션처럼 생긴 값, NUL, 인자를 가르는 공백.
func CheckRemoteURL(u string) error {
	if strings.TrimSpace(u) == "" {
		return fmt.Errorf("%w: URL 이 비었다", ErrRemoteURL)
	}
	if strings.HasPrefix(u, "-") {
		return fmt.Errorf("%w: URL 은 - 로 시작할 수 없다: %q", ErrRemoteURL, u)
	}
	if strings.ContainsRune(u, 0) {
		return fmt.Errorf("%w: URL 에 NUL 이 있다", ErrRemoteURL)
	}
	if strings.ContainsAny(u, " \t\n\r") {
		return fmt.Errorf("%w: URL 에 공백이 있다: %q", ErrRemoteURL, u)
	}
	return nil
}

// RemoteAddArgs 는 `git remote add` 의 argv 다. git 을 돌리지 않는다 —
// 서버가 잘못된 요청을 실행 **전에** 400 으로 답할 수 있어야 한다 (FR-GIT-250 ①).
func RemoteAddArgs(name, u string) ([]string, error) {
	if err := CheckRemoteName(name); err != nil {
		return nil, err
	}
	if err := CheckRemoteURL(u); err != nil {
		return nil, err
	}
	return []string{"remote", "add", name, u}, nil
}

// RemoteRemoveArgs 는 `git remote remove` 의 argv 다.
func RemoteRemoveArgs(name string) ([]string, error) {
	if err := CheckRemoteName(name); err != nil {
		return nil, err
	}
	return []string{"remote", "remove", name}, nil
}

// RemoteAdd 는 원격을 더한다. 파괴적이 아니다 — 설정 한 줄이 생길 뿐이다.
//
// 같은 이름이 있으면 **우리 코드로** 거부한다. git 도 막지만 사유가 stderr 로만
// 오면 클라이언트가 무엇을 할지 정할 수 없다.
func RemoteAdd(s *core.Service, ctx context.Context, repo, name, u string) (core.Output, error) {
	argv, err := RemoteAddArgs(name, u)
	if err != nil {
		return denied(), err
	}
	list, err := query.Remotes(s, ctx, repo)
	if err != nil {
		return denied(), err
	}
	if _, ok := remoteAt(list, name); ok {
		return denied(), fmt.Errorf("%w: 원격 %q 가 이미 있다", ErrRemoteExists, name)
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
}

// RemoteRemove 는 원격을 지운다. **파괴적이 아니다** — 저장소의 객체는 그대로이고
// 설정만 사라진다. 그럼에도 recovery hint 를 남긴다 (FR-GIT-269): 지운 뒤에는
// URL 을 읽을 자리가 없고, 안내문만으로는 되살릴 수 없다 (FR-GIT-92).
//
// hint 는 실행 **전에** 남긴다 — 실행 후에 남기면 실패한 경로에서는 아예 없다.
func RemoteRemove(s *core.Service, ctx context.Context, repo, name string) (core.Output, error) {
	argv, err := RemoteRemoveArgs(name)
	if err != nil {
		return denied(), err
	}
	list, err := query.Remotes(s, ctx, repo)
	if err != nil {
		return denied(), err
	}
	cur, ok := remoteAt(list, name)
	if !ok {
		// 지우지 않은 것의 복구 안내는 거짓이므로 hint 도 남기지 않는다.
		return denied(), fmt.Errorf("%w: 원격 %q 가 없다", ErrRemoteMissing, name)
	}
	s.AddHint(remoteRemoveHint(repo, cur))
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv})
}

func remoteAt(list []query.Remote, name string) (query.Remote, bool) {
	for _, r := range list {
		if r.Name == name {
			return r, true
		}
	}
	return query.Remote{}, false
}

// remoteRemoveHint 는 되살릴 `git remote add` 다.
//
// **URL 은 지운 값이다** (FR-GIT-104). hint 는 세션 동안 보관되고 화면으로 나가므로
// 자격증명이 박힌 URL 을 그대로 실을 수 없다 — 그 자리는 `***` 이고, 그때는 그
// 부분만 사용자가 다시 채워야 한다는 것을 Note 가 말한다.
func remoteRemoveHint(repo string, r query.Remote) core.Hint {
	note := "원격 설정만 지운다 — 가져온 객체와 refs/remotes 는 위 명령과 fetch 로 되살아난다."
	if strings.Contains(r.URL, "***") {
		note += " URL 에 자격증명이 박혀 있어 그 자리를 지웠다: 직접 채워 넣어야 한다."
	}
	return core.Hint{
		Repo:    repo,
		Action:  RemoteRemoveAction,
		Targets: []string{r.Name},
		Values:  []string{r.URL},
		Command: fmt.Sprintf("git remote add %s %s", r.Name, r.URL),
		Note:    note,
	}
}
