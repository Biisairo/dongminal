package write

import (
	"context"
	"errors"
	"fmt"

	"dongminal/internal/webserver/domain/git/core"
)

// Console 의 replay (GIT_ACTIONS_SRS §3.8 / FR-GIT-281).
//
// **argv 는 클라이언트가 주지 않는다.** 서버가 자기 기록(`Recorder`)에서 꺼낸 것만
// 다시 돌린다 — 문자열을 받아 실행하면 그것이 곧 임의 명령 표면이고, FR-GIT-95 의
// 두 진입점을 우회하는 세 번째 길이 된다 (묶음 G 의 패치와 같은 근거, D6).
//
// 다시 도는 것도 **같은 문을 지난다**: 쓰기였으면 ExecWrite, 읽기였으면 Exec 이다.
// 그러므로 replay 도 기록에 남고, 파괴적 선언도 원래 것을 그대로 물려받는다.

// ErrReplayTarget 은 다시 돌릴 수 없는 기록이다 — 빈 argv, 또는 다른 저장소의 것.
var ErrReplayTarget = errors.New("replay_target_invalid")

// Replay 는 기록 하나를 그 저장소에서 다시 실행한다.
//
// repo 는 **호출자가 이미 정규화한 루트**이고, 기록의 cwd 와 같아야 한다. 다른
// 저장소의 기록을 여기로 끌어오면 화면에 보이지 않던 저장소가 바뀐다.
//
// 커버리지 주의 (M8 TEST-24): 함수 단위 0% 는 결손이 아니다 — 계약(cwd 불일치 거부
// ErrReplayTarget·argv 재실행)은 gitapi 의 handlers_git_replay_test.go 다섯 건이 HTTP
// 종단에서 시험한다. 여기 실제 git 을 돌리는 테스트를 더하지 않는다 (로드맵 §1.6 정정).
func Replay(s *core.Service, ctx context.Context, repo string, rec core.Record) (core.Output, error) {
	if len(rec.Argv) == 0 {
		return denied(), fmt.Errorf("%w: argv 가 비었다", ErrReplayTarget)
	}
	if rec.Cwd != repo {
		return denied(), fmt.Errorf("%w: 다른 저장소의 기록이다: %q", ErrReplayTarget, rec.Cwd)
	}
	// 인가를 지나지 않은 기록은 다시 돌리지 않는다 (GIT_EXEC_UNIFY_SRS FR-GXU-6).
	//
	// `domain/worktree`·`domain/submodule` 의 argv 는 화이트리스트에 없으므로 아래
	// 두 진입점이 어차피 막는다. **그 우연에 기대지 않는다** — 거부의 사유가
	// 다르고, 화이트리스트가 바뀌면 그 방어가 소리 없이 사라진다. 그 argv 들의
	// 인가는 자기 도메인에 있으며(checkRepo·checkPath·`--` 규약), replay 는 그
	// 도메인을 지나지 않는다.
	if rec.Unguarded {
		return denied(), fmt.Errorf("%w: 인가를 지나지 않은 기록이다 (%s)", ErrReplayTarget, rec.Reason)
	}
	// REPO_FIX 01 §7.5: 다시 돌리면 **다른 결과**가 되는 기록은 거절한다.
	//
	//	이전 동작: 그대로 재실행 — stdin 기록(커밋·태그·패치)은 내용 없이 돌아
	//	          태그는 빈 메시지 annotated tag 가 exit 0 으로 생겼다(실측),
	//	          stash 기록은 지금 그 위치의 다른 stash 를 건드렸다
	//	새  동작: 실행 전 거절
	//	이유:     stdin 내용은 기록되지 않고(I6), stash 는 위치로 기록된다
	if rec.StdinBytes > 0 {
		return denied(), fmt.Errorf("%w: stdin 으로 넘긴 내용은 기록되지 않아 다시 실행할 수 없다", ErrReplayTarget)
	}
	if rec.Write && rec.Argv[0] == "stash" {
		return denied(), fmt.Errorf("%w: stash 는 위치로 기록돼 지금 다시 실행하면 다른 stash 를 건드릴 수 있다", ErrReplayTarget)
	}
	if rec.Write {
		return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: rec.Argv, Destructive: rec.Destructive})
	}
	return s.Exec(ctx, repo, rec.Argv...)
}
