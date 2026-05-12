package tools

import (
	"context"
	"fmt"

	"dongminal/internal/mcptool"
)

const WhoAmIName = "who_am_i"

var WhoAmISpec = map[string]any{
	"name":        WhoAmIName,
	"description": "현재 CC 가 실행 중인 pane 의 식별 정보를 반환: label(S?.P?.T?), paneId, shellPid, 터미널 크기(cols×rows), 세션/탭 이름, **uuid(36자)·short_code(8자)·session_uuid·region_uuid**. SSE 연결 정보를 서버가 자동 추적하므로 파라미터 없이 호출. send_agent_message 의 from 등 다른 tool 에 식별자를 전달할 때는 **출력의 uuid 값을 사용**할 것 — 라벨은 다른 세션 닫힘 시 reflow 되어 다른 pane 을 가리킨다. workspace.json 기반으로 최신 정보를 반환하므로 레이아웃이 바뀌어도 항상 정확.",
	"inputSchema": map[string]any{
		"type":       "object",
		"properties": map[string]any{},
	},
}

type WhoAmIArgs struct{}

type WhoAmIDeps struct {
	PM       mcptool.PaneReader
	WS       mcptool.WorkspaceReader
	Resolver mcptool.ClientPaneResolver
}

func WhoAmIHandler(d WhoAmIDeps) func(context.Context, WhoAmIArgs) (mcptool.Result, error) {
	return func(ctx context.Context, _ WhoAmIArgs) (mcptool.Result, error) {
		remoteAddr := mcptool.RemoteAddrFromContext(ctx)
		if remoteAddr == "" {
			return nil, fmt.Errorf("SSE 연결 정보 없음")
		}
		paneID, shellPID, err := d.Resolver.ResolveClientPane(remoteAddr)
		if err != nil {
			return nil, err
		}
		size := d.PM.Size(paneID)
		for _, e := range d.WS.Entries() {
			if e.PaneID == paneID {
				base := fmt.Sprintf("label=%s  paneId=%s  shellPid=%d  size=%s  session=%q  tab=%q",
					e.Label, paneID, shellPID, size, e.SessionName, e.TabName)
				if e.TabUUID != "" {
					base += fmt.Sprintf("  uuid=%s  short=%s", e.TabUUID, e.ShortCode)
					if e.SessionUUID != "" {
						base += fmt.Sprintf("  session_uuid=%s", e.SessionUUID)
					}
					if e.RegionUUID != "" {
						base += fmt.Sprintf("  region_uuid=%s", e.RegionUUID)
					}
				}
				return mcptool.Textf("%s", base), nil
			}
		}
		return mcptool.Textf("paneId=%s  shellPid=%d  size=%s  (workspace 미등록)", paneID, shellPID, size), nil
	}
}
