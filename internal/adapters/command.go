package adapters

import (
	"dongminal/internal/mcptool"
	"dongminal/internal/server"
)

// Command는 server.CommandHub 를 mcptool 의 CommandBroadcaster 인터페이스로 어댑트한다.
type Command struct{ Hub *server.CommandHub }

func (c Command) AllowedAction(a string) bool { return c.Hub.AllowedAction(a) }
func (c Command) Broadcast(p []byte) int      { return c.Hub.Broadcast(p) }

func (c Command) IsCreatingAction(a string) bool { return server.IsCreatingAction(a) }
func (c Command) NewReqId() string               { return server.NewReqId() }

// BroadcastAndAwait 는 server.CommandHub 의 long-poll 결과를 mcptool.CmdResult 로
// 변환해 반환한다 (REMOTE_COMMAND_RESULT_SRS DC-RCR-1: HTTP·MCP 공통 await).
func (c Command) BroadcastAndAwait(payload []byte, reqId string) (mcptool.CmdResult, int, bool) {
	res, n, timedOut := c.Hub.BroadcastAndAwait(payload, reqId, server.CommandResultTimeout())
	tabs := make([]mcptool.TabRef, len(res.NewTabs))
	for i, t := range res.NewTabs {
		tabs[i] = mcptool.TabRef{UUID: t.UUID, PaneID: t.PaneID}
	}
	return mcptool.CmdResult{
		NewSessions: res.NewSessions,
		NewRegions:  res.NewRegions,
		NewTabs:     tabs,
	}, n, timedOut
}
