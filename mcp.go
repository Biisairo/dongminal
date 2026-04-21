package main

// MCP JSON-RPC handlers live in internal/server now. The client-PID resolver
// helpers remain here because they shell out to `ps`/`lsof` and are only used
// from package main's mcptool adapter.

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

func getParentPID(pid int) (int, error) {
	out, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(out)))
}

func getClientPID(remoteAddr string) (int, error) {
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
