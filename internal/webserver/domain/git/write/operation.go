package write

import (
	"context"
	"errors"
	"fmt"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 진행 중 작업의 출구 (GIT_ACTIONS_SRS §3.1 / FR-GIT-252).
//
// merge·rebase·cherry-pick·revert 는 충돌하면 멈춘 채 중간 상태를 남긴다. 그
// 상태에서 나갈 길이 없으면 사용자는 GUI 안에 갇힌다 — 진행 중인지 판정하는 것은
// `query.DetectOperation` 이고, 여기는 **그 판정이 고른 종류에 맞는 출구**를 만든다.
//
// 종류를 여기서 다시 정의하지 않는다 — `query.Op*` 를 그대로 쓴다. 두 벌이면
// 화면이 말하는 종류와 실행되는 명령이 갈린다.

// 출구 셋. `skip` 은 종류에 따라 없을 수 있다.
const (
	OpContinue = "continue"
	OpAbort    = "abort"
	OpSkip     = "skip"
)

// ErrOperation 은 이 조합으로는 실행할 것이 없다는 것이다 — 진행 중이 아닌 종류,
// 모르는 동작, 그 종류에 없는 동작(merge 의 skip)이 여기로 온다.
var ErrOperation = errors.New("operation_invalid")

// operationVerbs 는 종류별로 git 이 **실제로 받는** 하위 명령과 플래그다.
//
// **merge 에는 skip 이 없다.** 없는 것을 목록에 넣으면 화면이 누를 수 있는 것처럼
// 보이고, 눌리면 exit 128 의 문구로만 실패한다.
//
// `--continue` 는 편집기를 열 수 있다. `core.Env` 가 `GIT_EDITOR=true` 를 주므로
// git 이 준비해 둔 메시지를 그대로 쓰고 매달리지 않는다 — 사람이 없는 자리에서
// 편집기를 여는 것은 선택이 아니라 매달림이다.
var operationVerbs = map[string]map[string][]string{
	query.OpMerge: {
		OpContinue: {"merge", "--continue"},
		OpAbort:    {"merge", "--abort"},
	},
	query.OpRebase: {
		OpContinue: {"rebase", "--continue"},
		OpAbort:    {"rebase", "--abort"},
		OpSkip:     {"rebase", "--skip"},
	},
	query.OpCherryPick: {
		OpContinue: {"cherry-pick", "--continue"},
		OpAbort:    {"cherry-pick", "--abort"},
		OpSkip:     {"cherry-pick", "--skip"},
	},
	query.OpRevert: {
		OpContinue: {"revert", "--continue"},
		OpAbort:    {"revert", "--abort"},
		OpSkip:     {"revert", "--skip"},
	},
}

// OperationActions 는 그 종류가 실제로 줄 수 있는 출구다. **API 로 노출한다** —
// 클라이언트가 목록을 복제하면 merge 에 없는 skip 버튼이 생긴다.
func OperationActions(kind string) []string {
	verbs, ok := operationVerbs[kind]
	if !ok {
		return []string{}
	}
	// 순서를 고정한다: 계속 → 건너뛰기 → 중단. 파괴적인 것이 마지막이다 (O14).
	out := make([]string, 0, len(verbs))
	for _, a := range []string{OpContinue, OpSkip, OpAbort} {
		if _, ok := verbs[a]; ok {
			out = append(out, a)
		}
	}
	return out
}

// OperationArgs 는 조합을 argv 로 옮긴다. **실행하지 않는다** — 서버가 잘못된 요청을
// 실행 전에 400 으로 답할 수 있어야 하고, 판정이 두 벌이면 한쪽만 고쳐진다
// (FR-GIT-250 의 4겹 계약).
func OperationArgs(kind, action string) ([]string, error) {
	verbs, ok := operationVerbs[kind]
	if !ok {
		return nil, fmt.Errorf("%w: 진행 중 작업이 아니다: %q", ErrOperation, kind)
	}
	argv, ok := verbs[action]
	if !ok {
		return nil, fmt.Errorf("%w: %q 에 %q 는 없다", ErrOperation, kind, action)
	}
	return append([]string(nil), argv...), nil
}

// Operation 은 진행 중 작업의 출구 하나를 실행한다 (FR-GIT-252).
//
// **중단만 파괴적이다** — 그 작업 중 해결한 내용이 사라지고, 되살릴 값이 없다.
// 계속·건너뛰기는 되돌릴 것이 없으므로 2단계 확인을 요구하지 않는다.
//
// **충돌이 남아 있는지 우리가 미리 판정하지 않는다.** git 이 거부하면 그 사유를
// 그대로 올린다 — 판정을 두 벌로 두면 우리 쪽이 낡았을 때 사용자가 갈 곳을 잃는다.
func Operation(s *core.Service, ctx context.Context, repo, kind, action string) (core.Output, error) {
	argv, err := OperationArgs(kind, action)
	if err != nil {
		return denied(), err
	}
	return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: argv, Destructive: action == OpAbort})
}
