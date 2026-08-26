package hub

import (
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"dongminal/internal/shared/uuid"
)

type CmdSub struct {
	ch   chan []byte
	done chan struct{}
	once sync.Once
}

// Messages는 이 구독에 브로드캐스트된 payload 채널이다. Closed는 구독이 닫힐
// 때 신호가 오는 채널이다. 둘 다 수신 전용으로 내보내 SSE 핸들러(internal/webserver/httpapi)
// 가 select 만 할 수 있게 한다 — 채널 자체를 노출하면 핸들러가 닫거나 쓸 수 있다.
func (s *CmdSub) Messages() <-chan []byte { return s.ch }
func (s *CmdSub) Closed() <-chan struct{} { return s.done }

// TabRef pairs a newly created tab's uuid with its server-assigned toolId
// (REMOTE_COMMAND_RESULT_SRS — 호출자가 uuid→toolId 재조회 불필요).
type TabRef struct {
	UUID   string `json:"uuid"`
	ToolID string `json:"toolId"`
}

// CmdResult is the set of entities a creating command produced, echoed back by
// the browser and returned to the caller via long-poll correlation.
type CmdResult struct {
	NewWindows []string `json:"newWindows"`
	NewPanes   []string `json:"newPanes"`
	NewTabs    []TabRef `json:"newTabs"`
}

// CommandHub broadcasts workspace UI commands to SSE subscribers.
type CommandHub struct {
	mu   sync.Mutex
	subs map[*CmdSub]struct{}

	// pending maps a creating command's reqId to the channel awaiting the
	// browser's echo (REMOTE_COMMAND_RESULT_SRS FR-RCR-2/3). Guarded by pmu.
	pmu     sync.Mutex
	pending map[string]chan CmdResult
}

func NewCommandHub() *CommandHub {
	return &CommandHub{
		subs:    map[*CmdSub]struct{}{},
		pending: map[string]chan CmdResult{},
	}
}

// creatingActions are the commands that produce new entities and thus support
// result correlation. Others broadcast immediately with no await.
var creatingActions = map[string]bool{
	"newWindow": true,
	"newTab":    true,
	"splitH":    true,
	"splitV":    true,
}

// IsCreatingAction reports whether action creates new entities (FR-RCR-1).
func IsCreatingAction(action string) bool { return creatingActions[action] }

// singleExecutorActions are the commands that add an entity to the workspace
// tree and therefore must run on exactly ONE client
// (WORKSPACE_IDENTITY_SRS FR-SXE-1). It is wider than creatingActions:
// openEditorTab and restoreTool allocate a tab id without taking part in the
// reqId echo protocol.
//
// Everything else stays ungated — focus is per-client by definition, and the
// remaining mutations are idempotent across clients.
var singleExecutorActions = map[string]bool{
	"newWindow":     true,
	"newTab":        true,
	"splitH":        true,
	"splitV":        true,
	"openEditorTab": true,
	"restoreTool":   true,
}

// IsSingleExecutorAction reports whether action must run on one client only.
func IsSingleExecutorAction(action string) bool { return singleExecutorActions[action] }

const defaultCommandResultTimeout = 3 * time.Second

// CommandResultTimeout is the long-poll wait, overridable via env (NFR-RCR-1).
func CommandResultTimeout() time.Duration {
	if v := os.Getenv("DONGMINAL_CMD_RESULT_TIMEOUT_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return defaultCommandResultTimeout
}

// NewReqId returns a fresh 1회성 correlation key.
func NewReqId() string {
	// FR-UNI-14: canonical uuid. 이전에는 16바이트 hex(32자, 구분자·버전 비트 없음)
	// 였다. 엔트로피가 동등하므로 echo 상관 동작(FR-RCR-*)은 불변이다.
	return uuid.NewString()
}

// BroadcastAndAwait broadcasts payload (which must already embed reqId) and
// blocks until the browser echoes the result for reqId or timeout elapses. If
// no subscriber received the broadcast (delivered=0) it returns immediately
// without waiting (FR-RCR-2).
func (h *CommandHub) BroadcastAndAwait(payload []byte, reqId string, timeout time.Duration) (CmdResult, int, bool) {
	ch := make(chan CmdResult, 1)
	h.pmu.Lock()
	h.pending[reqId] = ch
	h.pmu.Unlock()

	n := h.Broadcast(payload)
	if n == 0 {
		h.clearPending(reqId)
		return CmdResult{}, 0, false
	}
	select {
	case res := <-ch:
		return res, n, false
	case <-time.After(timeout):
		h.clearPending(reqId)
		return CmdResult{}, n, true
	}
}

// DeliverResult routes a browser echo to the awaiting BroadcastAndAwait. The
// first echo wins (channel removed); unknown/expired reqId is a no-op
// (FR-RCR-3, NFR-RCR-3).
func (h *CommandHub) DeliverResult(reqId string, res CmdResult) {
	h.pmu.Lock()
	ch, ok := h.pending[reqId]
	if ok {
		delete(h.pending, reqId)
	}
	h.pmu.Unlock()
	if ok {
		ch <- res // buffered cap 1, non-blocking
	}
}

func (h *CommandHub) clearPending(reqId string) {
	h.pmu.Lock()
	delete(h.pending, reqId)
	h.pmu.Unlock()
}

// pendingCount is a test helper for leak detection.
func (h *CommandHub) pendingCount() int {
	h.pmu.Lock()
	defer h.pmu.Unlock()
	return len(h.pending)
}

// cmdSubQueue는 구독당 미수신 payload 버퍼 크기다. 넘치면 그 구독만 드롭한다
// — 느린 브라우저 하나가 다른 구독을 막지 않는다.
const cmdSubQueue = 16

// NewCmdSub는 허브에 등록되지 않은 홀로 선 구독을 만든다. Close는 그 구독을
// 닫는다(중복 호출 안전). CommandHub.Add/Remove 가 내부에서 하는 일과 같으며,
// 허브를 대역하는 다른 패키지의 CommandBroker 구현이 쓴다.
func NewCmdSub() *CmdSub {
	return &CmdSub{ch: make(chan []byte, cmdSubQueue), done: make(chan struct{})}
}

func (s *CmdSub) Close() { s.once.Do(func() { close(s.done) }) }

func (h *CommandHub) Add() *CmdSub {
	s := NewCmdSub()
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

func (h *CommandHub) Remove(s *CmdSub) {
	s.Close()
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

// Broadcast delivers payload to all subscribers; returns delivered count.
func (h *CommandHub) Broadcast(payload []byte) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for s := range h.subs {
		select {
		case s.ch <- payload:
			n++
		default:
			log.Printf("[cmd] subscriber channel full, dropping")
		}
	}
	return n
}

var AllowedCmdActions = map[string]bool{
	"newWindow":     true,
	"newTab":        true,
	"splitH":        true,
	"splitV":        true,
	"focus":         true,
	"closeTab":      true,
	"closeWindow":   true,
	"windowNext":    true,
	"windowPrev":    true,
	"tabNext":       true,
	"tabPrev":       true,
	"paneUp":        true,
	"paneDown":      true,
	"paneLeft":      true,
	"paneRight":     true,
	"openEditorTab": true,
	"renameTab":     true,
	"renameWindow":  true,
	"detachTab":     true,
	"restoreTool":   true,
}

// AllowedAction reports whether the action is accepted by the hub.
func (h *CommandHub) AllowedAction(a string) bool { return AllowedCmdActions[a] }
