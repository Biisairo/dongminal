// Package clientpid는 원격 TCP 연결의 remoteAddr 로부터 클라이언트 프로세스 PID 를
// 역추적하고, 조상 프로세스 체인을 거슬러 올라가는 유틸을 제공한다.
// ps/lsof 를 셸아웃하므로 macOS/리눅스 의존적이다.
package clientpid

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// Parent는 주어진 pid 의 부모 PID 를 반환한다.
func Parent(pid int) (int, error) {
	out, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(out)))
}

// FromRemoteAddr는 remoteAddr(예: "127.0.0.1:54321") 에 해당하는 TCP 엔드포인트를
// 소유한 프로세스의 PID 를 lsof 로 조회한다. 서버 자신 PID 는 제외한다.
func FromRemoteAddr(remoteAddr string) (int, error) {
	_, port, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return 0, fmt.Errorf("remoteAddr 파싱 실패: %s", remoteAddr)
	}
	out, err := exec.Command("lsof", "-i", "tcp@"+remoteAddr, "-n", "-P", "-Fp").Output()
	if err != nil {
		out, err = exec.Command("lsof", "-i", "tcp:"+port, "-n", "-P", "-Fp").Output()
		if err != nil {
			return 0, fmt.Errorf("lsof 실패: %w", err)
		}
	}
	selfPID := os.Getpid()
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "p") {
			continue
		}
		pid, err := strconv.Atoi(line[1:])
		if err != nil || pid <= 0 || pid == selfPID {
			continue
		}
		return pid, nil
	}
	return 0, fmt.Errorf("클라이언트 PID를 찾을 수 없음 (remoteAddr=%s)", remoteAddr)
}
