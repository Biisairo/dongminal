package tools

import (
	"context"
	"fmt"

	"dongminal/internal/mcptool"
	"dongminal/internal/paneline"
)

const WhoAmIName = "who_am_i"

var WhoAmISpec = map[string]any{
	"name":        WhoAmIName,
	"description": "현재 CC 가 실행 중인 tool 의 식별 정보를 반환. 표준 KEY=VALUE 라인 (label/uuid/short/toolId/shellPid/size/session/tab/session_uuid/region_uuid). SSE 연결 정보를 서버가 자동 추적하므로 파라미터 없이 호출. send_agent_message 의 from 등 다른 tool 에 식별자를 전달할 때는 **출력의 uuid 값을 사용**할 것. dmctl `who-am-i` 와 byte-level 동일 포맷.",
	"inputSchema": map[string]any{
		"type":       "object",
		"properties": map[string]any{},
	},
}

type WhoAmIArgs struct{}

type WhoAmIDeps struct {
	PM       mcptool.ToolReader
	WS       mcptool.WorkspaceReader
	Resolver mcptool.ClientPaneResolver
}

func WhoAmIHandler(d WhoAmIDeps) func(context.Context, WhoAmIArgs) (mcptool.Result, error) {
	return func(ctx context.Context, _ WhoAmIArgs) (mcptool.Result, error) {
		remoteAddr := mcptool.RemoteAddrFromContext(ctx)
		if remoteAddr == "" {
			return nil, fmt.Errorf("SSE 연결 정보 없음")
		}
		toolID, shellPID, err := d.Resolver.ResolveClientPane(remoteAddr)
		if err != nil {
			return nil, err
		}
		cols, rows := parseSize(d.PM.Size(toolID))
		for _, e := range d.WS.Entries() {
			if e.ToolID != toolID {
				continue
			}
			line := paneline.Line{
				FocusMarker: e.IsActive,
				Label:       e.Label,
				UUID:        e.TabUUID,
				Short:       e.ShortCode,
				ToolID:      toolID,
				ShellPID:    shellPID,
				SizeCols:    cols,
				SizeRows:    rows,
				Window:      e.WindowName,
				Tab:         e.TabName,
				WindowUUID:  e.WindowUUID,
				PaneUUID:    e.PaneUUID,
			}
			return mcptool.Textf("%s", line.Render()), nil
		}
		// workspace 미등록 경로 — toolId/shellPid/size 만 표시.
		line := paneline.Line{ToolID: toolID, ShellPID: shellPID, SizeCols: cols, SizeRows: rows}
		return mcptool.Textf("%s  (workspace 미등록)", line.Render()), nil
	}
}
