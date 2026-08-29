package adapters

import (
	"dongminal/internal/shared/toolhub"

	"fmt"

	"dongminal/internal/shared/platform"
)

// Client는 원격 TCP 연결(remoteAddr) 로부터 클라이언트 PID 를 구하고,
// 조상 체인을 거슬러 올라가며 tool 의 shell PID 와 매칭되는 toolID 를 반환한다.
// /api/whoami 의 toolId 폴백 경로가 쓴다.
// PM이 nil이면 (daemon mode) Hub 를 통해 tool 목록을 얻는다.
type Client struct {
	PM  *toolhub.ToolManager
	Hub toolhub.ToolHub
}

func (r Client) ResolveClientPane(remoteAddr string) (string, int, error) {
	// 클라이언트 pid 역추적과 부모 거슬러 오르기는 OS 마다 방법이 다르다.
	// 그 차이는 platform.ProcInfo 뒤에 있다 (CROSS_PLATFORM_SRS FR-XPI-7).
	info := platform.Current().Info
	clientPID, ok := info.ConnectionOwnerPID(remoteAddr)
	if !ok {
		return "", 0, fmt.Errorf("클라이언트 PID를 찾을 수 없음 (remoteAddr=%s)", remoteAddr)
	}
	toolShellPids := map[int]string{}
	for _, p := range (Tool{PM: r.PM, Hub: r.Hub}).List() {
		if p.ShellPID > 0 {
			toolShellPids[p.ShellPID] = p.ID
		}
	}
	current := clientPID
	for i := 0; i < 32; i++ {
		if toolID, ok := toolShellPids[current]; ok {
			return toolID, current, nil
		}
		parent, ok := info.ParentPID(current)
		if !ok || parent <= 1 {
			break
		}
		current = parent
	}
	return "", 0, fmt.Errorf("clientPID=%d 가 어느 도구에도 속하지 않음", clientPID)
}
