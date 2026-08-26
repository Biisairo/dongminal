package hub

import "time"

// CommandBroker abstracts *CommandHub. SSE 핸들러가 internal/server 로
// 옮겨가면서 Add/Remove 도 export 되어야 했다 — 구독 수명주기를 핸들러가
// 직접 관리하기 때문이다. 구현체는 *CommandHub 뿐이다.
type CommandBroker interface {
	Add() *CmdSub
	Remove(*CmdSub)
	Broadcast(payload []byte) int
	// BroadcastAndAwait / DeliverResult support creating-command result
	// correlation (REMOTE_COMMAND_RESULT_SRS).
	BroadcastAndAwait(payload []byte, reqId string, timeout time.Duration) (CmdResult, int, bool)
	DeliverResult(reqId string, res CmdResult)
}
