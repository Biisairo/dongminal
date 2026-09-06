package sandbox

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// 컨테이너 런타임의 상태와 그 다음 걸음 (UX_BATCH5_SRS 묶음 B, FR-SRT-1~4).
//
// 이 파일이 있는 이유는 §2.3 의 사실 하나다: `Wire` 는 **바이너리 유무만** 보므로
// (`FindRuntime`), docker 는 설치됐는데 데몬이 죽은 상태에서 프로파일 목록이
// 정상으로 오고 실패가 창을 만드는 순간까지 미뤄진다. 사용자에게는 "샌드박스
// 버튼이 고장났다" 로 보인다.
//
// 판정을 화면이 아니라 여기 두는 이유는 OS 다 (D-3). 브라우저의 `navigator.platform`
// 은 **접속한 기기**의 OS 이지 docker 가 도는 호스트의 것이 아니다 — 원격에서 열면
// 둘이 다르다.

// 런타임 상태 셋. 넷째(ok 이지만 프로파일이 없음)를 만들지 않는다 — 그 경우는
// 이미 FR-SPK-7 이 다룬다 (D-4).
const (
	RuntimeOK      = "ok"      // 데몬에 닿았다
	RuntimeStopped = "stopped" // 바이너리는 있으나 데몬에 닿지 못했다
	RuntimeMissing = "missing" // 바이너리가 없다
)

// probeTimeout 은 데몬 조회의 상한이다 (NFR-SRT-1).
//
// 넘으면 `stopped` 로 답한다 — 응답하지 않는 데몬도 사용자에게는 실행 중이 아닌
// 것이다. 상한이 없으면 버튼이 무응답으로 멈춘다.
const probeTimeout = 3 * time.Second

/**
 * RuntimeStatus 는 FR-SRT-1 의 응답이다.
 *
 * **명령을 함께 싣는다.** 화면이 `os` 로 다시 고르게 두면 같은 표가 두 벌이 되고,
 * 한쪽만 고쳐지면 안내한 명령과 서버가 실행하는 명령이 어긋난다 — 판정을 서버에
 * 둔 이유(D-3)가 명령에도 그대로 적용된다.
 *
 * `StartTryable` 이 거짓이면 `StartCommand` 는 **사용자가 칠 것**이다 (linux, D-5).
 */
type RuntimeStatus struct {
	State   string `json:"state"`
	OS      string `json:"os"`
	Runtime string `json:"runtime"`
	Path    string `json:"path"`
	Detail  string `json:"detail"`
	// 설치 명령. 모르는 OS 에서는 비며, 화면은 그때 명령 없이 안내만 보인다.
	InstallCommand string `json:"installCommand"`
	StartCommand   string `json:"startCommand"`
	StartTryable   bool   `json:"startTryable"`
}

// StartResult 는 FR-SRT-3 의 응답이다.
//
// Started 는 **명령이 오류 없이 반환됐다는 뜻일 뿐**이며 데몬이 떴다는 뜻이
// 아니다 (FR-SRT-4) — Docker Desktop 은 창을 띄우고 곧바로 반환한다. 데몬이
// 떴는지는 화면이 Probe 를 다시 물어 확정한다.
type StartResult struct {
	Started bool   `json:"started"`
	Command string `json:"command"`
	Detail  string `json:"detail"`
}

// execFn 은 런타임 실행 파일 한 번의 실행이다. 주입하는 이유는 런타임이 없는
// 호스트에서도 판정 전량을 시험할 수 있어야 하기 때문이다 — 이 패키지의 규약이다.
type execFn = func(path string, args []string) (out string, err error)

// Probe 는 런타임 상태를 확정한다 (FR-SRT-2).
//
// 순서가 요구사항이다: 바이너리가 없으면 **그 자리에서 끝난다.** 없는 파일을
// 실행해 봐야 얻는 것이 없고, 그 실패를 `stopped` 로 읽으면 사용자는 설치된 줄
// 알고 기동을 시도한다.
//
// look 은 `FindRuntime` 과 **같은 것**을 받는다 (`LookPath`) — 판정 자리가 둘이면
// 어긋날 때 구멍이 생긴다.
//
// `goos` 를 **주입받는다.** `runtime.GOOS` 를 여기서 읽으면 이음매 규칙
// (CROSS_PLATFORM_SRS FR-XPL-5, `scripts/check-seams.sh`)을 깬다 — 그 값을 아는
// 자리는 `platform` 하나다. 덤으로 세 OS 의 갈래를 호스트와 무관하게 시험할 수
// 있게 된다.
func Probe(goos string, look func(string) (string, error), run execFn) RuntimeStatus {
	st := RuntimeStatus{OS: goos, Runtime: "docker"}
	// 명령은 상태와 무관하게 채운다 — 어느 갈래에서 쓰일지는 화면이 정한다.
	st.InstallCommand = InstallCommand(st.OS)
	st.StartCommand, st.StartTryable = StartCommand(st.OS)
	path, err := look("docker")
	if err != nil {
		st.State = RuntimeMissing
		return st
	}
	st.Path = path
	// `info` 는 데몬에 실제로 붙는다. `version` 은 클라이언트만으로도 답하므로
	// 데몬이 죽은 것을 잡지 못한다 — 그것이 이 함수가 고치려는 바로 그 구멍이다.
	out, err := run(path, []string{"info", "--format", "{{.ServerVersion}}"})
	if err == nil {
		st.State = RuntimeOK
		return st
	}
	// 사유를 알아보든 못하든 결과는 같다 — 사용자에게는 "쓸 수 없다" 가 하나다.
	// 알아보지 못한 출력을 ok 로 낮추면 실패가 창을 만드는 순간까지 미뤄진다.
	// runtimeDown 은 여기서 쓰이지 않지만 같은 사실을 보는 함수이며, 판정을
	// 나누지 않으려고 결과를 하나로 뭉갠다.
	st.State = RuntimeStopped
	st.Detail = tail(out, err)
	return st
}

// StartCommand 는 그 OS 에서 데몬을 띄우는 명령과, **서버가 그것을 시도해도
// 되는지**를 준다 (FR-SRT-3).
//
// linux 가 false 인 이유는 권한이다 (D-5). `sudo systemctl start docker` 를 서버가
// 부르면 비밀번호를 받을 길이 없어 무응답으로 멈춘다 — 사용자가 자기 셸에서 치는
// 것이 유일하게 끝나는 길이다.
//
// 모르는 OS 도 false 다. 명령을 지어내는 것보다 아무것도 하지 않는 편이 낫다.
func StartCommand(goos string) (cmd string, tryable bool) {
	switch goos {
	case "darwin":
		return "open -a Docker", true
	case "windows":
		return `cmd /c start "" "Docker Desktop.exe"`, true
	// **WSL 은 linux 로 다룬다.** `platform.OSKind` 가 그 둘을 가르는 것은
	// 기록·표시를 위해서이고(FR-XWS-2), 여기서 알아야 하는 것은 "데몬을 어떻게
	// 띄우는가" 하나다 — WSL 안의 docker 는 리눅스의 그것이다. 가르지 않으면
	// WSL 사용자가 "모르는 운영체제" 갈래로 떨어져 명령을 하나도 못 받는다.
	case "linux", "wsl":
		return "sudo systemctl start docker", false
	default:
		// 칠 명령조차 주지 않으면 사용자가 이 창에서 할 수 있는 일이 없다.
		return "docker 데몬을 시작하세요", false
	}
}

// StartRuntime 은 데몬 기동을 시도한다 (FR-SRT-3).
//
// 시도할 수 없는 OS 에서는 **아무것도 실행하지 않고** 명령만 돌려준다. 실패는
// 사유와 함께 온다 — 삼키면 사용자는 눌러도 아무 일이 없는 것으로 읽는다.
func StartRuntime(goos string, run execFn) StartResult {
	cmd, tryable := StartCommand(goos)
	res := StartResult{Command: cmd}
	if !tryable {
		return res
	}
	name, args := splitCommand(goos)
	out, err := run(name, args)
	if err != nil {
		res.Detail = tail(out, err)
		return res
	}
	res.Started = true
	return res
}

// splitCommand 는 StartCommand 의 문자열을 실행 인자로 옮긴다. 문자열을 셸에
// 넘기지 않는 이유는 셸이 필요 없기 때문이다 — 인자가 고정이므로 파싱할 것이 없다.
func splitCommand(goos string) (string, []string) {
	if goos == "windows" {
		return "cmd", []string{"/c", "start", "", "Docker Desktop.exe"}
	}
	return "open", []string{"-a", "Docker"}
}

// InstallCommand 는 그 OS 의 설치 명령이다 (FR-SRT-6).
//
// **하나만** 준다. 셋을 다 보이면 자기 것이 아닌 둘은 고를 것이 아니라 잡음이다.
// 모르는 OS 에는 빈 문자열이며, 화면은 그때 명령 없이 안내만 보인다.
func InstallCommand(goos string) string {
	switch goos {
	case "darwin":
		return "brew install --cask docker"
	// StartCommand 와 같은 이유로 WSL 을 함께 받는다.
	case "linux", "wsl":
		return "curl -fsSL https://get.docker.com | sh"
	case "windows":
		return "winget install Docker.DockerDesktop"
	default:
		return ""
	}
}

// CLIExec 는 Probe·StartRuntime 의 실제 인자다.
//
// CombinedOutput 인 것이 요점이다 — 런타임의 진단은 대부분 stderr 로 나오며,
// 그것을 버리면 "왜 실패했는가" 가 통째로 사라진다 (`CLIRunner` 와 같은 근거).
// 상한 시간을 여기서 거는 이유는 그것이 실행의 성질이지 판정의 성질이 아니기
// 때문이다 — Probe 는 주입받은 것을 부를 뿐이다.
func CLIExec(path string, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, args...).CombinedOutput()
	return string(out), err
}

// StartExec 는 기동의 실행자다. 상한이 없다 — Docker Desktop 을 띄우는 명령 자체는
// 곧바로 반환하고, 데몬이 뜨기를 기다리는 것은 화면의 폴링이 한다 (FR-SRT-7).
func StartExec(path string, args []string) (string, error) {
	out, err := exec.Command(path, args...).CombinedOutput()
	return string(out), err
}

// tail 은 진단 문자열을 사람이 읽을 만큼만 남긴다. 오류만 있고 출력이 없는 경우도
// 있으므로 둘을 함께 본다 — 어느 쪽도 조용히 버리지 않는다.
func tail(out string, err error) string {
	s := strings.TrimSpace(out)
	if s == "" && err != nil {
		s = err.Error()
	}
	const max = 400
	if len(s) > max {
		s = s[len(s)-max:]
	}
	return s
}
