package cli

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Serve는 서버를 이 프로세스로 실행하는 콜백이다. cmd/dongminal 이
// 제공한다 — 서버 조립은 이 패키지의 관심사가 아니다.
type Serve func(home, host, port string) int

const (
	readyTries    = 10
	readyInterval = 500 * time.Millisecond
)

// RunStart는 `dongminal start` 다 (FR-ACT-1..4, FR-ISO-*, FR-OPN-*, FR-FG-*).
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
		home, err = os.MkdirTemp("", "dongminal-iso-")
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
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(stderr, "실행 파일 경로 확인 실패: %v\n", err)
		return 1
	}
	logPath := os.Getenv(EnvLog)
	if logPath == "" {
		logPath = DefaultLog
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		fmt.Fprintf(stderr, "로그 파일 열기 실패: %v\n", err)
		return 1
	}
	defer logFile.Close()

	cmd := exec.Command(exe, "start", "--foreground")
	cmd.Env = withEnv(os.Environ(), map[string]string{
		EnvPort: port,
		EnvHome: home,
		EnvHost: host,
	})
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	fmt.Fprintf(stdout, "dongminal 기동 중 %s:%s...\n", host, port)
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(stderr, "기동 실패: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "dongminal PID: %d\n", cmd.Process.Pid)

	url := fmt.Sprintf("http://%s:%s", pingHost(host), port)
	ready := false
	for i := 0; i < readyTries; i++ {
		if ping(url+"/api/ping", time.Second) {
			ready = true
			break
		}
		time.Sleep(readyInterval)
	}
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
	if o.Open {
		if err := openFrameless(url); err != nil {
			fmt.Fprintf(stderr, "⚠️  창을 열지 못했습니다: %v\n", err)
		}
	}
	return 0
}

// pingHost는 0.0.0.0/:: 로 바인드했을 때 실제로 두드릴 주소다.
func pingHost(host string) string {
	if host == ExposeHost || host == "::" {
		return "127.0.0.1"
	}
	return host
}

// withEnv는 base 에서 kv 의 키를 걷어내고 새 값을 붙인다. 중복 키를 남기면
// 자식이 어느 값을 볼지가 플랫폼에 달린다 (FR-FG-4).
func withEnv(base []string, kv map[string]string) []string {
	out := make([]string, 0, len(base)+len(kv))
	for _, e := range base {
		k, _, _ := strings.Cut(e, "=")
		if _, drop := kv[k]; !drop {
			out = append(out, e)
		}
	}
	for k, v := range kv {
		out = append(out, k+"="+v)
	}
	return out
}
