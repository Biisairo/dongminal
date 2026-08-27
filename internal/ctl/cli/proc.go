package cli

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	daemonPIDFile  = "paned.pid"
	daemonSockFile = "paned.sock"
)

// FreePort는 커널이 내주는 빈 TCP 포트를 받아 문자열로 돌려준다 (FR-ISO-1).
// listener 를 즉시 닫으므로 반환과 실제 bind 사이에 경합의 여지는 남는다.
// 격리 실행은 방금 만든 임시 홈으로 뜨는 1회성 인스턴스이므로 이 정도로 족하다.
func FreePort() (string, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer l.Close()
	return strconv.Itoa(l.Addr().(*net.TCPAddr).Port), nil
}

// pidsOnPort는 포트를 LISTEN 으로 점유한 pid 목록이다. lsof 가 없으면 빈 목록 —
// "점유 없음" 과 구분하지 않는다.
//
// -sTCP:LISTEN 이 없으면 그 포트에 접속한 클라이언트까지 잡힌다. 브라우저 탭이
// 바로 그 클라이언트라, 서버를 내리는 자리에서 사용자의 렌더러 프로세스를 함께
// KILL 하고(탭이 죽어 새 서버에 다시 붙지 못한다), 클라이언트의 재접속 시도가
// 종료 확인 스냅샷에 걸리면 "포트를 비우지 못했다" 로 오판해 재시작을 중단한다.
func pidsOnPort(port string) []int {
	out, err := exec.Command("lsof", "-ti", ":"+port, "-sTCP:LISTEN").Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Fields(string(out)) {
		if n, err := strconv.Atoi(line); err == nil {
			pids = append(pids, n)
		}
	}
	return pids
}

func signalPIDs(pids []int, sig syscall.Signal) {
	for _, p := range pids {
		_ = syscall.Kill(p, sig)
	}
}

// killPort는 포트를 점유한 프로세스를 TERM → 1초 → KILL 로 종료한다.
// 반환값은 종료 후 포트가 비었는지 여부다.
func killPort(port string, w io.Writer, label string) bool {
	pids := pidsOnPort(port)
	if len(pids) == 0 {
		return true
	}
	fmt.Fprintf(w, "%s (포트 %s) 정지 중...\n", label, port)
	signalPIDs(pids, syscall.SIGTERM)
	time.Sleep(time.Second)
	if pids = pidsOnPort(port); len(pids) > 0 {
		fmt.Fprintf(w, "강제 종료...\n")
		signalPIDs(pids, syscall.SIGKILL)
		time.Sleep(time.Second)
	}
	return len(pidsOnPort(port)) == 0
}

// daemonPID는 pidfile 이 가리키는 살아 있는 dongminald 의 pid 다.
func daemonPID(home string) (int, bool) {
	blob, err := os.ReadFile(filepath.Join(home, daemonPIDFile))
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(blob)))
	if err != nil || pid <= 0 {
		return 0, false
	}
	if syscall.Kill(pid, 0) != nil {
		return pid, false
	}
	return pid, true
}

// stopDaemon은 dongminald 를 종료하고 pidfile·소켓을 지운다. 이미 죽어 있으면
// 잔여물만 치운다. 반환값은 "정지 상태로 끝났는가" 다.
func stopDaemon(home string, w io.Writer) bool {
	pidPath := filepath.Join(home, daemonPIDFile)
	sockPath := filepath.Join(home, daemonSockFile)
	pid, alive := daemonPID(home)
	switch {
	case alive:
		fmt.Fprintf(w, "dongminald 정지 중 pid=%d...\n", pid)
		_ = syscall.Kill(pid, syscall.SIGTERM)
		time.Sleep(time.Second)
		_ = syscall.Kill(pid, syscall.SIGKILL)
	case pid > 0:
		fmt.Fprintln(w, "dongminald 미실행 (낡은 pidfile 제거)")
	default:
		fmt.Fprintln(w, "dongminald 미실행")
	}
	_ = os.Remove(pidPath)
	_ = os.Remove(sockPath)
	return true
}

func socketExists(home string) bool {
	fi, err := os.Stat(filepath.Join(home, daemonSockFile))
	return err == nil && fi.Mode()&os.ModeSocket != 0
}

// ping은 URL 이 2xx/3xx 를 주는지 확인한다.
func ping(url string, timeout time.Duration) bool {
	c := &http.Client{Timeout: timeout}
	resp, err := c.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode < 400
}

// tail은 로그 파일의 마지막 n 줄이다. 기동 실패를 알릴 때 쓴다.
func tail(path string, n int) string {
	blob, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(blob), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
