package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"dongminal/internal/shared/handover"
	"dongminal/internal/shared/pollwait"
)

// 교체 요청과 확인의 시한 (FR-DSK-12·17). 요청 시한은 데몬의 사전 확인(5초)과 인계 상태
// 쓰기를 덮는다.
const (
	reloadRequestWithin = 15 * time.Second
	swapConfirmWithin   = 10 * time.Second
	swapConfirmPoll     = 100 * time.Millisecond
	swapHelloWithin     = 500 * time.Millisecond
)

// daemonOps 는 `start` 가 데몬에 하는 일이다. 시험이 가짜로 갈아 끼워, 사용 중인 데몬에
// 닿지 않고 순서를 잰다.
type daemonOps struct {
	running func() bool
	reload  func() handover.Outcome
	confirm func() error
	stop    func() bool
	notice  func() string
}

// prepareDaemon 은 서버를 끄기 **전에** 데몬을 정리한다 (DAEMON_SESSION_KEEP_SRS FR-DSK-1~5).
// proceed 가 거짓이면 호출자는 아무것도 끄지 않고 code 로 끝낸다 (D-DSK-4).
func prepareDaemon(o StartOpts, ops daemonOps, stdout, stderr io.Writer) (proceed bool, code int) {
	switch {
	case o.ServerOnly:
		fmt.Fprintln(stdout, ops.notice())
		return true, 0
	case o.RefreshDaemon:
		fmt.Fprintln(stdout, "dongminald 를 새로 띄웁니다 (터미널 세션을 잃습니다)...")
		ops.stop()
		return true, 0
	case !ops.running():
		fmt.Fprintln(stdout, "dongminald 미실행 — dongminal 이 자동 기동합니다")
		return true, 0
	}

	fmt.Fprintln(stdout, "dongminald 를 세션을 유지하며 교체합니다...")
	out := ops.reload()
	switch out.Kind {
	case handover.Unsupported:
		fmt.Fprintln(stdout, "⚠ 도는 dongminald 는 세션 유지 교체를 모르는 옛 판입니다 — 서버만 다시 띄웠습니다.")
		fmt.Fprintln(stdout, "  한 번은 `dongminal start --refresh-daemon` 이 필요합니다 (세션을 잃습니다).")
		return true, 0
	case handover.Refused:
		fmt.Fprintf(stderr, "❌ dongminald 교체 실패 (%s): %s\n", out.Reason, out.Detail)
		fmt.Fprintln(stderr, "  서버·데몬·세션은 그대로입니다.")
		fmt.Fprintln(stderr, "  세션을 버리고 새로 띄우려면: dongminal start --refresh-daemon")
		return false, 1
	}
	if err := ops.confirm(); err != nil {
		fmt.Fprintf(stderr, "❌ 교체한 dongminald 를 확인하지 못했습니다: %v\n", err)
		fmt.Fprintln(stderr, "  서버는 끄지 않았습니다. `dongminal health --daemon` 으로 상태를 보세요.")
		return false, 1
	}
	fmt.Fprintln(stdout, "✅ dongminald 교체 완료 (세션 유지)")
	return true, 0
}

// realDaemonOps 는 home 의 실제 데몬에 하는 일이다.
func realDaemonOps(home string, stdout io.Writer) daemonOps {
	var pidBefore int
	return daemonOps{
		running: func() bool { return socketExists(home) },
		reload: func() handover.Outcome {
			pidBefore, _ = daemonPID(home)
			exe, err := startExecutable()
			if err != nil {
				return handover.Outcome{Kind: handover.Refused, Reason: handover.ReasonExe, Detail: err.Error()}
			}
			return handover.Reload(home, exe, reloadRequestWithin)
		},
		confirm: func() error { return confirmSwap(home, pidBefore) },
		stop:    func() bool { return stopDaemon(home, stdout) },
		notice:  func() string { return runningDaemonNotice(home, socketExists(home)) },
	}
}

// startExecutable 은 데몬이 exec 할 바이너리 — 이 `start` 를 실행한 파일이다 (FR-DSK-10).
func startExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// confirmSwap 은 새 데몬이 같은 pid 로 떴는지 본다 (FR-DSK-17).
func confirmSwap(home string, pidBefore int) error {
	var last string
	ok := func() bool {
		pid, alive := daemonPID(home)
		switch {
		case !alive || pid != pidBefore:
			last = fmt.Sprintf("데몬 pid 가 %d 에서 %d 로 바뀌었거나 죽었습니다", pidBefore, pid)
			return false
		case DaemonBuild != "" && recordedDaemonBuild(home) != DaemonBuild:
			last = "paned.build 가 새 지문이 아닙니다"
			return false
		case !handover.Hello(home, swapHelloWithin):
			last = "보고 소켓이 hello 에 답하지 않습니다"
			return false
		}
		return true
	}
	if pollwait.Until(context.Background(), swapConfirmWithin, swapConfirmPoll, ok) != nil {
		return fmt.Errorf("%s (pid %d)", last, pidBefore)
	}
	return nil
}
