package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"dongminal/internal/mcptool"
)

type WhoAmI struct {
	PM       mcptool.PaneReader
	WS       mcptool.WorkspaceReader
	Resolver mcptool.ClientPaneResolver
}

func (WhoAmI) Name() string { return "who_am_i" }

func (WhoAmI) Spec() map[string]any {
	return map[string]any{
		"name":        "who_am_i",
		"description": "현재 CC 가 실행 중인 pane 의 라벨(S?.P?.T?), shellPid, 터미널 크기(cols×rows), 세션/탭 이름을 실시간으로 반환한다. SSE 연결 정보를 서버가 자동으로 추적하므로 파라미터 없이 호출하면 된다. workspace.json 기반으로 최신 라벨을 반환하므로 레이아웃이 바뀌어도 항상 정확하다. send_agent_message 의 from 필드를 채우기 전에 반드시 호출할 것.",
		"inputSchema": map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
	}
}

func (t WhoAmI) Call(ctx context.Context, _ json.RawMessage) (mcptool.Result, error) {
	remoteAddr := mcptool.RemoteAddrFromContext(ctx)
	if remoteAddr == "" {
		return nil, fmt.Errorf("SSE 연결 정보 없음")
	}
	paneID, shellPID, err := t.Resolver.ResolveClientPane(remoteAddr)
	if err != nil {
		return nil, err
	}
	size := t.PM.Size(paneID)
	for _, e := range t.WS.Entries() {
		if e.PaneID == paneID {
			return mcptool.TextResult(fmt.Sprintf(
				"label=%s  paneId=%s  shellPid=%d  size=%s  session=%q  tab=%q",
				e.Label, paneID, shellPID, size, e.SessionName, e.TabName,
			)), nil
		}
	}
	return mcptool.TextResult(fmt.Sprintf("paneId=%s  shellPid=%d  size=%s  (workspace 미등록)", paneID, shellPID, size)), nil
}
