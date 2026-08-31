package cli

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"dongminal/internal/shared/platform"

	"dongminal/internal/shared/dmenv"
)

// Serve는 서버를 이 프로세스로 실행하는 콜백이다. cmd/dongminal 이
// 제공한다 — 서버 조립은 이 패키지의 관심사가 아니다.
type Serve func(home, host, port string) int

const (
	readyTries    = 10
	readyInterval = 500 * time.Millisecond
)

// RunStart는 `dongminal start` 다 (FR-ACT-1..4, FR-ISO-*, FR-FG-*).
//
// 창을 여는 일은 여기 없다 — `dongminal window` 가 한다 (WINDOW_COMMAND_SRS FR-WIN-8).
func RunStart(o StartOpts, serve Serve, stdout, stderr io.Writer) int {
	home, port, err := resolveStartTarget(o)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	host := DefaultHost
	if v := os.Getenv(EnvHost); v != "" {
		host = v
	}
	if o.Expose {
		host = ExposeHost
	}

	if err := os.MkdirAll(home, 0o755); err != nil {
		fmt.Fprintf(stderr, "DONGMINAL_HOME 생성 실패: %v\n", err)
		return 1
	}

	// ── 자기 종료 회피 ──────────────────────────────────────
	// 도구 안에서 데몬을 내리면 이 프로세스도 PTY 와 함께 죽어 서버 기동에
	// 도달하지 못한다. 재시작 전량을 대리에게 넘기고 돌아온다 (FR-ACT-3a).
	if handedOff, code := handOffRestart(o, home, stdout, stderr); handedOff {
		return code
	}

	// ── 사전 정리 ────────────────────────────────────────────
	// 격리 실행은 기존 서버를 건드리지 않는다 (FR-ISO-2). 빈 포트를 고른
	// 이상 죽일 대상이 없고, 운영 인스턴스를 죽이는 사고를 구조로 막는다.
	if !o.Isolated {
		if !killPort(port, stdout, "기존 dongminal") {
			fmt.Fprintf(stderr, "❌ 포트 %s 를 비우지 못했습니다\n", port)
			return 1
		}
	}
	if o.RestartDaemon {
		fmt.Fprintln(stdout, "dongminald 재시작 (터미널 세션을 잃습니다)...")
		stopDaemon(home, stdout)
	} else if socketExists(home) {
		fmt.Fprintln(stdout, "dongminald 실행 중 (세션 보존)")
	} else {
		fmt.Fprintln(stdout, "dongminald 미실행 — dongminal 이 자동 기동합니다")
	}

	if o.Foreground {
		return serve(home, host, port)
	}
	return startDetached(o, home, host, port, stdout, stderr)
}

// resolveStartTarget은 홈과 포트를 정한다. --isolated 는 명시되지 않은 쪽만
// 격리 값으로 채운다 (FR-ISO-1/3) — 사용자가 준 값을 조용히 무시하지 않는다.
func resolveStartTarget(o StartOpts) (home, port string, err error) {
	if o.Isolated && o.Home == "" {
		home, err = os.MkdirTemp("", isolatedHomePrefix)
		if err != nil {
			return "", "", fmt.Errorf("격리 홈 생성 실패: %w", err)
		}
	} else {
		home, err = o.ResolveHome()
		if err != nil {
			return "", "", err
		}
	}
	if o.Isolated && o.Port == "" {
		port, err = FreePort()
		if err != nil {
			return "", "", fmt.Errorf("빈 포트 확보 실패: %w", err)
		}
	} else {
		port = o.ResolvePort()
	}
	return home, port, nil
}

// startDetached는 자기 자신을 `start --foreground` 로 재실행해 detach 하고,
// 준비를 확인한 뒤 결과를 알린다 (FR-FG-2/3/4).
func startDetached(o StartOpts, home, host, port string, stdout, stderr io.Writer) int {
	cmd, logFile, logPath, err := prepareServerCmd(home, host, port, "")
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	defer logFile.Close()

	fmt.Fprintf(stdout, "dongminal 기동 중 %s:%s...\n", host, port)
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(stderr, "기동 실패: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "dongminal PID: %d\n", cmd.Process.Pid)

	url := ServerURL(host, port)
	ready := waitReady(url, readyTries, readyInterval)
	if !ready {
		fmt.Fprintf(stderr, "❌ 기동 실패. 로그: %s\n", logPath)
		if t := tail(logPath, 20); t != "" {
			fmt.Fprintln(stderr, t)
		}
		return 1
	}

	exposure := "local-only"
	if host == ExposeHost || host == "::" {
		exposure = "LAN 노출"
	}
	fmt.Fprintf(stdout, "✅ dongminal running on %s (%s)\n", url, exposure)
	if socketExists(home) {
		fmt.Fprintf(stdout, "✅ dongminald connected at %s/%s\n", home, daemonSockFile)
	}
	if o.Isolated {
		fmt.Fprintf(stdout, "격리 홈: %s (자동으로 지우지 않습니다)\n", home)
		fmt.Fprintf(stdout, "정지: dongminal stop --all --port %s --home %s\n", port, home)
	}
	return 0
}

// isolatedHomePrefix 는 격리 홈의 표지다. resolveStartTarget 이 이 접두사로 임시
// 디렉터리를 만들고, verify 의 가드가 같은 접두사로 대상이 격리된 것인지 확인한다
// (E2E_UNIFICATION_SRS FR-E2G-1). 한 상수인 것이 안전의 일부다 — 두 벌로 두면
// 만드는 쪽만 바뀌었을 때 가드가 조용히 무력해진다.
const isolatedHomePrefix = "dongminal-iso-"

// isolatedToolHome 은 이 기동에서 도구 셸에 심을 홈이다. 격리 홈으로 뜨는
// 인스턴스면 그 홈 **아래의 별도 칸**이고, 사용자 인스턴스면 빈 문자열이다 —
// 빈 값은 toolhub 가 종전대로 사용자 홈을 쓴다는 뜻이며, 사용자의 탭은 그것이
// 맞다.
//
// 격리 기동은 검사가 쓰는 경로다(verify 가 도구 셸에 명령을 주입한다). 도구
// 셸은 로그인 셸이라 rc 를 읽고 히스토리를 쓰므로, 그 홈이 사용자 홈이면
// 검사가 주입한 명령이 사용자의 히스토리에 남는다.
//
// **인스턴스 홈을 그대로 주지 않는다.** 그러면 셸이 `.zsh_history`·`.zcompdump`
// 를 workspace·tools 와 같은 디렉터리에 쓰고, 그 쓰기가 인스턴스 자신의 저장과
// 같은 자리에서 겹친다 — e2e 에서 그 경합이 실제로 검사를 흔들었다.
func isolatedToolHome(home string) string {
	if strings.HasPrefix(filepath.Base(home), isolatedHomePrefix) {
		return filepath.Join(home, toolHomeDir)
	}
	return ""
}

// toolHomeDir 은 인스턴스 홈 아래에서 도구 셸이 자기 홈으로 쓸 칸의 이름이다.
const toolHomeDir = "tool-home"

// prepareServerCmd 는 자기 자신을 `start --foreground` 로 끊어 띄울 cmd 를 만든다.
// **Start 는 부르는 쪽이 한다** — 기동 직전·직후의 안내 문구가 호출자마다 다르다.
//
// start 와 verify 가 이 한 벌을 함께 딛는다. verify 가 겨누는 결함이 "끊어 띄운
// 프로세스에서만" 났으므로(CROSS_PLATFORM_SRS §11.6), 기동 경로를 두 벌로 두면
// verify 는 실제 기동 경로를 검사하지 못한다 (E2E_UNIFICATION_SRS FR-E2C-7).
//
// logPath 가 비면 $DONGMINAL_LOG, 그것도 비면 기본 로그 자리다.
// 돌려주는 logFile 은 호출자가 닫는다.
func prepareServerCmd(home, host, port, logPath string) (*exec.Cmd, *os.File, string, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, nil, "", fmt.Errorf("실행 파일 경로 확인 실패: %w", err)
	}
	if logPath == "" {
		if logPath = os.Getenv(EnvLog); logPath == "" {
			logPath = defaultLogFile()
		}
	}
	// 로그의 상위 디렉터리는 없을 수 있다 — POSIX 의 /tmp 와 달리
	// %LOCALAPPDATA%\dongminal 은 첫 기동 때 존재하지 않는다 (FR-XPA-2).
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return nil, nil, logPath, fmt.Errorf("로그 디렉터리 생성 실패: %w", err)
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, nil, logPath, fmt.Errorf("로그 파일 열기 실패: %w", err)
	}

	cmd := exec.Command(exe, "start", "--foreground")
	env := map[string]string{
		EnvPort: port,
		EnvHome: home,
		EnvHost: host,
	}
	// 격리 인스턴스면 도구 셸의 홈도 함께 격리한다 (FR-E2G-1 의 연장). 셸이
	// 없는 홈을 받지 않도록 여기서 만든다 — 만들지 못하면 격리를 포기하는 대신
	// 그냥 심지 않는다. 격리는 검사의 편의이지 기동의 조건이 아니다.
	if th := isolatedToolHome(home); th != "" {
		if err := os.MkdirAll(th, 0o755); err == nil {
			env[dmenv.EnvToolHome] = th
		}
	}
	cmd.Env = withEnv(os.Environ(), env,
		// 서버는 dongminald 를, dongminald 는 도구 셸을 자식으로 낳는다. 이 두
		// 값이 그 사슬을 타고 도구 셸까지 흘러가면 다음 재시작이 자신을 대리로
		// 오인해 위임을 건너뛰고, 그 자리에서 데몬을 내리다 자기 PTY 와 함께
		// 죽는다 — 서버도 데몬도 돌아오지 않는다 (FR-ACT-3a/3b).
		EnvRestartRunner, EnvToolID)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	platform.Current().Process.Detach(cmd)
	return cmd, logFile, logPath, nil
}

// ServerURL 은 host·port 로 띄운 서버를 실제로 두드릴 주소다.
func ServerURL(host, port string) string {
	return fmt.Sprintf("http://%s:%s", pingHost(host), port)
}

// waitReady 는 /api/ping 이 응답할 때까지 기다린다.
func waitReady(url string, tries int, interval time.Duration) bool {
	for i := 0; i < tries; i++ {
		if ping(url+"/api/ping", time.Second) {
			return true
		}
		time.Sleep(interval)
	}
	return false
}

// pingHost는 0.0.0.0/:: 로 바인드했을 때 실제로 두드릴 주소다.
func pingHost(host string) string {
	if host == ExposeHost || host == "::" {
		return dmenv.DefaultHost
	}
	return host
}

// withEnv는 base 에서 kv 의 키와 drop 의 키를 걷어내고 kv 의 새 값을 붙인다
// (FR-FG-4). drop 은 자식에게 물려주면 안 되는 값을 지우는 자리다 — 새 값을
// 주지 않으므로, 덮어쓰기로는 지울 수 없는 상속을 여기서 끊는다.
func withEnv(base []string, kv map[string]string, drop ...string) []string {
	out := make([]string, 0, len(base)+len(kv))
	for _, e := range base {
		k, _, _ := strings.Cut(e, "=")
		if _, replaced := kv[k]; replaced || slices.Contains(drop, k) {
			continue
		}
		out = append(out, e)
	}
	for k, v := range kv {
		out = append(out, k+"="+v)
	}
	return out
}
