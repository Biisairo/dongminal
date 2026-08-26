package adapters

import (
	"dongminal/internal/server"
	"dongminal/internal/webserver/seam/toolaccess"
)

// Command는 server.CommandHub 를 toolaccess.CommandBroadcaster 로 어댑트한다.
type Command struct{ Hub *server.CommandHub }

func (c Command) AllowedAction(a string) bool { return c.Hub.AllowedAction(a) }
func (c Command) Broadcast(p []byte) int      { return c.Hub.Broadcast(p) }

func (c Command) IsCreatingAction(a string) bool { return server.IsCreatingAction(a) }
func (c Command) NewReqId() string               { return server.NewReqId() }

// BroadcastAndAwait 는 server.CommandHub 의 long-poll 결과를 toolaccess.CmdResult 로
// 변환해 반환한다 (REMOTE_COMMAND_RESULT_SRS DC-RCR-1).
func (c Command) BroadcastAndAwait(payload []byte, reqId string) (toolaccess.CmdResult, int, bool) {
	res, n, timedOut := c.Hub.BroadcastAndAwait(payload, reqId, server.CommandResultTimeout())
	tabs := make([]toolaccess.TabRef, len(res.NewTabs))
	for i, t := range res.NewTabs {
		tabs[i] = toolaccess.TabRef{UUID: t.UUID, ToolID: t.ToolID}
	}
	return toolaccess.CmdResult{
		NewWindows: res.NewWindows,
		NewPanes:   res.NewPanes,
		NewTabs:    tabs,
	}, n, timedOut
}
