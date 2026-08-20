package adapters

import (
	"fmt"

	"dongminal/internal/clientpid"
	"dongminal/internal/server"
)

// Client는 원격 TCP 연결(remoteAddr) 로부터 클라이언트 PID 를 구하고,
// 조상 체인을 거슬러 올라가며 tool 의 shell PID 와 매칭되는 toolID 를 반환한다.
// WhoAmI 류 MCP 툴의 의존성.
// PM이 nil이면 (daemon mode) Hub 를 통해 tool 목록을 얻는다.
type Client struct {
	PM  *server.ToolManager
	Hub server.ToolHub
}

func (r Client) ResolveClientPane(remoteAddr string) (string, int, error) {
	clientPID, err := clientpid.FromRemoteAddr(remoteAddr)
	if err != nil {
		return "", 0, err
	}
	paneShellPids := map[int]string{}
	for _, p := range (Tool{PM: r.PM, Hub: r.Hub}).List() {
		if p.ShellPID > 0 {
			paneShellPids[p.ShellPID] = p.ID
		}
	}
	current := clientPID
	for i := 0; i < 32; i++ {
		if toolID, ok := paneShellPids[current]; ok {
			return toolID, current, nil
		}
		parent, err := clientpid.Parent(current)
		if err != nil || parent <= 1 {
			break
		}
		current = parent
	}
	return "", 0, fmt.Errorf("clientPID=%d 가 어느 도구에도 속하지 않음", clientPID)
}
