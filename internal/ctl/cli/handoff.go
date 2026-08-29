package cli

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"dongminal/internal/shared/platform"
)

// restartLogFile은 위임된 재시작의 출력이 남는 곳이다. 대리 프로세스는 제어
// 터미널이 없으므로 알릴 자리가 여기밖에 없다.
const restartLogFile = "restart.log"

// shouldHandOffRestart는 재시작을 대리 프로세스에 넘겨야 하는지다
// (FR-ACT-3a/3b). 도구 안에서 데몬을 내리는 실행만 자기 목숨줄을 끊는다 —
// 도구의 셸은 dongminald 의 자식이고 제어 터미널이 그 PTY 이기 때문이다.
// 대리 자신은 다시 넘기지 않고, 도구 밖 실행은 종전대로 그 자리에서 한다.
func shouldHandOffRestart(restartDaemon bool, runner, toolID string) bool {
	return restartDaemon && runner == "" && toolID != ""
}

// handOffRestart는 재시작을 새 세션(setsid)의 대리 프로세스에 위임한다
// (FR-ACT-3a). handedOff 가 false 면 위임 대상이 아니므로 호출자가 그대로
// 진행한다. 위임했으면 호출자는 아무 것도 더 하지 않고 code 로 끝낸다 —
// 데몬 종료를 포함한 FR-ACT-1 전량이 대리의 몫이다.
func handOffRestart(o StartOpts, home string, stdout, stderr io.Writer) (handedOff bool, code int) {
	if !shouldHandOffRestart(o.RestartDaemon, os.Getenv(EnvRestartRunner), os.Getenv(EnvToolID)) {
		return false, 0
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(stderr, "실행 파일 경로 확인 실패: %v\n", err)
		return true, 1
	}
	logPath := filepath.Join(home, restartLogFile)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintf(stderr, "재시작 로그 열기 실패: %v\n", err)
		return true, 1
	}
	defer logFile.Close()

	// 인자는 재구성하지 않고 그대로 물려준다 — --home/--port/--expose 등을
	// 옮기다 빠뜨리면 대리가 다른 인스턴스를 재시작한다.
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = withEnv(os.Environ(), map[string]string{EnvRestartRunner: "1"})
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	// 부모와 수명을 끊는다 — 제어 터미널이 없으므로 데몬이 죽어 PTY 가 닫혀도
	// 종료 신호가 오지 않는다. 부모가 먼저 죽으면 init 으로 재부모화되어 계속 돈다.
	platform.Current().Process.Detach(cmd)
	if err := cmd.Start(); err != nil {
		// 데몬은 아직 살아 있다. 여기서 멈추는 것이 FR-ACT-3c 다 — 대리 없이
		// 데몬을 내리면 복구 수단까지 사라진다.
		fmt.Fprintf(stderr, "재시작 대리 기동 실패: %v\n", err)
		return true, 1
	}
	fmt.Fprintf(stdout, "dongminald 재시작을 대리 프로세스에 넘겼습니다 pid=%d\n", cmd.Process.Pid)
	fmt.Fprintf(stdout, "이 터미널은 곧 끊깁니다 — 브라우저를 새로고침하세요. 로그: %s\n", logPath)
	return true, 0
}
