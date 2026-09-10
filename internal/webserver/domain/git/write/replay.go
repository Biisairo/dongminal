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
	if rec.Write {
		return s.ExecWrite(ctx, repo, core.WriteSpec{Argv: rec.Argv, Destructive: rec.Destructive})
	}
	return s.Exec(ctx, repo, rec.Argv...)
}
