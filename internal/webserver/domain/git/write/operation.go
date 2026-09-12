package write

import (
	"context"
	"errors"
	"fmt"
	"sort"

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
	// GIT_DETECT_TIER_SRS FR-GDT-19·20 (`11 GP-18`): **`git am` 의 출구는
	// `git am` 이다.**
	//
	//   이전 동작: `rebase-apply` 를 리베이스로 읽었으므로 출구가
	//             `git rebase --continue/--abort` 였다 — `git am` 진행 중에는
	//             맞지 않는 명령이고, 눌리면 실패 문구로만 끝났다
	//   새  동작: 자기 명령을 낸다
	//   이유:     출구는 **그 상태의 명령**이어야 한다 (FR-GDT-20)
	query.OpAm: {
		OpContinue: {"am", "--continue"},
		OpAbort:    {"am", "--abort"},
		OpSkip:     {"am", "--skip"},
	},
	// FR-GDT-18·20: bisect 는 **나가는 길 하나뿐이다.** `good`/`bad` 는 탐색의
	// 진행이며 이 표면이 제공하는 동작이 아니다 — 열어 두면 화면에 없는 조작이
	// API 직접 호출로 들어온다 (`guardInitArgs` 와 같은 근거).
	query.OpBisect: {
		OpAbort: {"bisect", "reset"},
	},
}

// OperationKinds 는 출구를 가진 종류 전부다. **정렬돼 있다** — 응답이 회차마다
// 달라지면 그것만으로 클라이언트가 다시 그린다.
//
// GIT_DETECT_TIER_SRS FR-GDT-18·19: 이 목록을 **파생시킨다.**
//
//	이전 동작: `handlers_git_policy.go` 가 네 종류를 손으로 적었다
//	새  동작: `operationVerbs` 에서 나온다
//	이유:     `am`·`bisect` 를 더했을 때 그 손으로 적은 목록이 따라오지 않아
//	          화면에 출구 버튼이 하나도 서지 않았다 (V-GDT-10 이 잡았다).
//	          목록이 둘이면 한쪽만 고쳐진다
func OperationKinds() []string {
	out := make([]string, 0, len(operationVerbs))
	for k := range operationVerbs {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
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
