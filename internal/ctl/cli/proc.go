package cli

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"dongminal/internal/shared/platform"
)

const (
	daemonPIDFile  = "paned.pid"
	daemonSockFile = platform.SocketFileName
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

// pidsOnPort는 포트를 LISTEN 으로 점유한 pid 목록이다. 조회하지 못하면 빈 목록 —
// "점유 없음" 과 구분하지 않는다.
//
// **접속만 한 클라이언트는 포함되지 않아야 한다.** 브라우저 탭이 바로 그
// 클라이언트라, 포함하면 서버를 내리는 자리에서 사용자의 렌더러 프로세스를 함께
// 죽이고(탭이 죽어 새 서버에 다시 붙지 못한다), 클라이언트의 재접속 시도가
// 종료 확인 스냅샷에 걸리면 "포트를 비우지 못했다" 로 오판해 재시작을 중단한다.
// 그 보장은 platform.ProcInfo 의 계약이다 (FR-XPI-1).
// pidsOnPort 는 그 포트를 듣고 있는 pid 들이다.
//
// **이음매인 이유**(`TEST-3`): 실기로는 "포트를 잡은 프로세스가 TERM 에는 죽지
// 않고 KILL 에는 죽는다" 를 만들 수 없다. 그 순서가 이 함수의 계약인데, 그것을
// 재려면 관측 쪽도 갈아 끼울 수 있어야 한다 — `procCtl` 과 같은 근거다.
var pidsOnPort = func(port string) []int {
	return platform.Current().Info.ListenerPIDs(port)
}

// signalPIDs 는 pid 들에 send 를 적용한다. send 는 platform.Process 의
// Terminate 또는 Kill 이다 — 신호 상수를 여기까지 들이지 않는다.
func signalPIDs(pids []int, send func(int) error) {
	for _, p := range pids {
		_ = send(p)
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
	proc := procCtl()
	signalPIDs(pids, proc.Terminate)
	time.Sleep(time.Second)
	if pids = pidsOnPort(port); len(pids) > 0 {
		fmt.Fprintf(w, "강제 종료...\n")
		signalPIDs(pids, proc.Kill)
		time.Sleep(time.Second)
	}
	return len(pidsOnPort(port)) == 0
}

// procCtl은 프로세스 제어의 접근점이다. platform.Current() 는 프로세스 수명
// 동안 고정이라 테스트가 갈아끼울 곳이 없는데, "종료 요청에 실패하는
// 프로세스" 는 실기로 만들 수 없다 — 권한 오류를 재현하려면 root 가 필요하고
// SIGKILL 을 견디는 프로세스는 애초에 없다. 그 한 경우를 위한 이음매다.
var procCtl = func() platform.Process { return platform.Current().Process }

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
	if !procCtl().Alive(pid) {
		return pid, false
	}
	return pid, true
}

// daemonOurs 는 이 홈의 pidfile 이 가리키는 것이 **정말 우리 데몬인지**다
// (`FBE-07`).
//
// `daemonPID` 의 `Alive(pid)` 만으로는 부족하다 — 데몬이 죽고 OS 가 그 번호를 다른
// 프로세스에 주면 그 프로세스가 살아 있으므로 참이 되고, 그 뒤의 종료가
// **무관한 프로세스에 SIGTERM 을 보낸다.**
//
// 재료를 하나 더 둔다: **그 홈의 소켓이 답하는가.** 소켓은 홈마다 다르고 그것을
// 여는 것은 우리 데몬뿐이므로, 답한다면 거기 있는 것은 우리 것이다.
// `PanedServer.Listen` 이 "살아 있는 데몬이 이미 있는가" 를 가릴 때 쓰는 판정과
// 같다 — 두 벌을 만들지 않는다.
//
// **답하지 않는데 pid 가 살아 있는 경우**는 둘을 구별할 수 없다(번호 재사용 /
// 멎은 데몬). 그때는 신호를 보내지 않는다 — 남의 프로세스를 죽이는 쪽이 더 비싼
// 실패다. 멎은 데몬은 기동 경로가 이미 "죽은 소켓" 으로 다루므로(Listen 의 stale
// 제거) 판정이 어긋나지 않는다.
func daemonOurs(home string) (int, bool) {
	pid, alive := daemonPID(home)
	if !alive {
		return pid, false
	}
	transport := platform.Current().IPC
	conn, err := transport.Dial(transport.Endpoint(home), daemonProbeTimeout)
	if err != nil {
		return pid, false
	}
	conn.Close()
	return pid, true
}

// daemonProbeTimeout 은 "거기 우리 데몬이 있는가" 를 묻는 시도의 상한이다.
// 로컬 종단이므로 답은 즉시 오거나 오지 않는다 (ipc 의 dialProbeTimeout 과 같은 뜻).
const daemonProbeTimeout = 2 * time.Second

// stopDaemon은 dongminald 를 TERM → 1초 → KILL 로 종료하고 pidfile·소켓을
// 지운다. 이미 죽어 있으면 잔여물만 치운다. 반환값은 "정지 상태로 끝났는가"
// 이며, killPort 와 같은 형태로 **종료 시도 뒤 다시 확인해** 정한다.
//
// 아직 살아 있으면 잔여물을 남긴 채 false 다. 살아 있는 데몬의 pidfile 을
// 지우면 다음 호출이 그 데몬을 찾지 못해 정지도 재접속도 할 수 없는 고아가
// 된다 — 실패를 감추는 대신 다시 시도할 수 있는 상태로 남긴다.
func stopDaemon(home string, w io.Writer) bool {
	pidPath := filepath.Join(home, daemonPIDFile)
	sockPath := filepath.Join(home, daemonSockFile)
	// `FBE-07`: **우리 데몬임을 확인한 뒤에만 신호를 보낸다.** `Alive(pid)` 만
	// 보면 번호가 재사용된 무관한 프로세스를 죽인다.
	pid, ours := daemonOurs(home)
	alive := ours
	switch {
	case alive:
		fmt.Fprintf(w, "dongminald 정지 중 pid=%d...\n", pid)
		proc := procCtl()
		_ = proc.Terminate(pid)
		time.Sleep(time.Second)
		if proc.Alive(pid) {
			fmt.Fprintln(w, "강제 종료...")
			_ = proc.Kill(pid)
			time.Sleep(time.Second)
		}
		if proc.Alive(pid) {
			fmt.Fprintf(w, "dongminald pid=%d 가 아직 살아 있습니다\n", pid)
			return false
		}
	case pid > 0:
		// 번호는 살아 있을 수 있으나 그 홈의 소켓이 답하지 않았다 — 우리 것이
		// 아니거나 멎은 것이며, 어느 쪽인지 가릴 수 없다 (`FBE-07`). **신호를
		// 보내지 않는다**: 남의 프로세스를 죽이는 쪽이 더 비싼 실패다.
		fmt.Fprintln(w, "dongminald 미실행 (낡은 pidfile 제거)")
	default:
		fmt.Fprintln(w, "dongminald 미실행")
	}
	_ = os.Remove(pidPath)
	_ = os.Remove(sockPath)
	return true
}

// socketExists 는 종단 파일이 놓여 있는지다. 살아 있는지는 묻지 않는다 —
// 그 판정 방법은 OS 마다 다르고 platform.IPC 가 안다 (FR-XIP-2/3).
func socketExists(home string) bool {
	transport := platform.Current().IPC
	return transport.Exists(transport.Endpoint(home))
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
