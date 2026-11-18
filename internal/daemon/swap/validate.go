// Package swap 은 데몬 교체(세션 유지 재시작)의 데몬 쪽이다 (DAEMON_SESSION_KEEP_SRS 묶음 H·R).
//
// 교체 요청을 검사하고(FR-DSK-11), 새 바이너리를 미리 실행해 인계 판을 맞춰 본다(FR-DSK-12).
package swap

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/handover"
)

// Env 는 검사가 기대는 프로세스 사실이다. 시험이 갈아 끼운다.
type Env struct {
	EUID int
	GOOS string
	// SelfExe 는 데몬 자신의 실행 파일(심볼릭 링크를 푼 경로)이다. 기동 때 한 번 정한다 —
	// 빌드가 같은 자리를 덮어쓰면 Linux 의 /proc/self/exe 는 지워진 파일을 가리키기 때문이다.
	SelfExe string
}

// refuse 는 "<사유 코드>: <설명>" 꼴의 거절이다. 보고 소켓이 그대로 답한다.
func refuse(reason, format string, args ...any) error {
	return fmt.Errorf("%s: %s", reason, fmt.Sprintf(format, args...))
}

// Validate 는 교체 요청을 받아들일지 본다 (FR-DSK-11). nil 이면 받아들인다.
func Validate(req handover.ReloadRequest, env Env) error {
	if env.GOOS == "windows" {
		return refuse(handover.ReasonUnsupported, "이 OS 는 세션 유지 교체를 지원하지 않습니다")
	}
	if req.Handover != handover.Version {
		return refuse(handover.ReasonVersion, "인계 판이 다릅니다 (요청 %d, 데몬 %d)", req.Handover, handover.Version)
	}
	if !filepath.IsAbs(req.Exe) {
		return refuse(handover.ReasonExe, "절대경로가 아닙니다: %q", req.Exe)
	}
	fi, err := os.Stat(req.Exe)
	switch {
	case err != nil:
		return refuse(handover.ReasonExe, "%v", err)
	case !fi.Mode().IsRegular():
		return refuse(handover.ReasonExe, "일반 파일이 아닙니다: %s", req.Exe)
	case fi.Mode().Perm()&0o111 == 0:
		return refuse(handover.ReasonExe, "실행할 수 없습니다: %s", req.Exe)
	}
	if uid, ok := fileOwner(fi); !ok || uid != env.EUID {
		return refuse(handover.ReasonExe, "파일 소유자가 데몬 사용자가 아닙니다: %s", req.Exe)
	}
	// 보안: 교체 대상은 데몬 자신의 실행 파일 자리뿐이다. 같은 사용자 소유라도 다른 자리의
	// 바이너리(샌드박스가 마운트한 폴더에 둔 파일 등)는 exec 하지 않는다. 이 자리를 덮어쓸
	// 수 있는 쪽은 다음 재시작 때도 어차피 실행되므로 교체가 권한을 넓히지 않는다.
	resolved, err := filepath.EvalSymlinks(req.Exe)
	if err != nil || env.SelfExe == "" || resolved != env.SelfExe {
		return refuse(handover.ReasonExe, "데몬 자신의 실행 파일이 아닙니다: %s (데몬 %s) — dongminal start --refresh-daemon 을 쓰세요", req.Exe, env.SelfExe)
	}
	return nil
}

// Preflight 는 exe 를 `d --handover-version` 으로 실행해 같은 인계 판을 말하는지 본다 (FR-DSK-12).
func Preflight(exe string, within time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "d", handover.ArgVersion)
	var out bytes.Buffer
	cmd.Stdout = &out
	// 시한에 죽인 셸의 손자가 출력 파이프를 쥐고 있어도 Wait 가 끝나게 한다.
	cmd.WaitDelay = within
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return refuse(handover.ReasonPreflight, "새 바이너리가 %v 안에 답하지 않았습니다", within)
		}
		return refuse(handover.ReasonPreflight, "새 바이너리 실행 실패: %v", err)
	}
	v, err := strconv.Atoi(strings.TrimSpace(out.String()))
	if err != nil {
		return refuse(handover.ReasonPreflight, "새 바이너리가 인계 판을 말하지 않았습니다: %q", out.String())
	}
	if v != handover.Version {
		return refuse(handover.ReasonPreflight, "새 바이너리의 인계 판이 다릅니다 (%d, 데몬 %d)", v, handover.Version)
	}
	return nil
}

// Gate 는 교체가 한 번에 하나만 진행되게 한다 (FR-DSK-11 reload_busy).
type Gate struct{ busy atomic.Bool }

// Enter 는 진행 중인 교체가 없을 때만 참이다.
func (g *Gate) Enter() bool { return g.busy.CompareAndSwap(false, true) }

// Leave 는 교체가 끝났거나 되돌렸음을 적는다.
func (g *Gate) Leave() { g.busy.Store(false) }
