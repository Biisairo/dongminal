package write

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"dongminal/internal/webserver/domain/git/core"
)

// 커밋 하나를 대상으로 하는 동작 (GIT_ACTIONS_SRS §3.4 / FR-GIT-263~266).
//
// History 의 커밋 행이 줄 수 있는 것들이다: cherry-pick · revert · reset · drop.
// 넷은 대상이 같고(커밋 하나) 위험도가 다르므로 **파괴 선언을 옵션에서 파생한다**
// (FR-GIT-250.1) — 하위 명령만 보면 `reset --soft` 와 `reset --hard` 가 같아진다.
//
// **충돌은 실패가 아니다.** cherry-pick·revert·drop 은 충돌로 멈추면 저장소에
// 중간 상태를 남기며, 그 상태의 출구는 이미 있다 (FR-GIT-251·252). 여기서 그것을
// 실패로 뭉개거나 새 출구를 만들지 않는다.

// Pick 의 동사. 두 동작은 argv 의 첫 낱말과 `--no-commit` 의 유무만 다르므로 한
// 자리에서 만든다 — 두 벌로 두면 부모 번호 방어가 한쪽에만 남는다.
const (
	PickCherry = "cherry-pick"
	PickRevert = "revert"
)

// reset 의 모드. **첫 값이 기본이고 그것이 git 의 기본이다** (FR-GIT-173·265).
const (
	ResetSoft  = "soft"
	ResetMixed = "mixed"
	ResetHard  = "hard"
)

// ResetModes 는 다이얼로그가 보일 순서다. **API 로 노출한다** — 클라이언트가
// 목록을 복제하면 서버가 모드를 늘리거나 줄여도 화면이 따라오지 못한다.
// 파괴적인 것이 마지막이다 (O14).
var ResetModes = []string{ResetMixed, ResetSoft, ResetHard}

var (
	// ErrPickVerb 는 cherry-pick·revert 가 아닌 것을 이 자리로 보냈다는 것이다.
	ErrPickVerb = errors.New("pick_verb_invalid")
	// ErrMergeParent 는 머지 커밋인데 부모 번호가 없다는 것이다 (FR-GIT-263).
	// **묻지 않고 고르면 틀린 부모를 집는다** — 결과는 되돌리기 전까지 알 수 없다.
	ErrMergeParent = errors.New("merge_parent_required")
	// ErrResetMode 는 모르는 reset 모드다.
	ErrResetMode = errors.New("reset_mode_invalid")
)

// PickOpts 는 cherry-pick·revert 한 번의 선택이다.
//
// Merge 는 **저장소가 답하는 사실**이지 요청이 정하는 값이 아니다 (`Pick` 이 실행
// 전에 다시 묻는다). 요청이 그것을 거짓으로 보내도 부모 번호 없는 머지는 실행되지
// 않는다 — 클라이언트만 막으면 API 직접 호출이 그대로 우회한다 (FR-GIT-250.3).
type PickOpts struct {
	Oid      string `json:"oid"`
	Merge    bool   `json:"merge"`
	Mainline int    `json:"mainline"` // 머지 커밋의 부모 번호 (1-based)
	NoCommit bool   `json:"noCommit"` // revert 의 --no-commit (FR-GIT-264)
}

// ResetOpts 는 "Reset to here" 한 번의 선택이다 (FR-GIT-265).
type ResetOpts struct {
	Oid  string `json:"oid"`
	Mode string `json:"mode"` // soft | mixed | hard. 비면 mixed
}

// PickArgs 는 선택을 argv 로 옮긴다. **실행하지 않는다** — 서버가 잘못된 요청을
// 실행 전에 400 으로 답할 수 있어야 하고, 테스트가 "무엇을 실행하지 않았는가"를
// 볼 수 있어야 한다 (FR-GIT-250 의 4겹 계약, `CheckoutArgs` 의 선례).
//
//	git cherry-pick [-m <n>] <oid>
//	git revert      [-m <n>] [--no-commit] <oid>
func PickArgs(verb string, o PickOpts) ([]string, error) {
	if verb != PickCherry && verb != PickRevert {
		return nil, fmt.Errorf("%w: %q", ErrPickVerb, verb)
	}
	if err := core.CheckRefArg("oid", o.Oid); err != nil {
		return nil, err
	}
	// `--no-commit` 은 revert 의 옵션이다 (FR-GIT-264). 요구되지 않은 것을 받으면
	// 화면이 줄 수 있는 것처럼 보이고, 눌리면 뜻이 다른 결과가 나온다.
	if o.NoCommit && verb != PickRevert {
		return nil, fmt.Errorf("%w: --no-commit 은 %s 의 옵션이다", ErrPickVerb, PickRevert)
	}
	switch {
	case o.Merge && o.Mainline < 1:
		return nil, fmt.Errorf("%w: 머지 커밋 %s 는 부모 번호를 받아야 한다", ErrMergeParent, o.Oid)
	case !o.Merge && o.Mainline != 0:
		return nil, fmt.Errorf("%w: 머지 커밋이 아닌 %s 에 부모 번호를 줄 수 없다", ErrMergeParent, o.Oid)
	}
	argv := []string{verb}
	if o.Merge {
		argv = append(argv, "-m", strconv.Itoa(o.Mainline))
	}
	if o.NoCommit {
		argv = append(argv, "--no-commit")
	}
	return append(argv, o.Oid), nil
}

// ResetArgs 는 모드를 argv 로 옮긴다. 모드를 생략하면 `--mixed` 다 — 빠진 값이
// `--hard` 로 떨어지면 안전한 기본이 뜻을 잃는다 (FR-GIT-97).
func ResetArgs(o ResetOpts) ([]string, error) {
	if err := core.CheckRefArg("oid", o.Oid); err != nil {
		return nil, err
	}
	mode := o.Mode
	if mode == "" {
		mode = ResetMixed
	}
	if mode != ResetSoft && mode != ResetMixed && mode != ResetHard {
		return nil, fmt.Errorf("%w: %q", ErrResetMode, o.Mode)
	}
	return []string{"reset", "--" + mode, o.Oid}, nil
}

// DropArgs 는 커밋 하나를 히스토리에서 빼는 argv 다 (FR-GIT-266).
//
//	git rebase --onto <oid>^ <oid>
//
// `<oid>^` 는 그 커밋의 첫 부모다. 루트 커밋에는 부모가 없고 머지 커밋은 첫 부모만
// 남기므로 둘 다 이 형태로 뺄 수 없다 — 그 판정은 대상을 아는 자리(화면·핸들러)가
// 하고, 여기서는 argv 만 만든다.
func DropArgs(oid string) ([]string, error) {
	if err := core.CheckRefArg("oid", oid); err != nil {
		return nil, err
	}
	return []string{"rebase", "--onto", oid + "^", oid}, nil
}

// Reset 은 현재 브랜치를 그 커밋으로 옮긴다 (FR-GIT-265).
//
// **`--hard` 만 파괴적이다** (`reset_hard`) — soft·mixed 는 워킹 트리를 건드리지
// 않으므로 잃는 것이 없다. headOid 는 **옮기기 전** HEAD 이며 hint 가 그것을 싣는다
// (FR-GIT-250.2): 안내문만 남기면 되살릴 수 없다.
func Reset(s *core.Service, ctx context.Context, repo string, o ResetOpts, headOid string) (core.Output, error) {
	argv, err := ResetArgs(o)
	if err != nil {
		return denied(), err
	}
	hard := o.Mode == ResetHard
	if hard {
		// 실행 **전에** 남긴다 (FR-GIT-92). 실행 후에 남기면 실패한 경로에서 hint 가
		// 없고, 사용자는 무엇을 잃었는지조차 알 수 없다.
		s.AddHint(restoreHeadHint(repo, core.ActionResetHard, o.Oid, headOid,
			"워킹 트리와 index 를 그 커밋으로 되돌린다. 저장하지 않은 변경은 git 에 남은 적이 없어 되살릴 값이 없다."))
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv, Destructive: hard})
}

// DropSpec 은 커밋 하나를 히스토리에서 빼는 spec 과 recovery hint 다 (FR-GIT-266).
//
// **파괴적이다** (`commit_drop`) — 뒤따르는 커밋의 해시가 전부 바뀌고, 되살리려면
// 옮기기 전 HEAD 를 알아야 한다. 그것이 hint 에 실린다 (FR-GIT-250.2). hint 는 잡
// 등록이 성공한 뒤 호출자가 남긴다.
//
// 충돌하면 rebase 가 멈춘 채로 남는다 — 진행 중 상태이며 출구는 이미 있다
// (FR-GIT-251·252).
func DropSpec(repo, oid, headOid string) (core.WriteSpec, core.Hint, error) {
	argv, err := DropArgs(oid)
	if err != nil {
		return core.WriteSpec{}, core.Hint{}, err
	}
	hint := restoreHeadHint(repo, core.ActionCommitDrop, oid, headOid,
		"그 커밋을 빼고 뒤따르는 커밋을 다시 얹는다. 해시가 전부 바뀐다.")
	return core.WriteSpec{Argv: argv, Destructive: true}, hint, nil
}

// restoreHeadHint 는 **옮기기 전 HEAD 로 되돌아가는 명령**이다 (FR-GIT-250.2).
//
// headOid 가 비면 명령을 지어내지 않는다 — 실행하면 다른 곳으로 가는 명령을
// 되살리기용으로 내미는 것이 안내문만 남기는 것보다 나쁘다.
func restoreHeadHint(repo, action, target, headOid, note string) core.Hint {
	h := core.Hint{Repo: repo, Action: action, Targets: []string{target}, Note: note}
	if headOid == "" {
		return h
	}
	h.Values = []string{headOid}
	h.Command = "git reset --hard " + headOid
	return h
}
